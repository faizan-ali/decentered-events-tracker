import type { SESEvent } from 'aws-lambda'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockS3Send } = vi.hoisted(() => ({ mockS3Send: vi.fn() }))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: mockS3Send })),
  GetObjectCommand: vi.fn().mockImplementation(input => ({ input })),
  PutObjectCommand: vi.fn().mockImplementation(input => ({ input }))
}))

vi.mock('./lib/openai', () => ({ extractEvents: vi.fn() }))
vi.mock('./lib/s3', () => ({ uploadToS3: vi.fn() }))
vi.mock('./lib/sheets', () => ({ addEventsToSpreadsheet: vi.fn() }))
vi.mock('./lib/alert', () => ({ sendFailureAlert: vi.fn(), sendOpsAlert: vi.fn() }))

import { sendFailureAlert, sendOpsAlert } from './lib/alert'
import { extractEvents } from './lib/openai'
import { uploadToS3 } from './lib/s3'
import { addEventsToSpreadsheet } from './lib/sheets'
import { parseSesEmail } from './ses-inbound'

const mockExtractEvents = extractEvents as ReturnType<typeof vi.fn>
const mockUploadToS3 = uploadToS3 as ReturnType<typeof vi.fn>
const mockAddEventsToSpreadsheet = addEventsToSpreadsheet as ReturnType<typeof vi.fn>
const mockSendFailureAlert = sendFailureAlert as ReturnType<typeof vi.fn>
const mockSendOpsAlert = sendOpsAlert as ReturnType<typeof vi.fn>

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

// Real MIME message run through the real mailparser
function makeRawEmail({ withImage = true, body = 'here are the flyers' } = {}): Buffer {
  const parts = [
    'From: Liz Cahill <liz@decentered.org>',
    'To: decentered@ses.proteus.tools',
    'Subject: New flyers',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    ''
  ]
  if (withImage) {
    parts.push(
      '--b1',
      'Content-Type: image/png; name="flyer.png"',
      'Content-Disposition: attachment; filename="flyer.png"',
      'Content-Transfer-Encoding: base64',
      '',
      PNG_BYTES.toString('base64'),
      ''
    )
  }
  parts.push('--b1--', '')
  return Buffer.from(parts.join('\r\n'))
}

function makeSesEvent(messageId = 'test-message-id'): SESEvent {
  return {
    Records: [
      {
        eventSource: 'aws:ses',
        eventVersion: '1.0',
        ses: {
          mail: {
            messageId,
            timestamp: '2026-07-03T20:00:00.000Z',
            source: 'liz@decentered.org',
            destination: ['decentered@ses.proteus.tools'],
            commonHeaders: { from: ['Liz Cahill <liz@decentered.org>'], to: ['decentered@ses.proteus.tools'], subject: 'New flyers' }
          },
          receipt: {
            recipients: ['decentered@ses.proteus.tools'],
            spamVerdict: { status: 'PASS' },
            virusVerdict: { status: 'PASS' },
            spfVerdict: { status: 'PASS' },
            dkimVerdict: { status: 'PASS' },
            dmarcVerdict: { status: 'PASS' },
            timestamp: '2026-07-03T20:00:00.000Z',
            processingTimeMillis: 100,
            action: { type: 'Lambda', functionArn: 'arn', invocationType: 'Event' }
          }
        }
      }
    ]
  } as unknown as SESEvent
}

const sampleEvents = {
  events: [
    {
      title: 'Jazz Night',
      address: '123 Main St',
      location: 'San Francisco',
      type: 'Music',
      startDay: '2026-07-15',
      startTime: '20:00',
      description: 'Live jazz',
      cost: '$25',
      endDay: '2026-07-15',
      endTime: '23:00'
    }
  ]
}

function stubRawEmail(raw: Buffer) {
  mockS3Send.mockResolvedValue({ Body: { transformToByteArray: () => Promise.resolve(new Uint8Array(raw)) } })
}

describe('parseSesEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUploadToS3.mockResolvedValue('https://bucket.s3.amazonaws.com/images/test.png')
    mockAddEventsToSpreadsheet.mockResolvedValue(undefined)
    mockSendFailureAlert.mockResolvedValue(undefined)
    mockSendOpsAlert.mockResolvedValue(undefined)
  })

  it('fetches raw email from S3, parses attachments, extracts events, appends to sheet', async () => {
    stubRawEmail(makeRawEmail())
    mockExtractEvents.mockResolvedValue(sampleEvents)

    await parseSesEmail(makeSesEvent(), {} as any, () => {})

    expect(mockS3Send).toHaveBeenCalledTimes(1)
    expect(mockExtractEvents).toHaveBeenCalledWith(expect.any(Buffer), 'image/png')
    expect(mockUploadToS3).toHaveBeenCalledWith(expect.any(Buffer), 'flyer.png', 'image/png')
    expect(mockAddEventsToSpreadsheet).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ s3Url: 'https://bucket.s3.amazonaws.com/images/test.png' })]))
    expect(mockSendFailureAlert).not.toHaveBeenCalled()
    expect(mockSendOpsAlert).not.toHaveBeenCalled()
  })

  it('does nothing for emails with no images or Drive links', async () => {
    stubRawEmail(makeRawEmail({ withImage: false }))

    await parseSesEmail(makeSesEvent(), {} as any, () => {})

    expect(mockExtractEvents).not.toHaveBeenCalled()
    expect(mockAddEventsToSpreadsheet).not.toHaveBeenCalled()
  })

  it('processes Drive links found in the body', async () => {
    stubRawEmail(makeRawEmail({ withImage: false, body: 'flyer: https://drive.google.com/file/d/FILE_A' }))
    mockExtractEvents.mockResolvedValue(sampleEvents)
    const pngResponse = { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: () => Promise.resolve(new Uint8Array(PNG_BYTES).buffer) }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pngResponse))

    await parseSesEmail(makeSesEvent(), {} as any, () => {})

    expect(mockExtractEvents).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('alerts when image processing fails', async () => {
    stubRawEmail(makeRawEmail())
    mockExtractEvents.mockRejectedValue(new Error('vision model unavailable'))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await parseSesEmail(makeSesEvent(), {} as any, () => {})

    expect(mockSendFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({ from: expect.stringContaining('liz@decentered.org') }),
      expect.arrayContaining([expect.stringContaining('flyer.png')])
    )
    consoleSpy.mockRestore()
  })

  it('sends an ops alert when the message cannot be fetched or parsed at all', async () => {
    mockS3Send.mockRejectedValue(new Error('NoSuchKey'))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await parseSesEmail(makeSesEvent('missing-id'), {} as any, () => {})

    expect(mockSendOpsAlert).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('missing-id'))
    consoleSpy.mockRestore()
  })

  it('processes each record independently — one failure does not block others', async () => {
    const event = { Records: [...makeSesEvent('id-1').Records, ...makeSesEvent('id-2').Records] } as SESEvent
    mockS3Send.mockRejectedValueOnce(new Error('NoSuchKey')).mockResolvedValueOnce({ Body: { transformToByteArray: () => Promise.resolve(new Uint8Array(makeRawEmail())) } })
    mockExtractEvents.mockResolvedValue(sampleEvents)
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await parseSesEmail(event, {} as any, () => {})

    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1)
    expect(mockAddEventsToSpreadsheet).toHaveBeenCalledTimes(1)
    consoleSpy.mockRestore()
  })
})
