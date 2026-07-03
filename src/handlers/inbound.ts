import type { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda'
import type { InboundEmailAttachment, InboundWebhookPayload } from 'inboundemail'
import { type AlertEmailInfo, sendFailureAlert, sendOpsAlert } from './lib/alert'
import { downloadDriveImage, extractDriveFileIds } from './lib/drive'
import { type Event, normalizeEvent } from './lib/events'
import { extractEvents } from './lib/openai'
import { uploadToS3 } from './lib/s3'
import { addEventsToSpreadsheet } from './lib/sheets'

const INBOUND_API_KEY = process.env.INBOUND_API_KEY

// Webhook payload → transport-neutral alert shape; fields can be null on
// minimal payloads (provider-side parse failure)
const toAlertInfo = (email: InboundWebhookPayload['email']): AlertEmailInfo => ({
  from: email.parsedData?.from?.text ?? email.from?.text ?? 'unknown',
  subject: email.subject || '(no subject)',
  receivedAt: email.receivedAt ?? '',
  textBody: email.parsedData?.textBody ?? '',
  htmlBody: email.parsedData?.htmlBody ?? null
})

async function downloadAttachment(attachment: InboundEmailAttachment): Promise<Buffer> {
  const response = await fetch(attachment.downloadUrl, {
    headers: { Authorization: `Bearer ${INBOUND_API_KEY}` },
    // Bounded: a hung fetch would otherwise burn the whole 29s API Gateway budget
    signal: AbortSignal.timeout(8000)
  })

  if (!response.ok) {
    throw new Error(`Failed to download attachment ${attachment.filename}: ${response.status} ${response.statusText}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

// Upload one image to S3 (fire-and-forget) and extract its events in parallel,
// pushing any normalized events onto the shared accumulator. Shared with the
// SES handler (ses-inbound.ts).
export async function processImage(content: Buffer, filename: string, contentType: string, allEvents: Array<{ events: Event[]; s3Url?: string }>): Promise<void> {
  const [s3Url, events] = await Promise.all([
    uploadToS3(content, filename, contentType)
      .then(url => {
        console.log(`Successfully uploaded: ${filename} to S3: ${url}`)
        return url
      })
      .catch(s3Error => {
        console.error(`Failed to upload ${filename}:`, s3Error)
        return undefined
      }),
    extractEvents(content, contentType)
  ])

  console.log(`Extracted events from ${filename}:`, events)

  if (events.events?.length > 0) {
    allEvents.push({ events: events.events.map(normalizeEvent), s3Url })
  }
}

export const parseInboundEmail: APIGatewayProxyHandler = async (event): Promise<APIGatewayProxyResult> => {
  console.log('Received event:', JSON.stringify({ ...event, body: event.body ? 'body present' : 'no body' }, null, 2))
  const allEvents: Array<{ events: Event[]; s3Url?: string }> = []

  try {
    if (!event.body) {
      console.error('No body provided')
      return { statusCode: 400, body: JSON.stringify({ error: 'No body provided' }) }
    }

    const payload: InboundWebhookPayload = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body)
    const { email } = payload

    console.log(`Received email from ${email.from?.text ?? 'unknown'} - subject: ${email.subject}`)

    // inbound.new sends a minimal payload (id "inbnd_minimal_…") when its own
    // ingestion of the email failed — reproduced July 3 2026 with a 31MB MIME
    // message (their parser fails between ~28MB and SES's 40MB cap). The stub's
    // parsedData can be PRESENT but empty (only `from` null), so detect via the
    // explicit id prefix, not field nullness. The content never reached
    // inbound.new, so there is nothing to process or retry; alert a human and
    // ack with 200 so it isn't redelivered.
    if (email.id?.startsWith('inbnd_minimal_') || !email.parsedData) {
      console.error(`Minimal/failed payload received (id: ${email.id}) — inbound.new could not parse the original email`)
      try {
        await sendFailureAlert(toAlertInfo(email), [
          `inbound.new failed to ingest this email entirely (id: ${email.id}) — likely too large. The flyers were never received; ask the sender to re-send with fewer/smaller images.`
        ])
        console.log('Sent failure alert for unparseable email')
      } catch (alertError) {
        // No processing happened, so a 500 is free: inbound.new redelivers and
        // we get another chance to alert instead of dropping the email silently.
        console.error('Failed to send failure alert:', alertError)
        return { statusCode: 500, body: JSON.stringify({ error: 'Provider parse failure and alert failed' }) }
      }
      return { statusCode: 200, body: JSON.stringify({ message: 'Email could not be parsed by provider' }) }
    }

    // Null-safe: inbound.new has shipped payload variants the SDK types don't model
    const attachments = (email.parsedData.attachments ?? []).filter(a => a.contentType?.startsWith('image/'))
    const driveFileIds = extractDriveFileIds(email.parsedData.htmlBody, email.parsedData.textBody)

    if (!attachments.length && !driveFileIds.length) {
      console.log('No image attachments or Drive links found')
      return { statusCode: 200, body: JSON.stringify({ message: 'No attachments found' }) }
    }

    console.log(`Found ${attachments.length} image attachments and ${driveFileIds.length} Drive image links`)

    // Images we could not fetch/process, collected so they can be alerted on
    // rather than silently dropped (inbound.new does not retry a 200 response).
    const failures: string[] = []

    await Promise.all([
      ...attachments.map(async attachment => {
        try {
          console.log(`Downloading attachment: ${attachment.filename} (${attachment.size} bytes)`)
          const content = await downloadAttachment(attachment)
          await processImage(content, attachment.filename, attachment.contentType, allEvents)
        } catch (error) {
          console.error(`Failed to process attachment ${attachment.filename}:`, error)
          failures.push(`Attachment ${attachment.filename} — ${error instanceof Error ? error.message : 'unknown error'}`)
        }
      }),
      ...driveFileIds.map(async fileId => {
        try {
          console.log(`Downloading Drive image: ${fileId}`)
          const content = await downloadDriveImage(fileId)
          await processImage(content, `drive_${fileId}.png`, 'image/png', allEvents)
        } catch (error) {
          console.error(`Failed to process Drive image ${fileId}:`, error)
          failures.push(`Google Drive link https://drive.google.com/file/d/${fileId} — ${error instanceof Error ? error.message : 'unknown error'}`)
        }
      })
    ])

    if (failures.length > 0) {
      try {
        await sendFailureAlert(toAlertInfo(email), failures)
        console.log(`Sent failure alert for ${failures.length} unprocessed image(s)`)
      } catch (alertError) {
        console.error('Failed to send failure alert:', alertError)
      }
    }

    if (allEvents.length > 0) {
      await addEventsToSpreadsheet(allEvents)
    }

    console.log(`Successfully processed ${allEvents.length} attachments with events`, { events: allEvents })
    return { statusCode: 200, body: JSON.stringify({ message: 'Email parsed successfully' }) }
  } catch (error) {
    console.error('Error parsing inbound email:', error)

    // Report, don't just contain: a catch that only logs is silence in a
    // system nobody watches. Failure to alert must not mask the original error.
    try {
      await sendOpsAlert(error, 'parseInboundEmail top-level catch')
    } catch (alertError) {
      console.error('Failed to send ops alert:', alertError)
    }

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to parse inbound email',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  }
}
