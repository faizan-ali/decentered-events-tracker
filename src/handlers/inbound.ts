import type { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda'
import type { InboundEmailAttachment, InboundWebhookPayload } from 'inboundemail'
import { type Event, normalizeEvent } from './lib/events'
import { extractEvents } from './lib/openai'
import { uploadToS3 } from './lib/s3'
import { addEventsToSpreadsheet } from './lib/sheets'

const INBOUND_API_KEY = process.env.INBOUND_API_KEY

async function downloadAttachment(attachment: InboundEmailAttachment): Promise<Buffer> {
  const response = await fetch(attachment.downloadUrl, {
    headers: { Authorization: `Bearer ${INBOUND_API_KEY}` }
  })

  if (!response.ok) {
    throw new Error(`Failed to download attachment ${attachment.filename}: ${response.status} ${response.statusText}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
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

    console.log(`Received email from ${email.from.text} - subject: ${email.subject}`)

    const attachments = email.parsedData.attachments.filter(a => a.contentType.startsWith('image/'))

    if (!attachments.length) {
      console.log('No image attachments found')
      return { statusCode: 200, body: JSON.stringify({ message: 'No attachments found' }) }
    }

    console.log(`Found ${attachments.length} image attachments`)

    await Promise.all(
      attachments.map(async attachment => {
        try {
          console.log(`Downloading attachment: ${attachment.filename} (${attachment.size} bytes)`)

          const content = await downloadAttachment(attachment)

          const [s3Url, events] = await Promise.all([
            uploadToS3(content, attachment.filename, attachment.contentType)
              .then(url => {
                console.log(`Successfully uploaded: ${attachment.filename} to S3: ${url}`)
                return url
              })
              .catch(s3Error => {
                console.error(`Failed to upload attachment ${attachment.filename}:`, s3Error)
                return undefined
              }),
            extractEvents(content, attachment.contentType)
          ])

          console.log(`Extracted events from attachment ${attachment.filename}:`, events)

          if (events.events?.length > 0) {
            allEvents.push({ events: events.events.map(normalizeEvent), s3Url })
          }
        } catch (error) {
          console.error(`Failed to process attachment ${attachment.filename}:`, error)
        }
      })
    )

    if (allEvents.length > 0) {
      await addEventsToSpreadsheet(allEvents)
    }

    console.log(`Successfully processed ${allEvents.length} attachments with events`, { events: allEvents })
    return { statusCode: 200, body: JSON.stringify({ message: 'Email parsed successfully' }) }
  } catch (error) {
    console.error('Error parsing inbound email:', error)

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to parse inbound email',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  }
}
