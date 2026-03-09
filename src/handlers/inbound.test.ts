import type { APIGatewayProxyEvent, Context } from 'aws-lambda'
import type { InboundWebhookPayload } from 'inboundemail'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseInboundEmail } from './inbound'

vi.mock('./lib/openai', () => ({
  extractEvents: vi.fn()
}))

vi.mock('./lib/s3', () => ({
  uploadToS3: vi.fn()
}))

vi.mock('./lib/sheets', () => ({
  addEventsToSpreadsheet: vi.fn()
}))

import { extractEvents } from './lib/openai'
import { uploadToS3 } from './lib/s3'
import { addEventsToSpreadsheet } from './lib/sheets'

const mockExtractEvents = extractEvents as ReturnType<typeof vi.fn>
const mockUploadToS3 = uploadToS3 as ReturnType<typeof vi.fn>
const mockAddEventsToSpreadsheet = addEventsToSpreadsheet as ReturnType<typeof vi.fn>

// Mock global fetch for attachment downloads
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const mockContext: Context = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: 'test',
  functionVersion: '1',
  invokedFunctionArn: 'arn:aws:lambda:us-west-1:123456789:function:test',
  memoryLimitInMB: '128',
  awsRequestId: 'test-request-id',
  logGroupName: 'test-log-group',
  logStreamName: 'test-log-stream',
  getRemainingTimeInMillis: () => 5000,
  done: () => {},
  fail: () => {},
  succeed: () => {}
}

function makePayload(overrides: Partial<{ attachments: any[] }> = {}): InboundWebhookPayload {
  return {
    event: 'email.received',
    timestamp: '2026-03-08T10:00:00Z',
    email: {
      id: 'email_123',
      messageId: '<abc@example.com>',
      from: { text: 'sender@example.com', addresses: [{ address: 'sender@example.com', name: null }] },
      to: { text: 'events@decentered.org', addresses: [{ address: 'events@decentered.org', name: null }] },
      recipient: 'events@decentered.org',
      subject: 'New event flyer',
      receivedAt: '2026-03-08T10:00:00Z',
      parsedData: {
        messageId: '<abc@example.com>',
        date: new Date('2026-03-08T10:00:00Z'),
        subject: 'New event flyer',
        from: { text: 'sender@example.com', addresses: [{ address: 'sender@example.com', name: null }] },
        to: { text: 'events@decentered.org', addresses: [{ address: 'events@decentered.org', name: null }] },
        cc: null,
        bcc: null,
        replyTo: null,
        inReplyTo: undefined,
        references: undefined,
        textBody: 'Check out this event',
        htmlBody: '<p>Check out this event</p>',
        raw: '',
        attachments: overrides.attachments ?? [],
        headers: {},
        priority: undefined
      },
      cleanedContent: {
        html: null,
        text: null,
        hasHtml: false,
        hasText: false,
        attachments: [],
        headers: {}
      }
    },
    endpoint: {
      id: 'ep_123',
      name: 'Test Endpoint',
      type: 'webhook'
    }
  }
}

function createEvent(body: any, overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/parse-inbound-email',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {
      accountId: '123456789',
      apiId: 'test-api',
      authorizer: null,
      protocol: 'HTTP/1.1',
      httpMethod: 'POST',
      identity: {
        accessKey: null,
        accountId: null,
        apiKey: null,
        apiKeyId: null,
        caller: null,
        clientCert: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        sourceIp: '127.0.0.1',
        user: null,
        userAgent: 'test-agent',
        userArn: null
      },
      path: '/parse-inbound-email',
      stage: 'test',
      requestId: 'test-request-id',
      requestTimeEpoch: Date.now(),
      resourceId: 'test-resource',
      resourcePath: '/parse-inbound-email'
    },
    resource: '/parse-inbound-email',
    ...overrides
  }
}

const sampleAttachment = {
  filename: 'event-flyer.png',
  contentType: 'image/png',
  size: 1024,
  contentId: null,
  contentDisposition: 'attachment' as const,
  downloadUrl: 'https://inbound.new/api/e2/attachments/email_123/event-flyer.png'
}

