import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { SESHandler } from 'aws-lambda'
import { simpleParser } from 'mailparser'
import { processImage } from './inbound'
import { type AlertEmailInfo, sendFailureAlert, sendOpsAlert } from './lib/alert'
import { downloadDriveImage, extractDriveFileIds } from './lib/drive'
import type { Event } from './lib/events'
import { addEventsToSpreadsheet } from './lib/sheets'

// SES-native ingestion path: MX (ses.proteus.tools) → SES receipt rule →
// raw MIME to S3 → this handler. Replaces inbound.new's parser, whose
// undocumented ~28MB ceiling silently ate large emails (reproduced July 2026).
// SES accepts up to 40MB — more than Gmail can physically send (~34MB encoded)
// — so the size failure class disappears entirely on this path.

const SES_INBOX_BUCKET = process.env.SES_INBOX_BUCKET
const SES_INBOX_PREFIX = process.env.SES_INBOX_PREFIX ?? 'inbox/'

const inboxClient = new S3Client({ region: process.env.SES_INBOX_REGION ?? 'us-west-2' })

async function getRawEmail(messageId: string): Promise<Buffer> {
  const result = await inboxClient.send(new GetObjectCommand({ Bucket: SES_INBOX_BUCKET, Key: `${SES_INBOX_PREFIX}${messageId}` }))
  if (!result.Body) {
    throw new Error(`Empty S3 body for message ${messageId}`)
  }
  return Buffer.from(await result.Body.transformToByteArray())
}

export const parseSesEmail: SESHandler = async event => {
  for (const record of event.Records) {
    const { mail } = record.ses

    try {
      await processMessage(mail.messageId, mail.timestamp)
    } catch (error) {
      console.error(`Error processing SES message ${mail.messageId}:`, error)
      // Report, don't just contain (see inbound.ts top-level catch)
      try {
        await sendOpsAlert(error, `parseSesEmail messageId=${mail.messageId}`)
      } catch (alertError) {
        console.error('Failed to send ops alert:', alertError)
      }
    }
  }
}

async function processMessage(messageId: string, receivedAt: string): Promise<void> {
  const raw = await getRawEmail(messageId)
  console.log(`Fetched raw email ${messageId}: ${raw.length} bytes`)

  const parsed = await simpleParser(raw)
  const htmlBody = typeof parsed.html === 'string' ? parsed.html : null
  const textBody = parsed.text ?? ''

  const alertInfo: AlertEmailInfo = {
    from: parsed.from?.text ?? 'unknown',
    subject: parsed.subject || '(no subject)',
    receivedAt,
    textBody,
    htmlBody
  }

  console.log(`Received email from ${alertInfo.from} - subject: ${parsed.subject}`)

  const images = parsed.attachments.filter(a => a.contentType?.startsWith('image/'))
  const driveFileIds = extractDriveFileIds(htmlBody, textBody)

  if (!images.length && !driveFileIds.length) {
    console.log('No image attachments or Drive links found')
    return
  }

  console.log(`Found ${images.length} image attachments and ${driveFileIds.length} Drive image links`)

  const allEvents: Array<{ events: Event[]; s3Url?: string }> = []
  const failures: string[] = []

  await Promise.all([
    ...images.map(async (attachment, i) => {
      const filename = attachment.filename ?? `attachment_${i}.${attachment.contentType.split('/')[1] ?? 'bin'}`
      try {
        console.log(`Processing attachment: ${filename} (${attachment.content.length} bytes)`)
        await processImage(attachment.content, filename, attachment.contentType, allEvents)
      } catch (error) {
        console.error(`Failed to process attachment ${filename}:`, error)
        failures.push(`Attachment ${filename} — ${error instanceof Error ? error.message : 'unknown error'}`)
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
      await sendFailureAlert(alertInfo, failures)
      console.log(`Sent failure alert for ${failures.length} unprocessed image(s)`)
    } catch (alertError) {
      console.error('Failed to send failure alert:', alertError)
    }
  }

  if (allEvents.length > 0) {
    await addEventsToSpreadsheet(allEvents)
  }

  console.log(`Successfully processed ${allEvents.length} attachments with events`)
}
