// Scheduled poller for the shared "Decentered Uploads" Drive folder — the
// non-email ingestion path. EventBridge fires this every 5 minutes;
// reservedConcurrency: 1 guarantees runs never overlap, which is what makes
// the read-modify-write S3 ledger safe.
//
// Failure taxonomy:
//   - transient (download hiccup, GPT timeout, thumbnail not generated yet):
//     leave the file in place; the next poll is the retry. Attempts are
//     PRE-bumped in the ledger before any download/GPT so that even an
//     uncaught crash (Lambda timeout, OOM) counts toward the cap — otherwise
//     a crash loop would reprocess every file at full GPT cost every 5 min.
//   - permanent (dragged-in folder, or MAX_ATTEMPTS exhausted): mark failed
//     in the ledger FIRST, then alert (alertPending retries the alert if the
//     send fails — at-least-once alerting without a 5-minute alert loop).
//
// Drive-side moves to processed/ are best-effort UX only; the ledger is the
// source of truth (Liz owns her uploads and consumer Drive can refuse
// non-owner moves).

import type { ScheduledHandler } from 'aws-lambda'
import { type DriveInboxFailure, sendDriveInboxFailureAlert } from './lib/alert'
import { type InboxFile, type Ledger, downloadInboxImage, listInboxFiles, loadLedger, moveToProcessed, saveLedger, sendThrottledOpsAlert } from './lib/drive-inbox'
import { type Event, normalizeEvent } from './lib/events'
import { extractEvents } from './lib/openai'
import { uploadToS3 } from './lib/s3'
import { addEventsToSpreadsheet } from './lib/sheets'

const MAX_FILES_PER_RUN = 10
const MAX_ATTEMPTS = 3

const driveLink = (file: { id: string; isFolder?: boolean }) => (file.isFolder ? `https://drive.google.com/drive/folders/${file.id}` : `https://drive.google.com/file/d/${file.id}`)

function touch(ledger: Ledger, file: InboxFile): void {
  ledger[file.id] = ledger[file.id] ?? { attempts: 0, name: file.name, updatedAt: '' }
  ledger[file.id].name = file.name
  // Persisted so a pending alert can still build the right kind of Drive
  // link after the file has left the inbox
  ledger[file.id].isFolder = file.isFolder
  ledger[file.id].updatedAt = new Date().toISOString()
}