const sampleEvents = {
  events: [
    {
      title: 'Jazz Night',
      address: '123 Main St',
      location: 'San Francisco',
      type: 'Music',
      startDay: '2026-03-15',
      startTime: '20:00',
      description: 'Live jazz',
      cost: '$25',
      endDay: '2026-03-15',
      endTime: '23:00'
    }
  ]
}

describe('parseInboundEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUploadToS3.mockResolvedValue('https://bucket.s3.amazonaws.com/images/test.png')
    mockAddEventsToSpreadsheet.mockResolvedValue(undefined)
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8))
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('request validation', () => {
    it('should return 400 if no body provided', async () => {
      const event = createEvent(null, { body: null })
      const result = await parseInboundEmail(event, mockContext, () => {})

      expect(result).toEqual({
        statusCode: 400,
        body: JSON.stringify({ error: 'No body provided' })
      })
    })

    it('should return 400 if body is empty string', async () => {
      const event = createEvent('', { body: '' })
      const result = await parseInboundEmail(event, mockContext, () => {})

      expect(result).toEqual({
        statusCode: 400,
        body: JSON.stringify({ error: 'No body provided' })
      })
    })
  })

  describe('no attachments', () => {
    it('should return 200 when no image attachments', async () => {
      const payload = makePayload({ attachments: [] })
      const event = createEvent(payload)
      const result = await parseInboundEmail(event, mockContext, () => {})

      expect(result).toEqual({
        statusCode: 200,
        body: JSON.stringify({ message: 'No attachments found' })
      })
    })

    it('should skip non-image attachments', async () => {
      const payload = makePayload({
        attachments: [
          {
            filename: 'doc.pdf',
            contentType: 'application/pdf',
            size: 1024,
            contentId: null,
            contentDisposition: 'attachment',
            downloadUrl: 'https://inbound.new/api/e2/attachments/email_123/doc.pdf'
          }
        ]
      })
      const event = createEvent(payload)
      const result = await parseInboundEmail(event, mockContext, () => {})

      expect(result).toEqual({
        statusCode: 200,
        body: JSON.stringify({ message: 'No attachments found' })
      })
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('successful processing', () => {
    it('should download attachment and extract events', async () => {
      const payload = makePayload({ attachments: [sampleAttachment] })
      mockExtractEvents.mockResolvedValue(sampleEvents)

      const event = createEvent(payload)
      const result = await parseInboundEmail(event, mockContext, () => {})

      expect(result).toEqual({
        statusCode: 200,
        body: JSON.stringify({ message: 'Email parsed successfully' })
      })
      expect(mockFetch).toHaveBeenCalledWith(sampleAttachment.downloadUrl, {
        headers: { Authorization: `Bearer ${process.env.INBOUND_API_KEY}` }
      })
      expect(mockExtractEvents).toHaveBeenCalledWith(expect.any(Buffer), 'image/png')
    })

    it('should process multiple image attachments', async () => {
      const attachment2 = { ...sampleAttachment, filename: 'flyer2.jpg', contentType: 'image/jpeg' }
      const payload = makePayload({ attachments: [sampleAttachment, attachment2] })
      mockExtractEvents.mockResolvedValue(sampleEvents)

      const event = createEvent(payload)
      const result = await parseInboundEmail(event, mockContext, () => {})

      expect(result?.statusCode).toBe(200)
      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(mockExtractEvents).toHaveBeenCalledTimes(2)
    })

    it('should call uploadToS3 for each attachment', async () => {
      const payload = makePayload({ attachments: [sampleAttachment] })
      mockExtractEvents.mockResolvedValue(sampleEvents)

      const event = createEvent(payload)
      await parseInboundEmail(event, mockContext, () => {})

      expect(mockUploadToS3).toHaveBeenCalledWith(expect.any(Buffer), 'event-flyer.png', 'image/png')
    })

    it('should call addEventsToSpreadsheet with s3Url when events are extracted', async () => {
      const payload = makePayload({ attachments: [sampleAttachment] })
      mockExtractEvents.mockResolvedValue(sampleEvents)

      const event = createEvent(payload)
      await parseInboundEmail(event, mockContext, () => {})

      expect(mockAddEventsToSpreadsheet).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ s3Url: 'https://bucket.s3.amazonaws.com/images/test.png' })
        ])
      )
    })

    it('should not call addEventsToSpreadsheet when no events extracted', async () => {
      const payload = makePayload({ attachments: [sampleAttachment] })
      mockExtractEvents.mockResolvedValue({ events: [] })

      const event = createEvent(payload)
      await parseInboundEmail(event, mockContext, () => {})

      expect(mockAddEventsToSpreadsheet).not.toHaveBeenCalled()
    })
  })

  describe('base64 encoded body', () => {
    it('should decode base64 encoded body', async () => {
      const payload = makePayload({ attachments: [sampleAttachment] })
      const base64Body = Buffer.from(JSON.stringify(payload)).toString('base64')
      mockExtractEvents.mockResolvedValue(sampleEvents)

      const event = createEvent(base64Body, { isBase64Encoded: true })
      const result = await parseInboundEmail(event, mockContext, () => {})

      expect(result?.statusCode).toBe(200)
      expect(mockFetch).toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('should return 500 when JSON parse fails', async () => {
      const event = createEvent('not json', { body: 'not json' })
      const result = await parseInboundEmail(event, mockContext, () => {})

      expect(result?.statusCode).toBe(500)
    })

    it('should continue processing if one attachment download fails', async () => {
      const attachment2 = { ...sampleAttachment, filename: 'flyer2.jpg', contentType: 'image/jpeg', downloadUrl: 'https://inbound.new/api/e2/attachments/email_123/flyer2.jpg' }
      const payload = makePayload({ attachments: [sampleAttachment, attachment2] })

      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' })
        .mockResolvedValueOnce({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) })

      mockExtractEvents.mockResolvedValue(sampleEvents)

      const event = createEvent(payload)
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const result = await parseInboundEmail(event, mockContext, () => {})

      expect(result?.statusCode).toBe(200)
      expect(mockExtractEvents).toHaveBeenCalledTimes(1)

      consoleSpy.mockRestore()
    })

    it('should handle S3 upload failures gracefully', async () => {
      const payload = makePayload({ attachments: [sampleAttachment] })
      mockExtractEvents.mockResolvedValue({ events: [] })
      mockUploadToS3.mockRejectedValue(new Error('S3 error'))

      const event = createEvent(payload)
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const result = await parseInboundEmail(event, mockContext, () => {})

      expect(result?.statusCode).toBe(200)

      consoleSpy.mockRestore()
    })

    it('should return 500 with unknown error for non-Error throws', async () => {
      const event = createEvent('{}', { body: '{}' })

      // This will fail because the payload structure is invalid
      const result = await parseInboundEmail(event, mockContext, () => {})

      expect(result?.statusCode).toBe(500)
    })
  })

  describe('event normalization', () => {
    it('should normalize extracted events (fill missing endDay from startDay)', async () => {
      const payload = makePayload({ attachments: [sampleAttachment] })
      const rawEvents = {
        events: [
          {
            title: 'Event',
            address: '123 St',
            location: 'SF',
            type: 'Music',
            startDay: '2026-03-15',
            startTime: '19:00',
            description: 'Test',
            cost: null,
            endDay: null,
            endTime: null
          }
        ]
      }
      mockExtractEvents.mockResolvedValue(rawEvents)

      const event = createEvent(payload)
      await parseInboundEmail(event, mockContext, () => {})

      expect(mockAddEventsToSpreadsheet).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            events: expect.arrayContaining([expect.objectContaining({ endDay: '2026-03-15' })])
          })
        ])
      )
    })
  })
})
