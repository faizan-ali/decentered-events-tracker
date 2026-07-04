import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboxFile, Ledger } from './lib/drive-inbox'

const {
  mockLoadLedger,
  mockSaveLedger,
  mockListInboxFiles,
  mockDownloadInboxImage,
  mockMoveToProcessed,
  mockThrottledOpsAlert,
  mockExtractEvents,
  mockUploadToS3,
  mockAddEvents,
  mockDriveFailureAlert,
  ledgerSaves
} = vi.hoisted(() => ({
  mockLoadLedger: vi.fn(),
  mockSaveLedger: vi.fn(),
  mockListInboxFiles: vi.fn(),
  mockDownloadInboxImage: vi.fn(),
  mockMoveToProcessed: vi.fn(),
  mockThrottledOpsAlert: vi.fn().mockResolvedValue(undefined),
  mockExtractEvents: vi.fn(),
  mockUploadToS3: vi.fn(),
  mockAddEvents: vi.fn(),
  mockDriveFailureAlert: vi.fn(),
  // deep snapshots of the ledger at each saveLedger call
  ledgerSaves: [] as Ledger[]
}))

vi.mock('./lib/drive-inbox', () => ({
  loadLedger: mockLoadLedger,
  saveLedger: mockSaveLedger,
  listInboxFiles: mockListInboxFiles,
  downloadInboxImage: mockDownloadInboxImage,
  moveToProcessed: mockMoveToProcessed,
  sendThrottledOpsAlert: mockThrottledOpsAlert
}))

vi.mock('./lib/openai', () => ({ extractEvents: mockExtractEvents }))
vi.mock('./lib/s3', () => ({ uploadToS3: mockUploadToS3 }))
vi.mock('./lib/sheets', () => ({ addEventsToSpreadsheet: mockAddEvents }))
vi.mock('./lib/alert', () => ({ sendDriveInboxFailureAlert: mockDriveFailureAlert }))

import { pollDriveInbox } from './drive-inbox'

const run = () => (pollDriveInbox as any)({}, {}, () => {})

const file = (id: string, overrides: Partial<InboxFile> = {}): InboxFile => ({
  id,
  name: `${id}.png`,
  mimeType: 'image/png',
  size: 1000,
  createdTime: '2026-07-01T00:00:00Z',
  thumbnailLink: `https://lh3.example/${id}=s220`,
  isFolder: false,
  ...overrides
})

const sampleEvent = {
  title: 'Show',
  address: '123 St',
  location: 'SF',
  type: 'Music',
  startDay: '2026-07-10',
  startTime: '19:00',
  description: '',
  cost: null,
  endDay: '2026-07-10',
  endTime: null
}

