# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DecenteredArts Events Extractor - A serverless application that ingests event flyers/screenshots, uses GPT-5.4 vision to extract event details, and populates a Google Sheets tracker. Two ingestion paths feed one shared extraction pipeline:

**Path 1 — Email:** Email with image → inbound.new webhook → API Gateway → Lambda (`inbound.ts`) → download attachment → shared pipeline
**Path 2 — Drive inbox (primary since July 2026):** Liz drops files in the shared "Decentered Uploads" Drive folder → EventBridge schedule (5 min) → Lambda (`drive-inbox.ts`) → download via Drive API → shared pipeline
**Shared pipeline:** S3 archival + GPT-5.4 vision extraction → normalize → dedupe against sheet → append to Google Sheets

### Key Files (index)
- `src/handlers/inbound.ts` — email-path Lambda handler (`parseInboundEmail`)
- `src/handlers/drive-inbox.ts` — Drive-path scheduled Lambda handler (`pollDriveInbox`): orchestration, ledger state machine, failure taxonomy
- `src/handlers/lib/drive-inbox.ts` — Drive API client, S3 ledger load/save, thumbnail-first downloads, throttled ops alerts
- `src/handlers/lib/drive.ts` — email-path Drive-LINK extraction (public thumbnail scrape; distinct from drive-inbox.ts) + `isImageBuffer` magic-byte check
- `src/handlers/lib/openai.ts` — GPT-5.4 vision extraction (bounded client; injects today's Pacific date into the prompt)
- `src/handlers/lib/prompt.ts` — `buildPrompt(today)`: extraction instructions incl. relative-date resolution ("TODAY 8PM" screenshots)
- `src/handlers/lib/events.ts` — normalization (fills missing end times, cross-fills days)
- `src/handlers/lib/sheets.ts` — fuzzy dedupe (Dice bigrams ≥0.75 on title/address + exact date) + exact `sourceTag` replay dedupe + append
- `src/handlers/lib/s3.ts` — image archival (the S3 URL becomes the sheet's link column — and the Drive path's dedupe key)
- `src/handlers/lib/alert.ts` — all email alerts via inbound.new: `sendFailureAlert` (email path, → Liz), `sendDriveInboxFailureAlert` (Drive path, → Liz), `sendOpsAlert` (→ maintainer)
- `src/handlers/lib/timeout.ts` — `withTimeout` for SDKs with no native timeout knob
- `serverless.ts` — stack config: both functions, IAM, CloudWatch alarms + SNS

## Common Commands

```bash
# Development
pnpm dev                    # Start local server with hot reload (serverless offline)
pnpm check                  # TypeScript type checking
pnpm lint                   # Lint and format with Biome (auto-fix)

# Testing (vitest, tests live next to source as *.test.ts)
pnpm test                   # Run all tests once
pnpm test:watch             # Run tests in watch mode
pnpm vitest run src/handlers/lib/events.test.ts  # Run a single test file

# Deployment
pnpm deploy:prod            # Deploy to AWS Lambda (deploys to us-west-1)

# Test deployed Lambda end-to-end (get URL from `pnpm deploy:prod` output)
curl -X POST -H "Content-Type: application/json" \
  -d '{"event":"email.received","timestamp":"...","email":{...},"endpoint":{...}}' \
  "<API_GATEWAY_URL>/dev/parse-inbound-email"

# Drive inbox: watch runs / inspect state
aws logs tail /aws/lambda/events-parser-dev-pollDriveInbox --region us-west-1 --since 1h --format short
aws s3 cp s3://$S3_BUCKET/drive-inbox/state.json - --region us-west-1   # the ledger (source of truth)
aws cloudwatch describe-alarms --alarm-name-prefix decentered --region us-west-1 --query 'MetricAlarms[].{Name:AlarmName,State:StateValue}' --output table

# Alert archive: every alert email is also written to S3 at send time (keys
# sort chronologically) — read these instead of asking anyone to paste emails
aws s3 ls s3://$S3_BUCKET/alerts/ --region us-west-1
aws s3 cp s3://$S3_BUCKET/alerts/<key> - --region us-west-1

# Run the Drive poller locally against real services (careful: writes to the
# real sheet/ledger and sends real alerts — override ALERT_EMAIL_TO and
# ALERT_OPS_EMAIL_TO to yourself first)
set -a && source .env && set +a && export ALERT_EMAIL_TO=<you> ALERT_OPS_EMAIL_TO=<you> \
  && pnpm tsx -e "" # then: import { pollDriveInbox } from './src/handlers/drive-inbox' in a temp script (tsx -e cannot top-level await)
```

## Architecture

### Entry Point
`src/handlers/inbound.ts:parseInboundEmail` - Lambda handler for POST `/parse-inbound-email`

### Processing Flow
1. Receive JSON webhook from inbound.new (`InboundWebhookPayload`)
2. Filter for image attachments (`contentType.startsWith('image/')`)
3. For each image attachment (in parallel):
   - Download binary from `attachment.downloadUrl` with Bearer auth
   - Upload to S3 fire-and-forget (`lib/s3.ts`)
   - Extract events via GPT-5.4 vision (`lib/openai.ts` using prompt from `lib/prompt.ts`)
   - Normalize event data (`lib/events.ts`) — fills missing end times (start + 3h), cross-fills missing start/end days
4. Deduplicate against existing sheet rows by title + date + address (`lib/sheets.ts`)
5. Append only new events to Google Sheets (`lib/sheets.ts`)

### Key Data Structure
Events have: title, address, location (SF/Oakland/Berkeley/Other), type (from fixed list), startDay/endDay (YYYY-MM-DD), startTime/endTime (HH:mm), description, cost

### Infrastructure
- **Region:** us-west-1
- **Lambda:** `events-parser-dev-parseInboundEmail`
- **API Gateway timeout:** 29s (hard AWS limit) — GPT-5.4 typically responds in 11-15s
- **S3 bucket:** set via `S3_BUCKET` env var (us-west-1). Prefixes: `images/` (public flyer archive, linked from the sheet), `drive-inbox/` (poller state — private)
- **Spreadsheet:** ~6,900 existing rows; dedupe fetches columns A:J before appending (J = link column, carries the Drive path's exact-dedupe key)
- **API Gateway:** `https://pek82om27g.execute-api.us-west-1.amazonaws.com/dev/parse-inbound-email`
- **Logs:** `aws logs tail /aws/lambda/events-parser-dev-parseInboundEmail --region us-west-1 --since 1h --format short`
- **Inbound email:** inbound.new — email at `events.proteus.tools`, webhook posts JSON with attachment download URLs

### Important Constraints
- API Gateway has a hard 29s timeout. GPT-4o was too slow (~31s), which is why we use GPT-5.4 (~13s). Do not switch back to GPT-4o.
- inbound.new retries failed webhooks with exponential backoff. Dedupe logic prevents duplicate rows from retries.
- Images can be flyers, social media screenshots (LinkedIn, Instagram), posters, etc. — the prompt must handle all formats.
- The prompt in `lib/prompt.ts` must explicitly instruct the model to extract ALL events from images with multiple events (e.g. workshop series). Without this, the model may collapse them into one.
- Attachments are not inline in the webhook — they must be downloaded via `downloadUrl` with `Authorization: Bearer` header.

### Drive inbox (non-email ingestion path, July 2026)
Liz drops flyer files into the shared Drive folder **"Decentered Uploads"** (`DRIVE_INBOX_FOLDER_ID`) instead of emailing them. `pollDriveInbox` (`src/handlers/drive-inbox.ts`) runs every 5 minutes via EventBridge (120s timeout — no API Gateway ceiling) and feeds the same lib pipeline.
- **Auth:** the folder is shared (Editor) with the same service account used for Sheets; scope `https://www.googleapis.com/auth/drive`. The Drive API is enabled on the GCP project (it wasn't until July 2026 — a 403 "Drive API has not been used" means it got disabled again).
- **Source of truth is the S3 ledger** (`s3://$S3_BUCKET/drive-inbox/state.json`), NOT Drive state: Liz owns the files she uploads and consumer Drive can refuse non-owner metadata writes/moves. Moving files to `processed/` is best-effort UX only. `reservedConcurrency: 1` + rate(5m) > timeout(120s) is what makes the read-modify-write ledger safe — do not weaken either without revisiting.
- **Attempts are PRE-bumped** in the ledger before any download/GPT call so crashes (timeout, OOM) still count toward the 3-attempt cap. If the pre-bump save fails, the run aborts — processing without bookkeeping is unbounded GPT respend. Max 10 files per run.
- **Downloads are thumbnail-first** (authenticated `thumbnailLink` rewritten to `=s2000`): Drive transcodes HEIC and renders PDF page 1, so those formats work without native deps. Raw `alt=media` only for OpenAI-native formats ≤15MB when no thumbnail exists yet (generation lags upload — that error is transient by design). Never trust HTTP 200 alone; magic-byte check everything.
- **Exact crash-replay dedupe:** the S3 key embeds `drive_<fileId>_`, and `addEventsToSpreadsheet` skips any group whose `sourceTag` appears in an existing row's link column (fuzzy dedupe provably leaks: date-less events bypass it, and GPT re-extraction drifts). Three things protect this guarantee — do not weaken them: (1) a failed dedupe read-back THROWS when any group carries a sourceTag (email path stays fail-open for availability); (2) an S3 upload failure FAILS the file as transient rather than appending rows with an empty link column (the link IS the dedupe key); (3) the read-back includes rows whose date+title are empty but link is not.
- **IAM requires `s3:ListBucket` on the bucket** — without it, GetObject on the missing `drive-inbox/state.json` returns 403 AccessDenied instead of 404 NoSuchKey and first-run bootstrap bricks the poller. `loadLedger` throws a diagnostic error for this case rather than guessing empty (guessing would reset attempts → unbounded GPT respend if the ledger exists but GET is denied).
- **Failure taxonomy:** transient errors retry naturally next poll (no state change beyond attempts); permanent (folder dragged in, attempts exhausted) → mark `failed` + `alertPending` in ledger FIRST, then alert Liz (`sendDriveInboxFailureAlert`), then clear the flag — at-least-once alerting with no 5-minute alert loop. Ledger pruning preserves `failed`+`alertPending` entries even after the file leaves the inbox (the alert is owed to a human; pending alerts are sourced from the ledger, not the listing). Failed files deliberately stay in the inbox; the fix is always "upload a fresh copy" (a file edited in place after processing is intentionally NOT reprocessed — the ledger keys on fileId).
- **Dedupe fallback cache** (`s3://$S3_BUCKET/drive-inbox/dedupe-cache.json`): the sheet is ALWAYS read fresh per append (manual sheet edits respected) and the normalized index is written back to S3 on every successful read and after every append. When the sheet read fails (Sheets tail latency), the cache — at most minutes stale, hard 24h cap — is used instead of aborting (Drive path) or going dedupe-blind (email path). The post-append cache update is what keeps sourceTag replay protection alive when a crash-replay's read also fails.
- **Ops alerts fire on PERSISTENCE, not occurrence** (`drive-inbox/ops-state.json`): a single failed poll emails nobody — the next tick is the retry. Three consecutive failures (~15 min, matching the CloudWatch alarm) send one rich email (streak length, in-flight files + attempts, what happens automatically); re-alerts capped at one per 6h; a recovery email closes the loop when polls succeed again. Fail-open: if the streak state itself is unreadable, alert immediately. `recordPollSuccess()` must be called on every successful run — including idle ones — or streaks never clear.
- **Watcher-independent alarms** (CloudFormation resources in `serverless.ts`, SNS topic `decentered-ops-alarms` → Faizan's email): Lambda crash alarms for both functions, a log-metric-filter alarm on the poller's top-level catch (fires even when inbound.new — the in-code alert channel — is what's down), and a heartbeat alarm (poller <6 invocations/hour, missing data = breaching). The in-code email alerts ride on inbound.new and go silent exactly when it fails; these don't.
- **Every alert email is also archived to `s3://$S3_BUCKET/alerts/<ISO-ts>_<kind>.json` BEFORE sending** (`lib/alert-archive.ts`) — look alerts up there instead of asking a human to paste emails, and note the archive survives inbound.new outages. Kinds: `flyer-parse-failed`, `drive-upload-failed`, `handler-error`, `drive-poller-down`, `drive-poller-recovered`.
- **Logs:** `aws logs tail /aws/lambda/events-parser-dev-pollDriveInbox --region us-west-1 --since 1h --format short`
- Grep-able outcome line per run: `Drive inbox poll complete: X processed, Y retrying, Z failed permanently` (or `nothing to do`).

### Current status & parked work (July 2026)
- The Drive inbox is the PRIMARY path: since its launch (July 4 2026) the email path has received ~zero traffic — treat email as the fallback, but keep it working.
- Healthy-day baseline for eyeballing regressions: the poller runs exactly 288×/day (12/hour heartbeat), idle ticks ~250-350ms at ~470MB; a 6-file batch (downloads + parallel GPT + dedupe against ~7k rows + appends + moves) ~11s. The webhook path's GPT calls run 3-7s/image.
- **Parked branch `ses-migration`** (local, unpushed as of July 2026): a complete, E2E-verified SES-native email receiving stack on `ses.proteus.tools` that bypasses inbound.new's ~28MB ingestion ceiling (raw MIME → S3 → us-west-2 Lambda, no API Gateway). Built before the Drive inbox existed; deprioritized once Drive became primary since large batches no longer flow through email. If revived: it forked from `c250c42` and also touches `alert.ts` + CLAUDE.md, so it needs a careful rebase; its CLAUDE.md documents an MX-cutover runbook where ORDER MATTERS (receipt-rule recipients BEFORE the MX flip).

### Environment Variables
Required in `.env`: `OPENAI_API_KEY`, `GOOGLE_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `S3_BUCKET`, `REGION`, `INBOUND_API_KEY`, `DRIVE_INBOX_FOLDER_ID`, `DRIVE_PROCESSED_FOLDER_ID`
Note: webhook requests are NOT authenticated (decision July 2026: not needed). inbound.new does send `X-Webhook-Verification-Token` if this is ever revisited.
Optional (have code defaults in `lib/alert.ts`): `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO` (comma-separated)

### Hardening invariants (keep these when editing)
- Every outbound network call is bounded: attachment/Drive fetches use `AbortSignal.timeout(8000)`; the OpenAI client is constructed with `timeout: 20_000, maxRetries: 0`. Unbounded calls blow the 29s API Gateway budget → 504 → inbound.new redelivers → double GPT spend.
- Drive-link extraction strips Gmail quoted history (`<blockquote>`, `gmail_quote` div, `> ` lines, "On … wrote:") — otherwise old links in a thread get refetched and re-alerted on every reply.
- Dedupe in `sheets.ts` checks the sheet AND the in-flight batch (same event on two flyers in one email).
- Treat inbound.new payload fields as nullable regardless of SDK types (`from`, `parsedData`, `attachments`, `contentType` have all been observed null/absent).
- The top-level catch must alert, not just log (`sendOpsAlert` → maintainer only). Anticipated failures alert via `sendFailureAlert` (→ sender-actionable, goes to Liz too); the unanticipated ones bypass those call sites by definition — the catch block is the only alert that catches unknown unknowns.

## Troubleshooting: "an email failed to parse"

Debugging playbook, in order:

1. **Survey outcomes over the window** — every invocation logs exactly one of these lines; anything else means a crash/timeout:
   ```bash
   aws logs tail /aws/lambda/events-parser-dev-parseInboundEmail --region us-west-1 --since 7d --format short \
     | grep -iE "Task timed out|Received email from|No image attachments|Successfully processed|Failed to process|Error parsing|Sent failure alert|Failed to send failure alert"
   ```
   "No image attachments" with a 200 is the historical silent-failure mode (see step 4).

2. **Get the inbound email ID for a suspect invocation.** The full webhook headers (including `X-Email-ID: inbnd_…`) are in the multiline "Received event:" dump, which `aws logs tail | grep <requestId>` does NOT capture (grep only matches the first line). Use `filter-log-events` with a ±few-second epoch-ms window around the invocation instead, then regex for `inbnd_[0-9a-f]+`.

3. **Retrieve the stored email from inbound.new** (it keeps full copies):
   ```bash
   curl -s -H "Authorization: Bearer $INBOUND_API_KEY" "https://inbound.new/api/e2/emails/<inbnd_id>"
   ```
   Inspect `attachments`, `html`, `text`. API quirks: the list endpoint `/api/e2/emails` 500s on `limit>~50`, `offset`, and `type` params — retrieve by ID instead.

4. **Known failure mode — Drive links instead of attachments:** Liz sometimes shares flyers via Gmail "Insert files using Drive → as link". Then `attachments` is empty and the flyer URLs are `drive.google.com/file/d/<ID>` links in the body. `lib/drive.ts` handles these, BUT private Drive files return HTTP 200 with an HTML "Sign in - Google Accounts" page (~940KB) from the thumbnail endpoint — never trust status 200 alone; check magic bytes. Private files are unrecoverable programmatically; the failure alert asks the sender to re-share.

5. **Known failure mode — provider-side ingestion failure (minimal payloads), REPRODUCED July 3 2026:** inbound.new fails to ingest large emails — confirmed empirically by sending a 31MB MIME message (3×7.7MB PNGs) via raw SMTP to the MX; it reliably produces a `status: "failed"` stub and an `inbnd_minimal_…` webhook. The ceiling sits between ~28MB (largest observed success) and AWS SES's 40MB hard cap (bigger emails get a `552` bounce and never arrive). Pipeline: MX = SES inbound (us-east-2) → inbound.new parser on Vercel (their send API 413s `FUNCTION_PAYLOAD_TOO_LARGE`). Undocumented; their status page shows green throughout.
   **Payload-shape trap:** the minimal payload's `parsedData` can be PRESENT but empty with only `from` null — a `!parsedData` guard silently falls through to "No image attachments" (this bug shipped for a day). Detect via `email.id.startsWith('inbnd_minimal_')`. The content is unrecoverable; sender must re-send (keep attachments under ~20MB total). When regexing logs for email IDs, use `inbnd_[a-z_0-9]+` — bare hex misses the `minimal_` infix. The `inboundemail` SDK types don't model this variant; never trust them as ground truth.
   **Repro harness:** generate valid noise PNGs (Python, zlib level 0), send via `smtplib` to `inbound-smtp.us-east-2.amazonaws.com:25` from `repro-test@proteus.tools`. Redirect `ALERT_EMAIL_TO` on the Lambda to Faizan-only first so Liz doesn't get test alerts, and restore after — note `serverless deploy` does NOT necessarily revert manual env drift (CloudFormation skips unchanged template sections), so verify recipients after any test.

6. **Check whether the failure alert fired** — grep logs for "Sent failure alert" / "Failed to send failure alert". Alerts send via inbound.new from `alerts@proteus.tools` to `ALERT_EMAIL_TO`. Note alerts only fire on download/processing *exceptions*, not on "model extracted 0 events".

7. **Reproduce a Drive fetch locally:**
   ```bash
   curl -sL -o /tmp/t.bin -w "%{http_code} %{content_type}\n" "https://drive.google.com/thumbnail?id=<FILE_ID>&sz=w2000" && file /tmp/t.bin
   ```
   Caution: results are misleadingly stateful — a file can appear public because a prior authenticated fetch warmed it. Verify from a clean client before concluding shareability.

## Troubleshooting: "a Drive upload didn't make it to the sheet"

Debugging playbook, in order:

1. **Survey outcomes** — every poll logs exactly one outcome line; anything else means a crash/timeout:
   ```bash
   aws logs tail /aws/lambda/events-parser-dev-pollDriveInbox --region us-west-1 --since 1d --format short \
     | grep -E "poll complete|nothing to do|Error polling|Task timed out"
   ```
   Shape: `Drive inbox poll complete: X processed, Y retrying, Z failed permanently`.

2. **Inspect the ledger** (the source of truth — Drive folder state is only best-effort UX):
   ```bash
   aws s3 cp s3://$S3_BUCKET/drive-inbox/state.json - --region us-west-1
   ```
   Per file: `attempts` (pre-bumped, capped at 3), `status` (`processed`/`failed`/absent = in-flight), `alertPending`, `lastError`. No entry for a file that's in the folder = not yet seen OR pruned after leaving the inbox.

3. **Map symptom → cause:**
   - *File stuck in inbox, no ledger entry, no log line*: poller not running — check the heartbeat alarm and `aws events list-rules --region us-west-1 | grep -i drive`.
   - *File stuck in inbox but ledger says `processed`*: the row IS in the sheet; only the best-effort move failed (expected for Liz-owned files sometimes — non-owner moves can 403). Cosmetic.
   - *`attempts` climbing with `lastError: "No usable thumbnail…"`*: Drive hasn't generated a thumbnail (lags upload — normally resolves in 1-2 polls) or never will (junk/unsupported file → alert after 3 attempts).
   - *Row appended but date column empty*: the image had no resolvable date. The prompt is anchored with today's Pacific date so "TODAY 8PM" screenshots resolve — if dates are systematically empty, check `buildPrompt` is receiving the date.
   - *File in `processed/` but no row*: GPT extracted 0 events — this is treated as SUCCESS (no alert, by design; plenty of images legitimately contain no events). Check the archived image in S3 (`images/<ts>_drive_<fileId>_<name>`) to judge whether extraction should have found something.
   - *`Error polling Drive inbox` every tick*: dependency down. `403 Drive API has not been used` = API disabled on the GCP project; `Ledger GET AccessDenied` = role lost `s3:ListBucket` (see hardening invariants); Sheets errors surface here only when BOTH the sheet read and the dedupe cache fallback are unavailable (a lone Sheets timeout logs `falling back to cached index` and the run proceeds).
   - *Got a "Drive poller DOWN" email*: ≥3 consecutive polls failed (~15+ min) — a real outage, not a blip. After it recovers (recovery email), check the ledger for files whose attempts were burned by the outage (`status: failed`) and delete their entries to reprocess without asking Liz to re-upload.

4. **Alerting expectations:** Liz-actionable failures (3 attempts exhausted, folders dragged in) email her + Faizan once, at-least-once semantics via `alertPending`. Unexpected errors email Faizan only, throttled to 1/6h (S3 marker `drive-inbox/last-ops-alert.json`). CloudWatch alarms (SNS `decentered-ops-alarms`) fire independently of inbound.new: crashes, sustained poll failures, heartbeat.
   **Testing caution:** alert recipients are LIVE (Liz gets failure alerts). For any test that exercises failure paths, override `ALERT_EMAIL_TO`/`ALERT_OPS_EMAIL_TO` on the function first and VERIFY restoration after — CloudFormation does not reliably revert manual env drift.

5. **Empirical Drive API facts (verified July 2026, consumer Google account + service account):**
   - The SA can LIST, DOWNLOAD, and MOVE files owned by others in a folder shared as Editor, but CANNOT TRASH them, and cannot upload/own files (zero storage quota post-Apr 2025). It CAN create folders (they consume no storage).
   - GetObject on a missing S3 key returns 403 AccessDenied (not 404 NoSuchKey) unless the caller has `s3:ListBucket` — this is why the role has it.
   - `thumbnailLink` needs `Authorization: Bearer` for non-public files, is short-lived (hours, never cache), lags upload for fresh files, and comes in `=sNNN` AND `=wNNN-hNNN-p-k-nu` suffix forms. Drive renders thumbnails for images, HEIC, and PDF page 1.
   - `google-auth-library`'s `getAccessToken()` and gaxios calls have NO default timeout; the `inboundemail` client has none either. Every outbound call must be explicitly bounded (`{ timeout }` gaxios option, `AbortSignal.timeout`, or `withTimeout`).

Gotcha log (hard-won): `${env:VAR, "default"}` fallbacks in `serverless.ts` break when the default contains a comma (Serverless splits on it) — keep defaults in code, not serverless config. `tsx -e` cannot use top-level await (CJS transform); wrap in `async function main()`. Lambda runs in UTC: date-only strings parse as UTC midnight, so local-run testing shows off-by-one dates that do NOT reproduce in prod.

## Code Style
- Single quotes, no semicolons, no trailing commas
- Arrow function parens only when needed
- 180 character line width
- Biome handles linting and formatting
