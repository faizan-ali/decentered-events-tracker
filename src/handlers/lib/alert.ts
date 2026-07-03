import { Inbound } from 'inboundemail'

// Transport-neutral view of an email, so alerts work for both the inbound.new
// webhook handler and the SES handler
export interface AlertEmailInfo {
  from: string
  subject: string
  receivedAt: string
  textBody: string
  htmlBody: string | null
}

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
export async function sendFailureAlert(email: AlertEmailInfo, reasons: string[], to: string[] = ALERT_TO): Promise<void> {
  const from = email.from || 'unknown'
  const subject = email.subject || '(no subject)'
  const receivedAt = email.receivedAt
  const textBody = email.textBody

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
    ${email.htmlBody ?? `<pre>${escapeHtml(textBody)}</pre>`}
  `

  await client.emails.send({
    from: ALERT_FROM,
    to,
    subject: `[decentered] Flyer parse failed — ${reasons.length} image(s) from ${from}`,
    text,
    html
  })
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
    note: 'Looks transient (network/rate limit). The 500 response makes inbound.new redeliver — if this alert does not repeat, the retry succeeded and no action is needed.'
  }
]

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
  // Classify on the message only — stack traces contain arbitrary paths and
  // line numbers that false-positive against patterns like /429/
  const message = error instanceof Error ? error.message : String(error)
  const matched = KNOWN_ISSUES.filter(issue => issue.pattern.test(message))
  const diagnosis = matched.length ? matched.map(issue => `Possible known issue: ${issue.note}`).join('\n\n') : UNKNOWN_CHECKLIST

  await client.emails.send({
    from: ALERT_FROM,
    to: OPS_ALERT_TO,
    subject: `[decentered] Handler error — ${context}`,
    text: [
      `Unhandled error in parseInboundEmail (${context}). An inbound email may have been dropped.`,
      '',
      diagnosis,
      '',
      detail,
      '',
      'The webhook returned 500, so inbound.new may redeliver; repeated identical alerts mean the retries are failing too.',
      'Debug: aws logs tail /aws/lambda/events-parser-dev-parseInboundEmail --region us-west-1 --since 1h --format short'
    ].join('\n')
  })
}
