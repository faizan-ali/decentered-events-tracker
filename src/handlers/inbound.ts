import type { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda'
import * as parser from 'lambda-multipart-parser'
import { type Event, normalizeEvent } from './lib/events'
import { extractEvents } from './lib/openai'
import { uploadToS3 } from './lib/s3'
import { addEventsToSpreadsheet } from './lib/sheets'

interface ParsedAttachment {
  filename: string
  contentType: string
  content: Buffer
  size: number
  s3Key?: string
  s3Url?: string
}

interface ParsedEmail {
  to: string[]
  from: string
  subject: string
  text?: string
  html?: string
  attachments: ParsedAttachment[]
}

export const parseSendgridInbound: APIGatewayProxyHandler = async (event): Promise<APIGatewayProxyResult> => {
  console.log('Received event:', JSON.stringify({ ...event, body: event.body ? 'body present' : 'no body' }, null, 2))
  const allEvents: Array<{ events: Event[]; s3Url?: string }> = []

  try {
    if (!event.body) {
      console.error('No body provided')
      return { statusCode: 400, body: JSON.stringify({ error: 'No body provided' }) }
    }

    // Handle base64-encoded body from AWS API Gateway
    let eventToProcess = event

    if (event.isBase64Encoded && event.body) {
      console.log('Detected base64-encoded body, decoding...')
      console.log(`Original body size (base64): ${event.body.length} characters`)
      const decodedBody = Buffer.from(event.body, 'base64').toString('binary')
      console.log(`Decoded body size: ${decodedBody.length} bytes`)
      eventToProcess = {
        ...event,
        body: decodedBody,
        isBase64Encoded: false
      }
    }

    // Parse the multipart form data
    const parsedData = await parser.parse(eventToProcess)

    // Extract basic email information from the parsed form data
    const emailData: ParsedEmail = {
      to: parsedData.to ? [parsedData.to] : [],
      from: parsedData.from || '',
      subject: parsedData.subject || '',
      text: parsedData.text,
      html: parsedData.html,
      attachments: [],
    }

    if (!parsedData.files?.length) {
      console.log('No attachments found')
      return { statusCode: 200, body: JSON.stringify({ message: 'No attachments found' }) }
    }

    console.log(`Found ${parsedData.files.length} attachments`)

    const processedAttachments = await Promise.all(
      parsedData.files.map(async file => {
        const parsedAttachment: ParsedAttachment = {
          filename: file.filename || 'image',
          contentType: file.contentType,
          content: file.content,
          size: file.content.length
        }

        console.log(`Uploading attachment: ${parsedAttachment.filename} (${parsedAttachment.size} bytes)`)

        void uploadToS3(parsedAttachment.content, parsedAttachment.filename, parsedAttachment.contentType)
          .then(s3Url => {
            parsedAttachment.s3Url = s3Url
            console.log(`Successfully uploaded: ${parsedAttachment.filename} to S3 key: ${s3Url}`)
          })
          .catch(s3Error => {
            console.error(`Failed to upload attachment ${parsedAttachment.filename}:`, s3Error)
          })

        try {
          const events = await extractEvents(parsedAttachment.content, parsedAttachment.contentType)
          console.log(`Extracted events from attachment ${parsedAttachment.filename}:`, events)

          if (events.events?.length > 0) {
            allEvents.push({ events: events.events.map(normalizeEvent), s3Url: parsedAttachment.s3Url })
          }
        } catch (error) {
          console.error(`Failed to extract events from attachment ${parsedAttachment.filename}:`, error)
        }

        return parsedAttachment
      })
    )

    emailData.attachments.push(...processedAttachments)

    // Add all collected events to the spreadsheet in one batch
    if (allEvents.length > 0) {
      console.log(`Adding ${allEvents.length} event groups to spreadsheet`)
      await addEventsToSpreadsheet(allEvents)
    }

    console.log('Parsed email summary:', { parsedData, emailData })
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
