import { Inbound } from 'inboundemail'
import type { InboundWebhookEmail } from 'inboundemail'
import { withTimeout } from './timeout'

const INBOUND_API_KEY = process.env.INBOUND_API_KEY
const ALERT_FROM = process.env.ALERT_EMAIL_FROM ?? 'alerts@proteus.tools'
// Comma-separated list; defaults to Faizan + Liz so the sender can re-share/re-send.
const ALERT_TO = (process.env.ALERT_EMAIL_TO ?? 'faizanali619@gmail.com,liz@decentered.org')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

// Unanticipated handler errors go to the maintainer only — they're engineering
// faults, nothing the email sender can act on.
const OPS_ALERT_TO = (process.env.ALERT_OPS_EMAIL_TO ?? 'faizanali619@gmail.com')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const client = new Inbound({ apiKey: INBOUND_API_KEY })

const escapeHtml = (s: string) => s.replace(/[&<>]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))

// Sent when an inbound email contained flyer images we could not process
// (e.g. private Google Drive links that require sign-in). Without this, such
// emails return HTTP 200 and are silently dropped with no retry. The alert
// forwards the original email so a human can re-share or re-send the flyers.
export async function sendFailureAlert(email: InboundWebhookEmail, reasons: string[], to: string[] = ALERT_TO): Promise<void> {
  // parsedData/from can be null on minimal payloads (provider-side parse failure)
  const from = email.parsedData?.from?.text ?? email.from?.text ?? 'unknown'
  const subject = email.subject || '(no subject)'
  const receivedAt = email.receivedAt ?? ''
  const textBody = email.parsedData?.textBody ?? ''

  const reasonList = reasons.map(r => `  - ${r}`).join('\n')

  const text = [
    'An inbound event email could not be fully processed — some flyers were not added to the spreadsheet.',
    '',
    `From:    ${from}`,
    `Subject: ${subject}`,
    `Received: ${receivedAt}`,
    '',
    `Unprocessed images (${reasons.length}):`,
    reasonList,
    '',
    'Most often this happens when flyers are shared as Google Drive links that are',
    'not public ("Sign in required"). To fix: attach the images directly, or set the',
    'Drive files to "Anyone with the link" and re-send.',
    '',
    '--- Original message ---',
    textBody
  ].join('\n')

  const html = `
    <p>An inbound event email could not be fully processed — some flyers were <b>not added to the spreadsheet</b>.</p>
    <p><b>From:</b> ${escapeHtml(from)}<br>
    <b>Subject:</b> ${escapeHtml(subject)}<br>
    <b>Received:</b> ${escapeHtml(receivedAt)}</p>
    <p><b>Unprocessed images (${reasons.length}):</b></p>
    <ul>${reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
    <p>Most often this happens when flyers are shared as Google Drive links that are not public
    ("Sign in required"). To fix: attach the images directly, or set the Drive files to
    "Anyone with the link" and re-send.</p>
    <hr>
    <p><b>Original message:</b></p>
    ${email.parsedData?.htmlBody ?? `<pre>${escapeHtml(textBody)}</pre>`}
  `

  await client.emails.send({
    from: ALERT_FROM,
    to,
    subject: `[decentered] Flyer parse failed — ${reasons.length} image(s) from ${from}`,
    text,
    html
  })
}

export interface DriveInboxFailure {
  name: string
  link: string
  reason: string
}

