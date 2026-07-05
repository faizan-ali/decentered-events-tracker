// Drive-folder ingestion: Liz drops flyer files into a shared "Decentered
// Uploads" folder instead of emailing them. A scheduled Lambda polls the
// folder, runs the same extraction pipeline as the email path, and moves
// handled files to the processed/ subfolder.
//
// State model: an S3 ledger object is the source of truth for what has been
// processed. Drive-side writes (moving files) are best-effort UX only — files
// Liz uploads are OWNED BY HER, and consumer Drive can refuse non-owner
// moves, so correctness must never depend on them succeeding.

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { JWT } from 'google-auth-library'
import { type drive_v3, google } from 'googleapis'
import { type InFlightFile, sendDrivePollerDownAlert, sendDrivePollerRecoveredAlert } from './alert'
import { isImageBuffer } from './drive'
import { withTimeout } from './timeout'

const S3_BUCKET = process.env.S3_BUCKET
const REGION = process.env.REGION
const INBOX_FOLDER_ID = process.env.DRIVE_INBOX_FOLDER_ID
const PROCESSED_FOLDER_ID = process.env.DRIVE_PROCESSED_FOLDER_ID

const LEDGER_KEY = 'drive-inbox/state.json'
const OPS_STATE_KEY = 'drive-inbox/ops-state.json'

// Raw download is only a fallback for when Drive has not generated a
// thumbnail: OpenAI accepts these formats directly, and 15MB is a safe bound
// (base64 inflates 4/3, and OpenAI rejects ~20MB+ images).
const RAW_ELIGIBLE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const MAX_RAW_DOWNLOAD_BYTES = 15 * 1024 * 1024

const s3Client = new S3Client({ region: REGION })

// Every googleapis call must carry an explicit timeout: gaxios has NO default,
// and one hung call would burn the whole 120s Lambda budget, leaving the
// ledger unmarked (which is exactly what the pre-bumped attempts counter is
// there to bound — but don't lean on it for a known-preventable hang).
const DRIVE_CALL_TIMEOUT_MS = 10_000
const DOWNLOAD_TIMEOUT_MS = 20_000

let jwtClient: JWT | undefined
let driveClient: drive_v3.Drive | undefined

function getJwtClient(): JWT {
  if (!jwtClient) {
    jwtClient = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/drive']
    })
  }
  return jwtClient
}

function getDriveClient(): drive_v3.Drive {
  if (!driveClient) {
    // @ts-expect-error - auth typing mismatch, same workaround as sheets.ts
    driveClient = google.drive({ version: 'v3', auth: getJwtClient() })
  }
  return driveClient
}

export interface LedgerEntry {
  attempts: number
  status?: 'processed' | 'failed'
  alertPending?: boolean
  name: string
  isFolder?: boolean
  lastError?: string
  updatedAt: string
}

export type Ledger = Record<string, LedgerEntry>

export async function loadLedger(): Promise<Ledger> {
  try {
    const result = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: LEDGER_KEY }))
    const body = await result.Body?.transformToString()
    return body ? (JSON.parse(body) as Ledger) : {}
  } catch (error) {
    if (error instanceof Error && error.name === 'NoSuchKey') return {}
    // S3 only returns NoSuchKey when the caller has s3:ListBucket on the
    // bucket; without it a missing key 403s and bootstrap would brick every
    // poll. The role grants ListBucket for exactly this reason — if it ever
    // 403s again, make the ops alert diagnostic instead of guessing empty
    // (guessing would reset attempts and unbound GPT respend if the ledger
    // actually exists but GET is denied).
    if (error instanceof Error && error.name === 'AccessDenied') {
      throw new Error(
        `Ledger GET AccessDenied — if drive-inbox/state.json is missing, this means the role lost s3:ListBucket (absent keys 403 without it). Original: ${error.message}`
      )
    }
    throw error
  }
}

export async function saveLedger(ledger: Ledger): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: LEDGER_KEY,
      Body: JSON.stringify(ledger, null, 2),
      ContentType: 'application/json'
    })
  )
}

export interface InboxFile {
  id: string
  name: string
  mimeType: string
  size?: number
  createdTime: string
  thumbnailLink?: string
  isFolder: boolean
}

