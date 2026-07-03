import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockS3Send, mockList, mockGet, mockUpdate, mockGetAccessToken, mockSendOpsAlert } = vi.hoisted(() => ({
  mockS3Send: vi.fn(),
  mockList: vi.fn(),
  mockGet: vi.fn(),
  mockUpdate: vi.fn(),
  mockGetAccessToken: vi.fn().mockResolvedValue({ token: 'test-token' }),
  mockSendOpsAlert: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: mockS3Send })),
  GetObjectCommand: vi.fn().mockImplementation(params => ({ __type: 'Get', ...params })),
  PutObjectCommand: vi.fn().mockImplementation(params => ({ __type: 'Put', ...params }))
}))

vi.mock('googleapis', () => ({
  google: {
    drive: vi.fn(() => ({
      files: {
        list: mockList,
        get: mockGet,
        update: mockUpdate
      }
    }))
  }
}))

vi.mock('google-auth-library', () => ({
  JWT: vi.fn().mockImplementation(() => ({ getAccessToken: mockGetAccessToken }))
}))

vi.mock('./alert', () => ({
  sendOpsAlert: mockSendOpsAlert
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])
const HTML_BYTES = Buffer.from('<!DOCTYPE html><html>Sign in - Google Accounts</html>')

const INBOX_ID = 'inbox-folder-id'
const PROCESSED_ID = 'processed-folder-id'

async function getLib() {
  return await import('./drive-inbox')
}

describe('drive-inbox lib', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    mockGetAccessToken.mockResolvedValue({ token: 'test-token' })
    process.env = {
      ...originalEnv,
      S3_BUCKET: 'test-bucket',
      REGION: 'us-west-1',
      DRIVE_INBOX_FOLDER_ID: INBOX_ID,
      DRIVE_PROCESSED_FOLDER_ID: PROCESSED_ID,
      GOOGLE_SERVICE_ACCOUNT_EMAIL: 'sa@test.iam.gserviceaccount.com',
      GOOGLE_PRIVATE_KEY: 'key'
    }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe('loadLedger', () => {
    it('returns empty ledger when the S3 object does not exist', async () => {
      const { loadLedger } = await getLib()
      const err = new Error('no key')
      err.name = 'NoSuchKey'
      mockS3Send.mockRejectedValue(err)

      expect(await loadLedger()).toEqual({})
    })

    it('parses the stored ledger', async () => {
      const { loadLedger } = await getLib()
      const stored = { file1: { attempts: 2, name: 'a.png', updatedAt: '2026-07-03T00:00:00Z' } }
      mockS3Send.mockResolvedValue({ Body: { transformToString: async () => JSON.stringify(stored) } })

      expect(await loadLedger()).toEqual(stored)
    })

    it('rethrows non-NoSuchKey errors (run must abort, not process unbookkept)', async () => {
      const { loadLedger } = await getLib()
      mockS3Send.mockRejectedValue(new Error('AccessDenied'))

      await expect(loadLedger()).rejects.toThrow('AccessDenied')
    })
  })

  describe('saveLedger', () => {
    it('writes JSON to the ledger key', async () => {
      const { saveLedger } = await getLib()
      mockS3Send.mockResolvedValue({})

      await saveLedger({ f1: { attempts: 1, name: 'x.png', updatedAt: 'now' } })

      expect(mockS3Send).toHaveBeenCalledWith(
        expect.objectContaining({
          __type: 'Put',
          Bucket: 'test-bucket',
          Key: 'drive-inbox/state.json',
          ContentType: 'application/json'
        })
      )
      expect(JSON.parse(mockS3Send.mock.calls[0][0].Body)).toEqual({ f1: { attempts: 1, name: 'x.png', updatedAt: 'now' } })
    })
  })

  describe('listInboxFiles', () => {
    it('lists files oldest-first, paginating, excluding the processed folder but keeping other folders', async () => {
      const { listInboxFiles } = await getLib()
      mockList
        .mockResolvedValueOnce({
          data: {
            nextPageToken: 'page2',
            files: [
              { id: 'img1', name: 'flyer.png', mimeType: 'image/png', size: '12345', createdTime: '2026-07-01T00:00:00Z', thumbnailLink: 'https://lh3.example/t1=s220' },
              { id: PROCESSED_ID, name: 'processed', mimeType: 'application/vnd.google-apps.folder' }
            ]
          }
        })
        .mockResolvedValueOnce({
          data: {
            files: [{ id: 'sub1', name: 'A folder of flyers', mimeType: 'application/vnd.google-apps.folder', createdTime: '2026-07-02T00:00:00Z' }]
          }
        })

      const files = await listInboxFiles()

      expect(files).toHaveLength(2)
      expect(files[0]).toMatchObject({ id: 'img1', size: 12345, isFolder: false })
      expect(files[1]).toMatchObject({ id: 'sub1', isFolder: true, size: undefined })
      expect(mockList).toHaveBeenCalledTimes(2)
      // every googleapis call must carry an explicit timeout
      expect(mockList.mock.calls[0][1]).toMatchObject({ timeout: expect.any(Number) })
      expect(mockList.mock.calls[0][0].q).toContain(`'${INBOX_ID}' in parents`)
      expect(mockList.mock.calls[0][0].q).toContain('trashed = false')
    })
  })

  describe('downloadInboxImage', () => {
    const imageFile = {
      id: 'img1',
      name: 'flyer.heic',
      mimeType: 'image/heic',
      size: 8_000_000,
      createdTime: '2026-07-01T00:00:00Z',
      thumbnailLink: 'https://lh3.googleusercontent.com/abc=s220',
      isFolder: false
    }

    it('fetches the thumbnail at 2000px with a Bearer token', async () => {
      const { downloadInboxImage } = await getLib()
      mockFetch.mockResolvedValue({
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength)
      })

      const result = await downloadInboxImage(imageFile)

      expect(result.contentType).toBe('image/jpeg')
      expect(mockFetch).toHaveBeenCalledWith('https://lh3.googleusercontent.com/abc=s2000', expect.objectContaining({ headers: { Authorization: 'Bearer test-token' } }))
    })

    it('rejects an HTML interstitial and falls back to raw download for eligible types', async () => {
      const { downloadInboxImage } = await getLib()
      const jpegFile = { ...imageFile, mimeType: 'image/jpeg' }
      mockFetch.mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/html' },
        arrayBuffer: async () => HTML_BYTES.buffer.slice(HTML_BYTES.byteOffset, HTML_BYTES.byteOffset + HTML_BYTES.byteLength)
      })
      mockGet.mockResolvedValue({ data: PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength) })

      const result = await downloadInboxImage(jpegFile)

      expect(result.contentType).toBe('image/jpeg')
      expect(mockGet).toHaveBeenCalledWith({ fileId: 'img1', alt: 'media' }, expect.objectContaining({ responseType: 'arraybuffer', timeout: expect.any(Number) }))
    })

    it('does not raw-download HEIC (OpenAI cannot take it) — throws transient error instead', async () => {
      const { downloadInboxImage } = await getLib()
      mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' })

      await expect(downloadInboxImage(imageFile)).rejects.toThrow(/No usable thumbnail/)
      expect(mockGet).not.toHaveBeenCalled()
    })

    it('does not raw-download oversized files', async () => {
      const { downloadInboxImage } = await getLib()
      const bigJpeg = { ...imageFile, mimeType: 'image/jpeg', size: 30 * 1024 * 1024, thumbnailLink: undefined }

      await expect(downloadInboxImage(bigJpeg)).rejects.toThrow(/No usable thumbnail/)
      expect(mockGet).not.toHaveBeenCalled()
    })

    it('rejects raw bytes that are not a real image', async () => {
      const { downloadInboxImage } = await getLib()
      const jpegFile = { ...imageFile, mimeType: 'image/jpeg', thumbnailLink: undefined }
      mockGet.mockResolvedValue({ data: HTML_BYTES.buffer.slice(HTML_BYTES.byteOffset, HTML_BYTES.byteOffset + HTML_BYTES.byteLength) })

      await expect(downloadInboxImage(jpegFile)).rejects.toThrow(/not valid image bytes/)
    })
  })

  describe('moveToProcessed', () => {
    it('moves the file between parents with a bounded call', async () => {
      const { moveToProcessed } = await getLib()
      mockUpdate.mockResolvedValue({})

      await moveToProcessed('img1')

      expect(mockUpdate).toHaveBeenCalledWith(
        { fileId: 'img1', addParents: PROCESSED_ID, removeParents: INBOX_ID, fields: 'id' },
        expect.objectContaining({ timeout: expect.any(Number) })
      )
    })
  })

  describe('sendThrottledOpsAlert', () => {
    it('suppresses when a recent marker exists', async () => {
      const { sendThrottledOpsAlert } = await getLib()
      mockS3Send.mockResolvedValue({ Body: { transformToString: async () => JSON.stringify({ sentAt: new Date().toISOString() }) } })

      await sendThrottledOpsAlert(new Error('boom'), 'test')

      expect(mockSendOpsAlert).not.toHaveBeenCalled()
    })

    it('sends and writes the marker when the last alert is stale', async () => {
      const { sendThrottledOpsAlert } = await getLib()
      const stale = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString()
      mockS3Send.mockResolvedValueOnce({ Body: { transformToString: async () => JSON.stringify({ sentAt: stale }) } }).mockResolvedValueOnce({})

      await sendThrottledOpsAlert(new Error('boom'), 'test')

      expect(mockSendOpsAlert).toHaveBeenCalledWith(expect.any(Error), 'test')
      expect(mockS3Send.mock.calls[1][0]).toMatchObject({ __type: 'Put', Key: 'drive-inbox/last-ops-alert.json' })
    })

    it('fails open: alerts anyway when the marker check itself breaks', async () => {
      const { sendThrottledOpsAlert } = await getLib()
      mockS3Send.mockRejectedValue(new Error('S3 down'))

      await sendThrottledOpsAlert(new Error('boom'), 'test')

      expect(mockSendOpsAlert).toHaveBeenCalled()
    })
  })
})