describe('pollDriveInbox', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ledgerSaves.length = 0
    mockLoadLedger.mockResolvedValue({})
    mockSaveLedger.mockImplementation(async (ledger: Ledger) => {
      ledgerSaves.push(JSON.parse(JSON.stringify(ledger)))
    })
    mockListInboxFiles.mockResolvedValue([])
    mockDownloadInboxImage.mockResolvedValue({ buffer: Buffer.from('img'), contentType: 'image/jpeg' })
    mockUploadToS3.mockResolvedValue('https://bucket.s3.us-west-1.amazonaws.com/images/123_drive_f1_flyer.png')
    mockExtractEvents.mockResolvedValue({ events: [sampleEvent] })
    mockAddEvents.mockResolvedValue(undefined)
    mockMoveToProcessed.mockResolvedValue(undefined)
    mockDriveFailureAlert.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('does nothing when the inbox is empty', async () => {
    await run()

    expect(mockSaveLedger).not.toHaveBeenCalled()
    expect(mockDownloadInboxImage).not.toHaveBeenCalled()
  })

  it('processes a file end to end: pre-bump, extract, append with sourceTag, mark processed, move', async () => {
    mockListInboxFiles.mockResolvedValue([file('f1')])

    await run()

    // first save: pre-bumped attempts BEFORE any download
    expect(ledgerSaves[0].f1).toMatchObject({ attempts: 1 })
    expect(ledgerSaves[0].f1.status).toBeUndefined()

    expect(mockDownloadInboxImage).toHaveBeenCalledTimes(1)
    expect(mockUploadToS3).toHaveBeenCalledWith(expect.any(Buffer), 'drive_f1_f1.png', 'image/jpeg')
    expect(mockAddEvents).toHaveBeenCalledWith([expect.objectContaining({ sourceTag: 'drive_f1_' })])

    // final save: processed
    expect(ledgerSaves.at(-1)?.f1).toMatchObject({ attempts: 1, status: 'processed' })
    expect(mockMoveToProcessed).toHaveBeenCalledWith('f1')
    expect(mockDriveFailureAlert).not.toHaveBeenCalled()
  })

  it('marks a 0-event file processed (nothing to append is success, same as the email path)', async () => {
    mockListInboxFiles.mockResolvedValue([file('f1')])
    mockExtractEvents.mockResolvedValue({ events: [] })

    await run()

    expect(mockAddEvents).not.toHaveBeenCalled()
    expect(ledgerSaves.at(-1)?.f1).toMatchObject({ status: 'processed' })
    expect(mockMoveToProcessed).toHaveBeenCalledWith('f1')
  })

  it('aborts before any download when the pre-bump ledger save fails (no unbookkept GPT spend)', async () => {
    mockListInboxFiles.mockResolvedValue([file('f1')])
    mockSaveLedger.mockRejectedValue(new Error('S3 write denied'))

    await run()

    expect(mockDownloadInboxImage).not.toHaveBeenCalled()
    expect(mockExtractEvents).not.toHaveBeenCalled()
    expect(mockThrottledOpsAlert).toHaveBeenCalled()
  })

  it('leaves a transiently-failed file for the next poll: attempts persisted, no status, no alert', async () => {
    mockListInboxFiles.mockResolvedValue([file('f1')])
    mockDownloadInboxImage.mockRejectedValue(new Error('thumbnail not generated yet'))

    await run()

    const final = ledgerSaves.at(-1)?.f1
    expect(final).toMatchObject({ attempts: 1, lastError: 'thumbnail not generated yet' })
    expect(final?.status).toBeUndefined()
    expect(mockDriveFailureAlert).not.toHaveBeenCalled()
    expect(mockMoveToProcessed).not.toHaveBeenCalled()
  })

  it('fails a file permanently when this run uses its last attempt: alert sent, marked failed', async () => {
    mockListInboxFiles.mockResolvedValue([file('f1')])
    mockLoadLedger.mockResolvedValue({ f1: { attempts: 2, name: 'f1.png', updatedAt: 'earlier' } })
    mockDownloadInboxImage.mockRejectedValue(new Error('still broken'))

    await run()

    expect(mockDriveFailureAlert).toHaveBeenCalledWith([expect.objectContaining({ name: 'f1.png', reason: expect.stringContaining('still broken') })])
    expect(ledgerSaves.at(-1)?.f1).toMatchObject({ attempts: 3, status: 'failed', alertPending: false })
  })

  it('fails files exhausted by earlier crashed runs without reprocessing them', async () => {
    mockListInboxFiles.mockResolvedValue([file('f1')])
    mockLoadLedger.mockResolvedValue({ f1: { attempts: 3, name: 'f1.png', updatedAt: 'earlier', lastError: 'timed out' } })

    await run()

    expect(mockDownloadInboxImage).not.toHaveBeenCalled()
    expect(mockDriveFailureAlert).toHaveBeenCalledWith([expect.objectContaining({ reason: 'timed out' })])
    expect(ledgerSaves.at(-1)?.f1).toMatchObject({ status: 'failed' })
  })

  it('alerts on a dragged-in folder instead of silently ignoring it', async () => {
    mockListInboxFiles.mockResolvedValue([file('sub1', { name: 'July flyers', mimeType: 'application/vnd.google-apps.folder', isFolder: true, thumbnailLink: undefined })])

    await run()

    expect(mockDownloadInboxImage).not.toHaveBeenCalled()
    expect(mockDriveFailureAlert).toHaveBeenCalledWith([expect.objectContaining({ name: 'July flyers', reason: expect.stringContaining('folder') })])
    expect(ledgerSaves.at(-1)?.sub1).toMatchObject({ status: 'failed', alertPending: false })
  })

  it('keeps alertPending when the failure alert send fails, and retries it next poll without reprocessing', async () => {
    mockListInboxFiles.mockResolvedValue([file('f1')])
    mockLoadLedger.mockResolvedValue({ f1: { attempts: 3, name: 'f1.png', updatedAt: 'earlier', lastError: 'broken' } })
    mockDriveFailureAlert.mockRejectedValueOnce(new Error('inbound.new down'))

    await run()
    expect(ledgerSaves.at(-1)?.f1).toMatchObject({ status: 'failed', alertPending: true })

    // next poll: file still there, status failed + alertPending → alert retried, nothing reprocessed
    ledgerSaves.length = 0
    mockLoadLedger.mockResolvedValue(
      JSON.parse(JSON.stringify({ f1: { attempts: 3, name: 'f1.png', updatedAt: 'earlier', lastError: 'broken', status: 'failed', alertPending: true } }))
    )
    mockDriveFailureAlert.mockResolvedValue(undefined)

    await run()

    expect(mockDownloadInboxImage).not.toHaveBeenCalled()
    expect(mockDriveFailureAlert).toHaveBeenCalledTimes(2)
    expect(ledgerSaves.at(-1)?.f1).toMatchObject({ alertPending: false })
  })

  it('does not mark files processed when the spreadsheet append throws (pre-bumped attempts cap the retries)', async () => {
    mockListInboxFiles.mockResolvedValue([file('f1')])
    mockAddEvents.mockRejectedValue(new Error('Sheets 500'))

    await run()

    expect(ledgerSaves.at(-1)?.f1?.status).toBeUndefined()
    expect(ledgerSaves.at(-1)?.f1).toMatchObject({ attempts: 1 })
    expect(mockMoveToProcessed).not.toHaveBeenCalled()
    expect(mockThrottledOpsAlert).toHaveBeenCalled()
  })

  it('prunes ledger entries for files that left the inbox', async () => {
    mockListInboxFiles.mockResolvedValue([file('f2')])
    mockLoadLedger.mockResolvedValue({ gone: { attempts: 1, name: 'gone.png', updatedAt: 'earlier', status: 'processed' } })

    await run()

    expect(ledgerSaves.at(-1)?.gone).toBeUndefined()
    expect(ledgerSaves.at(-1)?.f2).toMatchObject({ status: 'processed' })
  })

  it('skips files already marked processed or failed', async () => {
    mockListInboxFiles.mockResolvedValue([file('done'), file('bad')])
    mockLoadLedger.mockResolvedValue({
      done: { attempts: 1, name: 'done.png', updatedAt: 'earlier', status: 'processed' },
      bad: { attempts: 3, name: 'bad.png', updatedAt: 'earlier', status: 'failed' }
    })

    await run()

    expect(mockDownloadInboxImage).not.toHaveBeenCalled()
    expect(mockDriveFailureAlert).not.toHaveBeenCalled()
    expect(mockSaveLedger).not.toHaveBeenCalled()
  })

  it('caps a large backlog at 10 files per run', async () => {
    mockListInboxFiles.mockResolvedValue(Array.from({ length: 25 }, (_, i) => file(`f${i}`)))

    await run()

    expect(mockDownloadInboxImage).toHaveBeenCalledTimes(10)
    expect(Object.keys(ledgerSaves[0])).toHaveLength(10)
  })

  it('continues processing other files when one fails', async () => {
    mockListInboxFiles.mockResolvedValue([file('ok'), file('broken')])
    mockDownloadInboxImage.mockImplementation(async (f: InboxFile) => {
      if (f.id === 'broken') throw new Error('nope')
      return { buffer: Buffer.from('img'), contentType: 'image/jpeg' }
    })

    await run()

    expect(ledgerSaves.at(-1)?.ok).toMatchObject({ status: 'processed' })
    expect(ledgerSaves.at(-1)?.broken?.status).toBeUndefined()
    expect(mockMoveToProcessed).toHaveBeenCalledTimes(1)
  })

  it('survives a failed move (ledger is the source of truth, move is UX)', async () => {
    mockListInboxFiles.mockResolvedValue([file('f1')])
    mockMoveToProcessed.mockRejectedValue(new Error('insufficientFilePermissions'))

    await run()

    expect(ledgerSaves.at(-1)?.f1).toMatchObject({ status: 'processed' })
    expect(mockThrottledOpsAlert).not.toHaveBeenCalled()
  })

  it('fails the file (transient) when the S3 upload fails, instead of appending rows with an empty link', async () => {
    mockListInboxFiles.mockResolvedValue([file('f1')])
    mockUploadToS3.mockRejectedValue(new Error('S3 500'))

    await run()

    expect(mockAddEvents).not.toHaveBeenCalled()
    const final = ledgerSaves.at(-1)?.f1
    expect(final?.status).toBeUndefined()
    expect(final).toMatchObject({ attempts: 1, lastError: expect.stringContaining('S3 500') })
    expect(mockMoveToProcessed).not.toHaveBeenCalled()
  })

  it('preserves failed+alertPending ledger entries when the file leaves the inbox, and still sends the alert', async () => {
    // file is GONE from the listing but its alert was never delivered
    mockListInboxFiles.mockResolvedValue([])
    mockLoadLedger.mockResolvedValue({
      gone: { attempts: 3, name: 'gone.png', updatedAt: 'earlier', status: 'failed', alertPending: true, lastError: 'broken' }
    })

    await run()

    expect(mockDriveFailureAlert).toHaveBeenCalledWith([expect.objectContaining({ name: 'gone.png', reason: 'broken' })])
    // entry survived the prune long enough to alert, and the flag cleared
    expect(ledgerSaves.at(-1)?.gone).toMatchObject({ status: 'failed', alertPending: false })
  })

  it('prunes a failed entry once its alert has been delivered and the file is gone', async () => {
    mockListInboxFiles.mockResolvedValue([file('other')])
    mockLoadLedger.mockResolvedValue({
      gone: { attempts: 3, name: 'gone.png', updatedAt: 'earlier', status: 'failed', alertPending: false }
    })

    await run()

    expect(ledgerSaves.at(-1)?.gone).toBeUndefined()
    expect(mockDriveFailureAlert).not.toHaveBeenCalled()
  })

  it('links folders with the /drive/folders/ URL form in alerts, not /file/d/', async () => {
    mockListInboxFiles.mockResolvedValue([file('sub1', { name: 'July flyers', mimeType: 'application/vnd.google-apps.folder', isFolder: true, thumbnailLink: undefined })])

    await run()

    expect(mockDriveFailureAlert).toHaveBeenCalledWith([expect.objectContaining({ link: 'https://drive.google.com/drive/folders/sub1' })])
  })

  it('sends a throttled ops alert on unexpected top-level errors', async () => {
    mockListInboxFiles.mockRejectedValue(new Error('Drive API disabled'))

    await run()

    expect(mockThrottledOpsAlert).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining('pollDriveInbox'))
  })
})
