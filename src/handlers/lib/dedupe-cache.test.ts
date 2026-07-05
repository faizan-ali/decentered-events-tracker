import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockS3Send } = vi.hoisted(() => ({ mockS3Send: vi.fn() }))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: mockS3Send })),
  GetObjectCommand: vi.fn().mockImplementation(params => ({ __type: 'Get', ...params })),
  PutObjectCommand: vi.fn().mockImplementation(params => ({ __type: 'Put', ...params }))
}))

async function getLib() {
  return await import('./dedupe-cache')
}

describe('dedupe-cache', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    process.env = { ...originalEnv, S3_BUCKET: 'test-bucket', REGION: 'us-west-1' }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('round-trips entries with a savedAt stamp', async () => {
    const { saveDedupeCache } = await getLib()
    mockS3Send.mockResolvedValue({})

    await saveDedupeCache([{ date: '03/15/2025', title: 'test', address: '1 st', link: 'https://x' }])

    const body = JSON.parse(mockS3Send.mock.calls[0][0].Body)
    expect(body.entries).toHaveLength(1)
    expect(Date.parse(body.savedAt)).not.toBeNaN()
    expect(mockS3Send.mock.calls[0][0].Key).toBe('drive-inbox/dedupe-cache.json')
  })

  it('returns entries for a fresh cache', async () => {
    const { loadDedupeCache } = await getLib()
    mockS3Send.mockResolvedValue({
      Body: { transformToString: async () => JSON.stringify({ savedAt: new Date().toISOString(), entries: [{ date: '', title: 't', address: '', link: 'l' }] }) }
    })

    expect(await loadDedupeCache()).toHaveLength(1)
  })

  it('returns null for a cache older than 24h (too stale to bound duplicate risk)', async () => {
    const { loadDedupeCache } = await getLib()
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    mockS3Send.mockResolvedValue({ Body: { transformToString: async () => JSON.stringify({ savedAt: stale, entries: [{ date: '', title: 't', address: '', link: 'l' }] }) } })

    expect(await loadDedupeCache()).toBeNull()
  })

  it('returns null (never throws) when S3 fails — callers decide the consequence', async () => {
    const { loadDedupeCache } = await getLib()
    mockS3Send.mockRejectedValue(new Error('S3 down'))

    expect(await loadDedupeCache()).toBeNull()
  })
})
