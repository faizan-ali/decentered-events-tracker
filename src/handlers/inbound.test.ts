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

vi.mock('./lib/alert', () => ({
  sendFailureAlert: vi.fn(),
  sendOpsAlert: vi.fn()
}))

import { sendFailureAlert, sendOpsAlert } from './lib/alert'
import { extractEvents } from './lib/openai'
import { uploadToS3 } from './lib/s3'
import { addEventsToSpreadsheet } from './lib/sheets'

const mockExtractEvents = extractEvents as ReturnType<typeof vi.fn>
const mockUploadToS3 = uploadToS3 as ReturnType<typeof vi.fn>
const mockAddEventsToSpreadsheet = addEventsToSpreadsheet as ReturnType<typeof vi.fn>
const mockSendFailureAlert = sendFailureAlert as ReturnType<typeof vi.fn>
const mockSendOpsAlert = sendOpsAlert as ReturnType<typeof vi.fn>

// Mock global fetch for attachment downloads
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// A minimal valid PNG (signature + padding) so downloadDriveImage's image check passes
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const imageResponse = () => ({
  ok: true,
  headers: { get: () => 'image/png' },
  arrayBuffer: () => Promise.resolve(PNG_BYTES.buffer)
})

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

function makePayload(overrides: Partial<{ attachments: any[]; htmlBody: string | null; textBody: string | null }> = {}): InboundWebhookPayload {
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
        textBody: overrides.textBody ?? 'Check out this event',
        htmlBody: overrides.htmlBody ?? '<p>Check out this event</p>',
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
    mockSendFailureAlert.mockResolvedValue(undefined)
    mockSendOpsAlert.mockResolvedValue(undefined)
    mockFetch.mockResolvedValue(imageResponse())
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
        headers: { Authorization: `Bearer ${process.env.INBOUND_API_KEY}` },
        signal: expect.any(AbortSignal)
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

      expect(mockAddEventsToSpreadsheet).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ s3Url: 'https://bucket.s3.amazonaws.com/images/test.png' })]))
    })

    it('should not call addEventsToSpreadsheet when no events extracted', async () => {
      const payload = makePayload({ attachments: [sampleAttachment] })
      mockExtractEvents.mockResolvedValue({ events: [] })

      const event = createEvent(payload)
      await parseInboundEmail(event, mockContext, () => {})

      expect(mockAddEventsToSpreadsheet).not.toHaveBeenCalled()
    })
  })

  describe('drive-linked flyers', () => {
    it('extracts events from Drive links in the body when there are no attachments', async () => {
      const payload = makePayload({
        attachments: [],
        htmlBody: '<a href="https://drive.google.com/file/d/FILE_A">a</a><a href="https://drive.google.com/file/d/FILE_B">b</a>'
      })
      mockExtractEvents.mockResolvedValue(sampleEvents)

      const event = createEvent(payload)
      const result = await parseInboundEmail(event, mockContext, () => {})

      expect(result?.statusCode).toBe(200)
      expect(mockFetch).toHaveBeenCalledWith('https://drive.google.com/thumbnail?id=FILE_A&sz=w2000', { signal: expect.any(AbortSignal) })
      expect(mockFetch).toHaveBeenCalledWith('https://drive.google.com/thumbnail?id=FILE_B&sz=w2000', { signal: expect.any(AbortSignal) })
      expect(mockExtractEvents).toHaveBeenCalledTimes(2)
      expect(mockAddEventsToSpreadsheet).toHaveBeenCalled()
    })

    it('processes both attachments and Drive links in one email', async () => {
      const payload = makePayload({
        attachments: [sampleAttachment],
        textBody: 'flyer: https://drive.google.com/file/d/FILE_C'
      })
      mockExtractEvents.mockResolvedValue(sampleEvents)

      const event = createEvent(payload)
      const result = await parseInboundEmail(event, mockContext, () => {})

      expect(result?.statusCode).toBe(200)
      expect(mockExtractEvents).toHaveBeenCalledTimes(2)
    })

    it('continues processing if one Drive image download fails', async () => {
      const payload = makePayload({
        attachments: [],
        htmlBody: 'https://drive.google.com/file/d/FILE_A https://drive.google.com/file/d/FILE_B'
      })
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403, statusText: 'Forbidden' }).mockResolvedValueOnce(imageResponse())
      mockExtractEvents.mockResolvedValue(sampleEvents)

      const event = createEvent(payload)
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const result = await parseInboundEmail(event, mockContext, () => {})

      expect(result?.statusCode).toBe(200)
      expect(mockExtractEvents).toHaveBeenCalledTimes(1)
      expect(mockSendFailureAlert).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([expect.stringContaining('https://drive.google.com/file/d/FILE_A')]))

      consoleSpy.mockRestore()
    })

    it('returns 500 when a minimal payload alert fails, so inbound.new redelivers', async () => {
      const payload = makePayload()
      payload.email = { ...payload.email, id: 'inbnd_minimal_abc123', from: null, parsedData: null } as any
      mockSendFailureAlert.mockRejectedValue(new Error('send failed'))

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const result = await parseInboundEmail(createEvent(payload), mockContext, () => {})

      expect(result?.statusCode).toBe(500)
      consoleSpy.mockRestore()
    })

    it('handles null attachments and missing contentType without crashing', async () => {
      const payload = makePayload()
      payload.email.parsedData = { ...payload.email.parsedData, attachments: null } as any
      const nullAttachments = await parseInboundEmail(createEvent(payload), mockContext, () => {})
      expect(nullAttachments?.statusCode).toBe(200)

      const noContentType = makePayload({ attachments: [{ ...sampleAttachment, contentType: undefined }] })
      const result = await parseInboundEmail(createEvent(noContentType), mockContext, () => {})
      expect(result?.statusCode).toBe(200)
    })

    it('detects a minimal payload by id prefix even when parsedData is present but empty', async () => {
      // Reproduced 2026-07-03: the stub had parsedData with empty attachments,
      // only `from` was null — field-nullness checks alone miss it
      const payload = makePayload()
      payload.email = { ...payload.email, id: 'inbnd_minimal_705794533d1028e8', from: null } as any

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const result = await parseInboundEmail(createEvent(payload), mockContext, () => {})

      expect(result?.statusCode).toBe(200)
      expect(mockSendFailureAlert).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([expect.stringContaining('inbnd_minimal_705794533d1028e8')]))
      expect(mockAddEventsToSpreadsheet).not.toHaveBeenCalled()

      consoleSpy.mockRestore()
    })

    it('alerts and returns 200 on a minimal payload (provider-side parse failure)', async () => {
      const payload = makePayload()
      // inbound.new minimal payload: null from, no parsedData
      payload.email = { ...payload.email, id: 'inbnd_minimal_abc123', from: null, parsedData: null } as any

      const event = createEvent(payload)
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const result = await parseInboundEmail(event, mockContext, () => {})

      expect(result?.statusCode).toBe(200)
      expect(mockSendFailureAlert).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([expect.stringContaining('inbnd_minimal_abc123')]))
      expect(mockFetch).not.toHaveBeenCalled()
      expect(mockAddEventsToSpreadsheet).not.toHaveBeenCalled()

      consoleSpy.mockRestore()
    })

    it('does not alert when all images process successfully', async () => {
      const payload = makePayload({ attachments: [sampleAttachment] })
      mockExtractEvents.mockResolvedValue(sampleEvents)

      const event = createEvent(payload)
      await parseInboundEmail(event, mockContext, () => {})

      expect(mockSendFailureAlert).not.toHaveBeenCalled()
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

    it('sends an ops alert from the top-level catch on unanticipated errors', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const result = await parseInboundEmail(createEvent('{}', { body: '{}' }), mockContext, () => {})

      expect(result?.statusCode).toBe(500)
      expect(mockSendOpsAlert).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('top-level catch'))

      consoleSpy.mockRestore()
    })

    it('still returns 500 when the ops alert itself fails', async () => {
      mockSendOpsAlert.mockRejectedValue(new Error('alert send failed'))
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const result = await parseInboundEmail(createEvent('{}', { body: '{}' }), mockContext, () => {})

      expect(result?.statusCode).toBe(500)

      consoleSpy.mockRestore()
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