// Sent when files dropped into the shared Drive inbox folder could not be
// processed after retries (or are unprocessable, e.g. a dragged-in folder).
// Failed files stay in the inbox; the fix is always "re-upload a fresh copy" —
// we deliberately do NOT tell people to rename/edit the failed file, because
// processing state lives in our ledger, not in the file.
export async function sendDriveInboxFailureAlert(failures: DriveInboxFailure[], to: string[] = ALERT_TO): Promise<void> {
  const reasonList = failures.map(f => `  - ${f.name}: ${f.reason}\n    ${f.link}`).join('\n')

  const text = [
    `${failures.length} file(s) in the Decentered Uploads folder could not be processed — their events were not added to the spreadsheet.`,
    '',
    reasonList,
    '',
    'To retry: fix the issue and upload a fresh copy of the file to the folder.',
    'Tips: upload image files (screenshots, photos, PNG/JPEG) or one-page PDF flyers directly into',
    'the folder — not inside a subfolder. Files that were processed successfully usually move to "processed".'
  ].join('\n')

  const html = `
    <p><b>${failures.length} file(s)</b> in the Decentered Uploads folder could not be processed — their events were <b>not added to the spreadsheet</b>.</p>
    <ul>${failures.map(f => `<li><a href="${escapeHtml(f.link)}">${escapeHtml(f.name)}</a>: ${escapeHtml(f.reason)}</li>`).join('')}</ul>
    <p>To retry: fix the issue and upload a fresh copy of the file to the folder.</p>
    <p>Tips: upload image files (screenshots, photos, PNG/JPEG) or one-page PDF flyers directly into
    the folder — not inside a subfolder. Files that were processed successfully usually move to "processed".</p>
  `

  // Bounded: on the scheduled Drive-inbox path there is no API Gateway
  // ceiling backstopping a hung inbound.new call, and an unbounded send here
  // would block the ledger save that clears alertPending (duplicate alerts)
  await withTimeout(
    client.emails.send({
      from: ALERT_FROM,
      to,
      subject: `[decentered] Drive upload failed — ${failures.length} file(s) could not be processed`,
      text,
      html
    }),
    15_000,
    'Drive inbox failure alert send'
  )
}

// Deterministic signature matching against known failure modes — deliberately
// NOT an LLM: the alert path must not depend on the services it reports on,
// and confidently misclassifying a novel error would be worse than a raw trace.
// Full write-ups live in CLAUDE.md → Troubleshooting.
const KNOWN_ISSUES: Array<{ pattern: RegExp; note: string }> = [
  {
    pattern: /Cannot read properties of null|parsedData|inbnd_minimal_/i,
    note: 'Resembles the minimal-payload issue (CLAUDE.md Troubleshooting §5): inbound.new failed to ingest the email (usually oversized) and sent a stub webhook with null fields. Content is unrecoverable; the sender must re-send smaller.'
  },
  {
    pattern: /not a public image|drive\.google\.com/i,
    note: 'Resembles the Drive-link issue (CLAUDE.md Troubleshooting §4): flyers shared as private Google Drive links instead of attachments. Sender must attach images or set files to "Anyone with the link".'
  },
  {
    pattern: /timeout|aborted|ETIMEDOUT|ECONNRESET|429|rate limit/i,
    note: 'Looks transient (network/rate limit). Retries happen automatically — webhook path: inbound.new redelivers on the 500; Drive path: the next 5-minute poll retries. Only repeated alerts need action.'
  }
]

export function classifyError(error: unknown): string {
  // Classify on the message only — stack traces contain arbitrary paths and
  // line numbers that false-positive against patterns like /429/
  const message = error instanceof Error ? error.message : String(error)
  const matched = KNOWN_ISSUES.filter(issue => issue.pattern.test(message))
  return matched.length ? matched.map(issue => `Possible known issue: ${issue.note}`).join('\n\n') : UNKNOWN_CHECKLIST
}

const UNKNOWN_CHECKLIST = [
  'No known failure mode matched. Quick checklist:',
  '  1. Is it a new inbound.new payload variant? (fields the SDK types claim are non-null arriving null)',
  '  2. Did the email exist provider-side? Retrieve it: curl -H "Authorization: Bearer $INBOUND_API_KEY" https://inbound.new/api/e2/emails/<X-Email-ID>',
  '  3. Full playbook: CLAUDE.md → Troubleshooting'
].join('\n')