// List everything directly inside the inbox folder, oldest first. Folders are
// INCLUDED (except processed/) so the handler can alert on them — a dragged-in
// folder of images that silently never appears is this project's signature
// failure mode.
export async function listInboxFiles(): Promise<InboxFile[]> {
  if (!INBOX_FOLDER_ID) throw new Error('DRIVE_INBOX_FOLDER_ID environment variable not set')

  const drive = getDriveClient()
  const files: InboxFile[] = []
  let pageToken: string | undefined

  do {
    const result = await drive.files.list(
      {
        q: `'${INBOX_FOLDER_ID}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size, createdTime, thumbnailLink)',
        orderBy: 'createdTime',
        pageSize: 100,
        pageToken
      },
      { timeout: DRIVE_CALL_TIMEOUT_MS }
    )

    for (const f of result.data.files ?? []) {
      if (!f.id || f.id === PROCESSED_FOLDER_ID) continue
      files.push({
        id: f.id,
        name: f.name ?? f.id,
        mimeType: f.mimeType ?? '',
        // Drive returns size as a string; Google-native files have none
        size: f.size ? Number(f.size) : undefined,
        createdTime: f.createdTime ?? '',
        thumbnailLink: f.thumbnailLink ?? undefined,
        isFolder: f.mimeType === 'application/vnd.google-apps.folder'
      })
    }
    pageToken = result.data.nextPageToken ?? undefined
  } while (pageToken)

  return files
}

// Thumbnail-first download. Drive renders a bounded-resolution JPEG for
// images, HEIC, and even PDFs (page 1) — which is exactly what the vision
// model wants and sidesteps both the HEIC-format and oversized-original
// problems with zero native dependencies. Raw alt=media is only a fallback
// for OpenAI-native formats when the thumbnail hasn't been generated yet
// (generation lags upload; the caller's attempts counter absorbs the wait).
export async function downloadInboxImage(file: InboxFile): Promise<{ buffer: Buffer; contentType: string }> {
  if (file.thumbnailLink) {
    // The whole thumbnail attempt is one try/catch: a network-level failure
    // (abort, DNS) must fall through to the raw fallback exactly like an
    // HTTP-level failure does — otherwise a transient thumbnail hiccup burns
    // an attempt on a file raw download could have handled.
    try {
      // thumbnailLink is short-lived (hours) — always fetched fresh from the
      // listing, never cached. Rewrite the size suffix (=sNNN or =wNNN-hNNN…
      // forms) to 2000px, the same bound the email path's public-thumbnail
      // fetch uses; an unrecognized suffix form is fetched as-is and logged.
      const url = file.thumbnailLink.replace(/=[swh]\d[\w-]*$/, '=s2000')
      if (url === file.thumbnailLink) {
        console.warn(`Thumbnail link for ${file.id} has an unrecognized size suffix, fetching at default resolution: ${file.thumbnailLink}`)
      }
      // The OAuth token fetch has no native timeout (gaxios only arms one
      // when asked) — bound it like every other outbound call here
      const { token } = await withTimeout(getJwtClient().getAccessToken(), DRIVE_CALL_TIMEOUT_MS, 'OAuth token fetch')
      const response = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
      })

      if (response.ok) {
        const contentType = response.headers.get('content-type') ?? ''
        const buffer = Buffer.from(await response.arrayBuffer())
        // Never trust status 200 alone: Google endpoints return HTML
        // interstitials with 200 when auth is off
        if (contentType.startsWith('image/') && isImageBuffer(buffer)) {
          return { buffer, contentType }
        }
        console.warn(`Thumbnail for ${file.id} returned non-image (${contentType}, ${buffer.length} bytes), trying raw download`)
      } else {
        console.warn(`Thumbnail fetch for ${file.id} failed: ${response.status} ${response.statusText}, trying raw download`)
      }
    } catch (thumbError) {
      console.warn(`Thumbnail fetch for ${file.id} threw (${thumbError instanceof Error ? thumbError.message : thumbError}), trying raw download`)
    }
  }

  if (RAW_ELIGIBLE_MIME_TYPES.has(file.mimeType) && file.size !== undefined && file.size <= MAX_RAW_DOWNLOAD_BYTES) {
    const drive = getDriveClient()
    const result = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer', timeout: DOWNLOAD_TIMEOUT_MS })
    const buffer = Buffer.from(result.data as ArrayBuffer)
    if (!isImageBuffer(buffer)) {
      throw new Error(`Raw download of ${file.name} is not valid image bytes`)
    }
    return { buffer, contentType: file.mimeType }
  }

  // No thumbnail yet and raw isn't safe — likely thumbnail generation lag;
  // transient, the next poll retries
  throw new Error(`No usable thumbnail for ${file.name} (${file.mimeType}, ${file.size ?? 'unknown'} bytes) and file is not raw-downloadable`)
}

// Best-effort only: Liz owns her uploads and consumer Drive may 403 a
// non-owner move. The ledger already recorded the outcome; this is just so
// she can see which files were picked up.
export async function moveToProcessed(fileId: string): Promise<void> {
  if (!PROCESSED_FOLDER_ID || !INBOX_FOLDER_ID) throw new Error('DRIVE_PROCESSED_FOLDER_ID / DRIVE_INBOX_FOLDER_ID not set')
  const drive = getDriveClient()
  await drive.files.update({ fileId, addParents: PROCESSED_FOLDER_ID, removeParents: INBOX_FOLDER_ID, fields: 'id' }, { timeout: DRIVE_CALL_TIMEOUT_MS })
}

// Ops alerting on PERSISTENCE, not occurrence: a single failed poll is not an
// incident — the next 5-minute tick IS the retry, so emailing on the first
// failure produces alarms for self-healing blips. Instead, track consecutive
// failures in S3 and email only when a streak crosses the threshold, with a
// recovery email closing the loop. Down-alerts are rate-capped at one per 6h
// even across streaks (flap protection); the CloudWatch log-filter alarm is
// the independent real-time backstop throughout.
interface OpsState {
  consecutiveFailures: number
  firstFailureAt: string
  alertedThisStreak: boolean
  lastAlertAt?: string
}

const CONSECUTIVE_FAILURES_BEFORE_ALERT = 3
const REALERT_INTERVAL_MS = 6 * 60 * 60 * 1000

async function loadOpsState(): Promise<OpsState | null> {
  try {
    const result = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: OPS_STATE_KEY }))
    const body = await result.Body?.transformToString()
    return body ? (JSON.parse(body) as OpsState) : null
  } catch (error) {
    if (error instanceof Error && error.name === 'NoSuchKey') return null
    throw error
  }
}

async function saveOpsState(state: OpsState): Promise<void> {
  await s3Client.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: OPS_STATE_KEY, Body: JSON.stringify(state), ContentType: 'application/json' }))
}

export async function reportPollFailure(error: unknown, inFlight: InFlightFile[]): Promise<void> {
  let state: OpsState = { consecutiveFailures: 0, firstFailureAt: new Date().toISOString(), alertedThisStreak: false }
  let stateReadable = true
  try {
    state = (await loadOpsState()) ?? state
  } catch (stateError) {
    // Fail OPEN: if we cannot count failures we alert immediately rather
    // than never — the breakage may be S3 itself
    stateReadable = false
    console.error('Ops state unreadable, failing open to an immediate alert:', stateError)
  }

  state.consecutiveFailures += 1
  if (state.consecutiveFailures === 1) {
    state.firstFailureAt = new Date().toISOString()
    state.alertedThisStreak = false
  }

  const dueByStreak = state.consecutiveFailures >= CONSECUTIVE_FAILURES_BEFORE_ALERT
  const dueByTime = !state.lastAlertAt || Date.now() - Date.parse(state.lastAlertAt) >= REALERT_INTERVAL_MS
  if ((dueByStreak && dueByTime) || !stateReadable) {
    try {
      await sendDrivePollerDownAlert(error, state.consecutiveFailures, state.firstFailureAt, inFlight)
      state.alertedThisStreak = true
      state.lastAlertAt = new Date().toISOString()
      console.log(`Sent poller-down alert (${state.consecutiveFailures} consecutive failures)`)
    } catch (alertError) {
      console.error('Failed to send poller-down alert:', alertError)
    }
  } else {
    console.log(`Poll failure ${state.consecutiveFailures} of ${CONSECUTIVE_FAILURES_BEFORE_ALERT} before ops alert — next poll retries automatically`)
  }

  if (stateReadable) {
    try {
      await saveOpsState(state)
    } catch (stateError) {
      console.error('Failed to persist ops failure streak:', stateError)
    }
  }
}

// Called at the end of every successful poll (including idle ones). Cheap:
// one small S3 GET; writes only when there was a streak to clear.
export async function recordPollSuccess(): Promise<void> {
  try {
    const state = await loadOpsState()
    if (!state || state.consecutiveFailures === 0) return
    if (state.alertedThisStreak) {
      await sendDrivePollerRecoveredAlert(state.consecutiveFailures, state.firstFailureAt).catch(alertError => console.error('Failed to send recovery alert:', alertError))
    } else {
      console.log(`Poll recovered after ${state.consecutiveFailures} failure(s) — below alert threshold, no email was sent`)
    }
    await saveOpsState({ consecutiveFailures: 0, firstFailureAt: '', alertedThisStreak: false, lastAlertAt: state.lastAlertAt })
  } catch (stateError) {
    console.warn('Could not check/reset ops failure streak (non-fatal):', stateError)
  }
}
