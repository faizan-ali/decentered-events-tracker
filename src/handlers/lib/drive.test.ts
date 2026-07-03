import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadDriveImage, extractDriveFileIds } from './drive'

describe('extractDriveFileIds', () => {
  it('extracts a file id from a Drive file link', () => {
    const html = '<a href="https://drive.google.com/file/d/1rqxb6_pZhLSLNdtIiGLkYboYpqVl2cjy">flyer</a>'
    expect(extractDriveFileIds(html)).toEqual(['1rqxb6_pZhLSLNdtIiGLkYboYpqVl2cjy'])
  })

  it('dedupes ids that appear in both html and text bodies', () => {
    const html = '<a href="https://drive.google.com/file/d/ABC123">a</a>'
    const text = 'link: https://drive.google.com/file/d/ABC123'
    expect(extractDriveFileIds(html, text)).toEqual(['ABC123'])
  })

  it('collects multiple distinct ids across bodies', () => {
    const html = 'https://drive.google.com/file/d/AAA https://drive.google.com/file/d/BBB'
    const text = 'https://drive.google.com/file/d/CCC'
    expect(extractDriveFileIds(html, text)).toEqual(['AAA', 'BBB', 'CCC'])
  })

  it('ignores drive-thirdparty file-type icons', () => {
    const html = '<img src="https://drive-thirdparty.googleusercontent.com/32/type/image/png">'
    expect(extractDriveFileIds(html)).toEqual([])
  })

  it('handles null and undefined bodies', () => {
    expect(extractDriveFileIds(null, undefined)).toEqual([])
  })

  it('extracts the open?id= link variant', () => {
    expect(extractDriveFileIds('https://drive.google.com/open?id=XYZ_9')).toEqual(['XYZ_9'])
  })

  it('ignores Drive links inside Gmail quoted history (html)', () => {
    const html = '<a href="https://drive.google.com/file/d/NEW_ID">new</a><div class="gmail_quote">On Mon wrote: <a href="https://drive.google.com/file/d/OLD_ID">old</a></div>'
    expect(extractDriveFileIds(html)).toEqual(['NEW_ID'])
  })

  it('ignores Drive links inside blockquotes', () => {
    const html = '<blockquote><a href="https://drive.google.com/file/d/OLD_ID">old</a></blockquote>'
    expect(extractDriveFileIds(html)).toEqual([])
  })

  it('ignores Drive links in plaintext quoted lines', () => {
    const text = 'fresh: https://drive.google.com/file/d/NEW_ID\n> old: https://drive.google.com/file/d/OLD_ID'
    expect(extractDriveFileIds(text)).toEqual(['NEW_ID'])
  })

  it('ignores everything after an "On ... wrote:" reply marker', () => {
    const text = 'see https://drive.google.com/file/d/NEW_ID\nOn Mon, Jun 29, 2026 Liz Cahill wrote:\nhttps://drive.google.com/file/d/OLD_ID'
    expect(extractDriveFileIds(text)).toEqual(['NEW_ID'])
  })
})

describe('downloadDriveImage', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

  it('fetches the thumbnail endpoint and returns a Buffer for a valid image', async () => {
    mockFetch.mockResolvedValue({ ok: true, headers: { get: () => 'image/png' }, arrayBuffer: () => Promise.resolve(PNG_BYTES.buffer) })

    const buffer = await downloadDriveImage('ABC123')

    expect(mockFetch).toHaveBeenCalledWith('https://drive.google.com/thumbnail?id=ABC123&sz=w2000', { signal: expect.any(AbortSignal) })
    expect(Buffer.isBuffer(buffer)).toBe(true)
  })

  it('throws when the response is not ok', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' })
    await expect(downloadDriveImage('ABC123')).rejects.toThrow('Failed to download Drive image ABC123: 404 Not Found')
  })

  it('throws when a private file returns an HTML sign-in page (HTTP 200)', async () => {
    const html = Buffer.from('<html><title>Sign in - Google Accounts</title></html>')
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/html; charset=utf-8' },
      arrayBuffer: () => Promise.resolve(html.buffer.slice(html.byteOffset, html.byteOffset + html.byteLength))
    })
    await expect(downloadDriveImage('ABC123')).rejects.toThrow('not a public image')
  })
})