// Last-resort alert from the top-level catch. Anticipated failure modes alert
// via sendFailureAlert above; this exists because the failure you didn't
// anticipate is exactly the one that bypasses those call sites (July 2026:
// a null-from payload crashed the handler upstream of every alert, and the
// catch block's console.error was the only trace).
export async function sendOpsAlert(error: unknown, context: string): Promise<void> {
  const detail = error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error)
  const diagnosis = classifyError(error)

  // Bounded for the same reason as the Drive-inbox alert: the scheduled path
  // has no external ceiling, and this is called from catch blocks where a
  // hang would eat the rest of the Lambda budget
  await withTimeout(
    client.emails.send({
      from: ALERT_FROM,
      to: OPS_ALERT_TO,
      subject: `[decentered] Handler error — ${context}`,
      text: [
        `Unhandled error (${context}). An inbound email or Drive upload may have been dropped.`,
        '',
        diagnosis,
        '',
        detail,
        '',
        'Webhook-path errors return 500 so inbound.new may redeliver; Drive-path errors retry on the next 5-minute poll. Repeated identical alerts mean the retries are failing too.',
        'Debug: aws logs tail /aws/lambda/events-parser-dev-parseInboundEmail --region us-west-1 --since 1h --format short',
        '       aws logs tail /aws/lambda/events-parser-dev-pollDriveInbox --region us-west-1 --since 1h --format short'
      ].join('\n')
    }),
    15_000,
    'Ops alert send'
  )
}

export interface InFlightFile {
  name: string
  attempts: number
}

// Sent only after the Drive poller has failed several CONSECUTIVE polls — a
// single failed poll is not an incident (the next tick retries it) and is
// deliberately not emailed. Pair: sendDrivePollerRecoveredAlert closes the
// loop when polls succeed again.
export async function sendDrivePollerDownAlert(error: unknown, consecutiveFailures: number, firstFailureAt: string, inFlight: InFlightFile[]): Promise<void> {
  const detail = error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error)
  const downMinutes = Math.round((Date.now() - Date.parse(firstFailureAt)) / 60000)
  const inFlightList = inFlight.length
    ? inFlight.map(f => `  - ${f.name} (attempt ${f.attempts} of 3)`).join('\n')
    : '  (none were mid-processing — the failure is in listing/setup, not a specific file)'

  await withTimeout(
    client.emails.send({
      from: ALERT_FROM,
      to: OPS_ALERT_TO,
      subject: `[decentered] Drive poller DOWN — ${consecutiveFailures} consecutive failed polls (~${downMinutes} min)`,
      text: [
        `The Drive inbox poller has failed ${consecutiveFailures} polls in a row since ${firstFailureAt} (~${downMinutes} minutes).`,
        'Single failures are retried silently; this many in a row means a dependency is genuinely down.',
        '',
        classifyError(error),
        '',
        `Files in flight on the latest attempt:`,
        inFlightList,
        '',
        'What happens automatically: every 5 minutes the poller retries. Files alert Liz after 3 failed processing attempts',
        '— but attempts consumed by infrastructure failures like this may burn those, so after recovery, check whether any',
        'files were marked failed and clear their ledger entries to reprocess.',
        'A recovery email will follow when polls succeed again. If this repeats every 6h, nobody has fixed it.',
        '',
        '--- Latest error ---',
        detail,
        '',
        'Debug: aws logs tail /aws/lambda/events-parser-dev-pollDriveInbox --region us-west-1 --since 3h --format short',
        'Ledger: aws s3 cp s3://$S3_BUCKET/drive-inbox/state.json - --region us-west-1'
      ].join('\n')
    }),
    15_000,
    'Drive poller down alert send'
  )
}

export async function sendDrivePollerRecoveredAlert(consecutiveFailures: number, firstFailureAt: string): Promise<void> {
  const downMinutes = Math.round((Date.now() - Date.parse(firstFailureAt)) / 60000)
  await withTimeout(
    client.emails.send({
      from: ALERT_FROM,
      to: OPS_ALERT_TO,
      subject: `[decentered] Drive poller recovered after ${consecutiveFailures} failed polls (~${downMinutes} min)`,
      text: [
        `The Drive inbox poller is healthy again after ${consecutiveFailures} consecutive failures starting ${firstFailureAt}.`,
        '',
        'Follow-up: check the ledger for files whose attempts were exhausted during the outage (status "failed") —',
        'those alerted Liz to re-upload, but if the files were fine and only the infrastructure was down, deleting',
        'their ledger entries reprocesses them without her doing anything.',
        'Ledger: aws s3 cp s3://$S3_BUCKET/drive-inbox/state.json - --region us-west-1'
      ].join('\n')
    }),
    15_000,
    'Drive poller recovery alert send'
  )
}
