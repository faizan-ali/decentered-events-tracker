// Fallback cache for the sheet dedupe index. The spreadsheet is ALWAYS the
// source of truth — every append still reads it fresh, so manual edits to the
// sheet are respected. This cache exists only for when that read fails
// (Sheets tail latency blowing the 15s bound): a few-minutes-stale index is
// strictly better than either aborting the run (Drive path) or appending
// with no dedupe at all (email path).
//
// Kept under drive-inbox/ purely to reuse the existing IAM grant
// (GetObject/PutObject on drive-inbox/*).

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

const S3_BUCKET = process.env.S3_BUCKET
const REGION = process.env.REGION
const CACHE_KEY = 'drive-inbox/dedupe-cache.json'

// Refuse a fallback older than this: a day-old index no longer bounds the
// duplicate risk meaningfully, and something is badly wrong anyway if no
// read has succeeded in 24h
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000

const s3Client = new S3Client({ region: REGION })

export interface CachedDedupeEntry {
  date: string
  title: string
  address: string
  link: string
}

interface CacheFile {
  savedAt: string
  entries: CachedDedupeEntry[]
}

export async function saveDedupeCache(entries: CachedDedupeEntry[]): Promise<void> {
  const body: CacheFile = { savedAt: new Date().toISOString(), entries }
  await s3Client.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: CACHE_KEY, Body: JSON.stringify(body), ContentType: 'application/json' }))
}

// Returns null when there is no usable cache (absent, unreadable, or too
// stale) — the caller decides whether that means abort or proceed bare
export async function loadDedupeCache(): Promise<CachedDedupeEntry[] | null> {
  try {
    const result = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: CACHE_KEY }))
    const raw = await result.Body?.transformToString()
    if (!raw) return null
    const parsed = JSON.parse(raw) as CacheFile
    const age = Date.now() - Date.parse(parsed.savedAt)
    if (!Array.isArray(parsed.entries) || Number.isNaN(age) || age > MAX_CACHE_AGE_MS) return null
    return parsed.entries
  } catch (error) {
    console.warn('Dedupe cache unavailable:', error instanceof Error ? error.message : error)
    return null
  }
}
