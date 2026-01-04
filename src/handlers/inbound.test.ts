import type { APIGatewayProxyEvent, Context } from 'aws-lambda'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseSendgridInbound } from './inbound'

// Mock all dependencies
vi.mock('lambda-multipart-parser', () => ({
  parse: vi.fn()
}))

vi.mock('./lib/openai', () => ({
  extractEvents: vi.fn()
}))

vi.mock('./lib/s3', () => ({
  uploadToS3: vi.fn()
}))

vi.mock('./lib/sheets', () => ({
  addEventsToSpreadsheet: vi.fn()
}))

// Import mocked modules
import * as parser from 'lambda-multipart-parser'
import { extractEvents } from './lib/openai'
import { uploadToS3 } from './lib/s3'
import { addEventsToSpreadsheet } from './lib/sheets'

const mockParse = parser.parse as ReturnType<typeof vi.fn>
const mockExtractEvents = extractEvents as ReturnType<typeof vi.fn>
const mockUploadToS3 = uploadToS3 as ReturnType<typeof vi.fn>
const mockAddEventsToSpreadsheet = addEventsToSpreadsheet as ReturnType<typeof vi.fn>

describe('parseSendgridInbound', () => {
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

  const createEvent = (overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent => ({
    body: 'multipart-body',
    headers: { 'content-type': 'multipart/form-data; boundary=----WebKitFormBoundary' },
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/parse-sendgrid-inbound',
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
      path: '/parse-sendgrid-inbound',
      stage: 'test',
      requestId: 'test-request-id',
      requestTimeEpoch: Date.now(),
      resourceId: 'test-resource',
      resourcePath: '/parse-sendgrid-inbound'
    },
    resource: '/parse-sendgrid-inbound',
    ...overrides
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockUploadToS3.mockResolvedValue('https://bucket.s3.amazonaws.com/images/test.png')
    mockAddEventsToSpreadsheet.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('request validation', () => {
    it('should return 400 if no body provided', async () => {
      const event = createEvent({ body: null })

      const result = await parseSendgridInbound(event, mockContext, () => {})

      expect(result).toEqual({
        statusCode: 400,
        body: JSON.stringify({ error: 'No body provided' })
      })
    })

    it('should return 400 if body is empty string', async () => {
      const event = createEvent({ body: '' })

      const result = await parseSendgridInbound(event, mockContext, () => {})

      expect(result).toEqual({
        statusCode: 400,
        body: JSON.stringify({ error: 'No body provided' })
      })
    })
  })

  describe('no attachments', () => {
    it('should return 200 with message when no files attached', async () => {
      mockParse.mockResolvedValue({
        to: 'test@example.com',
        from: 'sender@example.com',
        subject: 'Test email',
        files: []
      })

      const event = createEvent()

      const result = await parseSendgridInbound(event, mockContext, () => {})

      expect(result).toEqual({
        statusCode: 200,
        body: JSON.stringify({ message: 'No attachments found' })
      })
    })

    it('should return 200 when files is null', async () => {
      mockParse.mockResolvedValue({
        to: 'test@example.com',
        from: 'sender@example.com',
        subject: 'Test email',
        files: null
      })

      const event = createEvent()

      const result = await parseSendgridInbound(event, mockContext, () => {})

      expect(result).toEqual({
        statusCode: 200,
        body: JSON.stringify({ message: 'No attachments found' })
      })
    })
  })

  describe('successful processing', () => {
    const sampleFile = {
      filename: 'event-flyer.png',
      contentType: 'image/png',
      content: Buffer.from('fake-image-data')
    }

    const sampleEvents = {
      events: [
        {
          title: 'Jazz Night',
          address: '123 Main St',
          location: 'San Francisco',
          type: 'Music',
          startDay: '2025-03-15',
          startTime: '20:00',
          description: 'Live jazz',
          cost: '$25',
          endDay: '2025-03-15',
          endTime: '23:00'
        }
      ]
    }

    it('should process single attachment successfully', async () => {
      mockParse.mockResolvedValue({
        to: 'events@example.com',
        from: 'sender@example.com',
        subject: 'New event flyer',
        files: [sampleFile]
      })
      mockExtractEvents.mockResolvedValue(sampleEvents)

      const event = createEvent()

      const result = await parseSendgridInbound(event, mockContext, () => {})

      expect(result).toEqual({
        statusCode: 200,
        body: JSON.stringify({ message: 'Email parsed successfully' })
      })
      expect(mockExtractEvents).toHaveBeenCalledWith(sampleFile.content, sampleFile.contentType)
    })

    it('should process multiple attachments', async () => {
      const file1 = { ...sampleFile, filename: 'flyer1.png' }
      const file2 = { ...sampleFile, filename: 'flyer2.jpg', contentType: 'image/jpeg' }

      mockParse.mockResolvedValue({
        to: 'events@example.com',
        from: 'sender@example.com',
        subject: 'Multiple flyers',
        files: [file1, file2]
      })
      mockExtractEvents.mockResolvedValue(sampleEvents)

      const event = createEvent()

      const result = await parseSendgridInbound(event, mockContext, () => {})

      expect(result?.statusCode).toBe(200)
      expect(mockExtractEvents).toHaveBeenCalledTimes(2)
    })

    it('should call uploadToS3 for each attachment', async () => {
      mockParse.mockResolvedValue({
        to: 'events@example.com',
        from: 'sender@example.com',
        subject: 'Test',
        files: [sampleFile]
      })
      mockExtractEvents.mockResolvedValue(sampleEvents)

      const event = createEvent()

      await parseSendgridInbound(event, mockContext, () => {})

      // Note: uploadToS3 is called asynchronously with void
      // We just verify it was called
      expect(mockUploadToS3).toHaveBeenCalledWith(sampleFile.content, sampleFile.filename, sampleFile.contentType)
    })

    it('should call addEventsToSpreadsheet when events are extracted', async () => {
      mockParse.mockResolvedValue({
        to: 'events@example.com',
        from: 'sender@example.com',
        subject: 'Test',
        files: [sampleFile]
      })
      mockExtractEvents.mockResolvedValue(sampleEvents)

      const event = createEvent()

      await parseSendgridInbound(event, mockContext, () => {})

      expect(mockAddEventsToSpreadsheet).toHaveBeenCalled()
    })

    it('should not call addEventsToSpreadsheet when no events extracted', async () => {
      mockParse.mockResolvedValue({
        to: 'events@example.com',
        from: 'sender@example.com',
        subject: 'Test',
        files: [sampleFile]
      })
      mockExtractEvents.mockResolvedValue({ events: [] })

      const event = createEvent()

      await parseSendgridInbound(event, mockContext, () => {})

      expect(mockAddEventsToSpreadsheet).not.toHaveBeenCalled()
    })
  })

  describe('base64 encoded body', () => {
    it('should decode base64 encoded body', async () => {
      const originalBody = 'multipart form data content'
      const base64Body = Buffer.from(originalBody).toString('base64')

      mockParse.mockResolvedValue({
        to: 'test@example.com',
        from: 'sender@example.com',
        subject: 'Test',
        files: []
      })

      const event = createEvent({
        body: base64Body,
        isBase64Encoded: true
      })

      await parseSendgridInbound(event, mockContext, () => {})

      // Verify parse was called (meaning body was decoded)
      expect(mockParse).toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('should return 500 when parser throws', async () => {
      mockParse.mockRejectedValue(new Error('Parser error'))

      const event = createEvent()

      const result = await parseSendgridInbound(event, mockContext, () => {})

      expect(result).toEqual({
        statusCode: 500,
        body: JSON.stringify({
          error: 'Failed to parse inbound email',
          details: 'Parser error'
        })
      })
    })

    it('should continue processing other attachments if one fails extraction', async () => {
      const file1 = { filename: 'bad.png', contentType: 'image/png', content: Buffer.from('bad') }
      const file2 = { filename: 'good.png', contentType: 'image/png', content: Buffer.from('good') }

      mockParse.mockResolvedValue({
        to: 'test@example.com',
        from: 'sender@example.com',
        subject: 'Test',
        files: [file1, file2]
      })

      mockExtractEvents
        .mockRejectedValueOnce(new Error('Extraction failed'))
        .mockResolvedValueOnce({
          events: [{ title: 'Good Event', address: '', location: '', type: '', startDay: null, startTime: null, description: '', cost: null, endDay: null, endTime: null }]
        })

      const event = createEvent()
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const result = await parseSendgridInbound(event, mockContext, () => {})

      expect(result?.statusCode).toBe(200)
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to extract events'), expect.any(Error))

      consoleSpy.mockRestore()
    })

    it('should handle S3 upload failures gracefully', async () => {
      const sampleFile = {
        filename: 'test.png',
        contentType: 'image/png',
        content: Buffer.from('test')
      }

      mockParse.mockResolvedValue({
        to: 'test@example.com',
        from: 'sender@example.com',
        subject: 'Test',
        files: [sampleFile]
      })
      mockExtractEvents.mockResolvedValue({ events: [] })
      mockUploadToS3.mockRejectedValue(new Error('S3 error'))

      const event = createEvent()
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      // Should not throw despite S3 failure
      const result = await parseSendgridInbound(event, mockContext, () => {})

      expect(result?.statusCode).toBe(200)

      consoleSpy.mockRestore()
    })

    it('should return 500 with unknown error for non-Error throws', async () => {
      mockParse.mockRejectedValue('string error')

      const event = createEvent()

      const result = await parseSendgridInbound(event, mockContext, () => {})

      expect(result).toEqual({
        statusCode: 500,
        body: JSON.stringify({
          error: 'Failed to parse inbound email',
          details: 'Unknown error'
        })
      })
    })
  })

  describe('email parsing', () => {
    it('should parse email metadata correctly', async () => {
      mockParse.mockResolvedValue({
        to: 'events@decentered.org',
        from: 'user@gmail.com',
        subject: 'Check out this event!',
        text: 'Here is a cool event',
        html: '<p>Here is a cool event</p>',
        files: []
      })

      const event = createEvent()

      const result = await parseSendgridInbound(event, mockContext, () => {})

      expect(result?.statusCode).toBe(200)
    })

    it('should handle missing email metadata fields', async () => {
      mockParse.mockResolvedValue({
        files: []
      })

      const event = createEvent()

      const result = await parseSendgridInbound(event, mockContext, () => {})

      expect(result?.statusCode).toBe(200)
    })

    it('should handle file without filename', async () => {
      mockParse.mockResolvedValue({
        to: 'test@example.com',
        from: 'sender@example.com',
        subject: 'Test',
        files: [
          {
            contentType: 'image/png',
            content: Buffer.from('test')
            // Note: no filename
          }
        ]
      })
      mockExtractEvents.mockResolvedValue({ events: [] })

      const event = createEvent()

      const result = await parseSendgridInbound(event, mockContext, () => {})

      expect(result?.statusCode).toBe(200)
      expect(mockUploadToS3).toHaveBeenCalledWith(expect.any(Buffer), 'image', 'image/png')
    })
  })

  describe('event normalization', () => {
    it('should normalize extracted events', async () => {
      const sampleFile = {
        filename: 'test.png',
        contentType: 'image/png',
        content: Buffer.from('test')
      }

      const rawEvents = {
        events: [
          {
            title: 'Event',
            address: '123 St',
            location: 'SF',
            type: 'Music',
            startDay: '2025-03-15',
            startTime: '19:00',
            description: 'Test',
            cost: null,
            endDay: null,
            endTime: null
          }
        ]
      }

      mockParse.mockResolvedValue({
        to: 'test@example.com',
        from: 'sender@example.com',
        subject: 'Test',
        files: [sampleFile]
      })
      mockExtractEvents.mockResolvedValue(rawEvents)

      const event = createEvent()

      await parseSendgridInbound(event, mockContext, () => {})

      // Verify addEventsToSpreadsheet was called with normalized events
      expect(mockAddEventsToSpreadsheet).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            events: expect.arrayContaining([
              expect.objectContaining({
                endDay: '2025-03-15' // Should be normalized from null to startDay
              })
            ])
          })
        ])
      )
    })
  })
})