export const pollDriveInbox: ScheduledHandler = async () => {
  try {
    const ledger = await loadLedger()
    const listed = await listInboxFiles()

    // Prune ledger entries for files no longer in the inbox (moved to
    // processed/, or deleted) — EXCEPT failed entries whose alert is still
    // pending: the alert is owed to a human even if the file was tidied away,
    // and pruning it would silently swallow the failure. Those entries are
    // pruned on a later poll, after the alert finally sends and clears the
    // flag. If a file is ever dragged BACK into the inbox it gets
    // reprocessed — the sheet's sourceTag dedupe absorbs that.
    const listedIds = new Set(listed.map(f => f.id))
    for (const [id, entry] of Object.entries(ledger)) {
      if (!listedIds.has(id) && !(entry.status === 'failed' && entry.alertPending)) delete ledger[id]
    }

    // Alerts that failed to send on a previous run — sourced from the ledger,
    // not the listing, so they survive the file leaving the inbox
    const pendingAlertEntries = Object.entries(ledger).filter(([, entry]) => entry.status === 'failed' && entry.alertPending)

    const unhandled = listed.filter(f => !ledger[f.id]?.status)
    const folders = unhandled.filter(f => f.isFolder)
    const exhausted = unhandled.filter(f => !f.isFolder && (ledger[f.id]?.attempts ?? 0) >= MAX_ATTEMPTS)
    const queue = unhandled.filter(f => !f.isFolder && (ledger[f.id]?.attempts ?? 0) < MAX_ATTEMPTS).slice(0, MAX_FILES_PER_RUN)

    if (!queue.length && !folders.length && !exhausted.length && !pendingAlertEntries.length) {
      console.log(`Drive inbox poll: nothing to do (${listed.length} file(s) listed, all handled)`)
      return
    }

    console.log(`Drive inbox poll: ${queue.length} to process, ${folders.length} folder(s), ${exhausted.length} exhausted, ${pendingAlertEntries.length} pending alert(s)`)

    // Pre-bump attempts BEFORE any download/GPT. If this save fails, abort
    // the whole run: processing without bookkeeping is how unbounded GPT
    // respend happens.
    for (const file of queue) {
      touch(ledger, file)
      ledger[file.id].attempts += 1
    }
    await saveLedger(ledger)

    const eventGroups: Array<{ events: Event[]; s3Url: string; sourceTag: string }> = []
    const succeeded: InboxFile[] = []
    const failedThisRun: Array<{ file: InboxFile; error: unknown }> = []

    await Promise.all(
      queue.map(async file => {
        try {
          console.log(`Processing Drive file: ${file.name} (${file.id}, ${file.mimeType}, ${file.size ?? 'unknown'} bytes)`)
          const { buffer, contentType } = await downloadInboxImage(file)

          // The drive_<fileId>_ prefix survives into the S3 URL (sanitize
          // keeps [A-Za-z0-9_-], which covers Drive file IDs) and is the
          // sheet's exact-dedupe key for this file. Unlike the email path,
          // an S3 upload failure FAILS the file (transient, retried next
          // poll): appending rows with an empty link column would leave the
          // replay-dedupe key permanently absent from the sheet.
          const [s3Url, extracted] = await Promise.all([
            uploadToS3(buffer, `drive_${file.id}_${file.name}`, contentType).then(url => {
              console.log(`Successfully uploaded ${file.name} to S3: ${url}`)
              return url
            }),
            extractEvents(buffer, contentType)
          ])

          console.log(`Extracted ${extracted.events?.length ?? 0} event(s) from ${file.name}`)
          if (extracted.events?.length > 0) {
            eventGroups.push({ events: extracted.events.map(normalizeEvent), s3Url, sourceTag: `drive_${file.id}_` })
          }
          succeeded.push(file)
        } catch (error) {
          console.error(`Failed to process Drive file ${file.name} (${file.id}):`, error)
          failedThisRun.push({ file, error })
        }
      })
    )

    // One batch append: fuzzy dedupe against the sheet + in-batch, plus
    // exact sourceTag dedupe for crash-replays. If this throws, no file is
    // marked processed — the pre-bumped attempts cap the retries.
    if (eventGroups.length) {
      await addEventsToSpreadsheet(eventGroups)
    }

    for (const file of succeeded) {
      touch(ledger, file)
      ledger[file.id].status = 'processed'
    }

    // Permanent failures: folders, files exhausted on earlier runs, and files
    // whose failure this run used up their last attempt
    const permanentFailures: DriveInboxFailure[] = []
    for (const file of folders) {
      touch(ledger, file)
      ledger[file.id].status = 'failed'
      ledger[file.id].alertPending = true
      ledger[file.id].lastError = 'is a folder'
      permanentFailures.push({
        name: file.name,
        link: driveLink(file),
        reason: 'this is a folder — folders are not scanned, please upload the image files directly into the inbox'
      })
    }
    for (const file of exhausted) {
      touch(ledger, file)
      ledger[file.id].status = 'failed'
      ledger[file.id].alertPending = true
      permanentFailures.push({ name: file.name, link: driveLink(file), reason: ledger[file.id].lastError ?? `could not be processed after ${MAX_ATTEMPTS} attempts` })
    }
    for (const { file, error } of failedThisRun) {
      touch(ledger, file)
      const message = error instanceof Error ? error.message : String(error)
      ledger[file.id].lastError = message
      if (ledger[file.id].attempts >= MAX_ATTEMPTS) {
        ledger[file.id].status = 'failed'
        ledger[file.id].alertPending = true
        permanentFailures.push({ name: file.name, link: driveLink(file), reason: `failed ${MAX_ATTEMPTS} times, last error: ${message}` })
      }
    }

    // Persist statuses BEFORE alerting: if the alert send fails, alertPending
    // survives and the next poll retries the alert without reprocessing
    await saveLedger(ledger)

    const alertItems: DriveInboxFailure[] = [
      ...permanentFailures,
      ...pendingAlertEntries.map(([id, entry]) => ({ name: entry.name, link: driveLink({ id, isFolder: entry.isFolder }), reason: entry.lastError ?? 'could not be processed' }))
    ]
    if (alertItems.length) {
      try {
        await sendDriveInboxFailureAlert(alertItems)
        console.log(`Sent failure alert for ${alertItems.length} file(s)`)
        for (const [id, entry] of Object.entries(ledger)) {
          if (entry.status === 'failed' && entry.alertPending) ledger[id].alertPending = false
        }
        await saveLedger(ledger)
      } catch (alertError) {
        console.error('Failed to send failure alert (will retry next poll):', alertError)
      }
    }

    // Best-effort visibility for Liz: move handled files out of the inbox.
    // Individually caught — she owns her uploads and consumer Drive may
    // refuse non-owner moves; the ledger already recorded the outcome.
    await Promise.all(
      succeeded.map(file =>
        moveToProcessed(file.id)
          .then(() => console.log(`Moved ${file.name} to processed/`))
          .catch(moveError => console.warn(`Could not move ${file.name} (${file.id}) to processed/ (non-fatal, ledger has it):`, moveError))
      )
    )

    const retrying = failedThisRun.filter(({ file }) => ledger[file.id]?.status !== 'failed').length
    console.log(`Drive inbox poll complete: ${succeeded.length} processed, ${retrying} retrying, ${permanentFailures.length} failed permanently`)
  } catch (error) {
    console.error('Error polling Drive inbox:', error)
    // Report, don't just contain — but throttled: this fires every 5 minutes
    // when a dependency is down, and 288 emails/day helps nobody
    try {
      await sendThrottledOpsAlert(error, 'pollDriveInbox top-level catch')
    } catch (alertError) {
      console.error('Failed to send ops alert:', alertError)
    }
  }
}
