# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DecenteredArts Events Extractor - A serverless application that processes inbound emails containing event flyers/screenshots, uses GPT-5.4 vision to extract event details, and populates a Google Sheets tracker.

**Pipeline:** Email with image → inbound.new webhook → AWS Lambda → download attachment → OpenAI GPT-5.4 Vision → Google Sheets + S3 archival

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
- **S3 bucket:** set via `S3_BUCKET` env var (us-west-1)
- **Spreadsheet:** ~5700 existing rows, dedupe fetches columns A-G before appending
- **API Gateway:** `https://pek82om27g.execute-api.us-west-1.amazonaws.com/dev/parse-inbound-email`
- **Logs:** `aws logs tail /aws/lambda/events-parser-dev-parseInboundEmail --region us-west-1 --since 1h --format short`
- **Inbound email:** inbound.new — email at `events.proteus.tools`, webhook posts JSON with attachment download URLs

### Important Constraints
- API Gateway has a hard 29s timeout. GPT-4o was too slow (~31s), which is why we use GPT-5.4 (~13s). Do not switch back to GPT-4o.
- inbound.new retries failed webhooks with exponential backoff. Dedupe logic prevents duplicate rows from retries.
- Images can be flyers, social media screenshots (LinkedIn, Instagram), posters, etc. — the prompt must handle all formats.
- The prompt in `lib/prompt.ts` must explicitly instruct the model to extract ALL events from images with multiple events (e.g. workshop series). Without this, the model may collapse them into one.
- Attachments are not inline in the webhook — they must be downloaded via `downloadUrl` with `Authorization: Bearer` header.

### SES-native ingestion (migration in progress, branch `ses-migration`)
Parallel receive path that bypasses inbound.new's ~28MB ingestion ceiling (SES accepts 40MB — more than Gmail can send):
- **Flow:** `*@ses.proteus.tools` → MX `inbound-smtp.us-west-2.amazonaws.com` → SES receipt rule `decentered-inbound` (active) → raw MIME to s3://decentered-ses-inbox/inbox/`<messageId>` (30-day expiry) → Lambda `events-parser-ses-dev-parseSesEmail` (us-west-2, 120s timeout, 2GB) → same lib pipeline (mailparser replaces the webhook payload).
- **Deploy:** `pnpm serverless deploy --config serverless.ses.ts`
- **Logs:** `aws logs tail /aws/lambda/events-parser-ses-dev-parseSesEmail --region us-west-2 --since 1h --format short`
- **Cutover (not done):** repoint `proteus.tools` MX from `inbound-smtp.us-east-2.amazonaws.com` (inbound.new) to `inbound-smtp.us-west-2.amazonaws.com` and add `proteus.tools` to the receipt rule recipients. Until then production traffic still flows through inbound.new. Alerts still SEND via inbound.new's API in both paths.

### Environment Variables
Required in `.env`: `OPENAI_API_KEY`, `GOOGLE_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `S3_BUCKET`, `REGION`, `INBOUND_API_KEY`
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

Gotcha log (hard-won): `${env:VAR, "default"}` fallbacks in `serverless.ts` break when the default contains a comma (Serverless splits on it) — keep defaults in code, not serverless config. `tsx -e` cannot use top-level await (CJS transform); wrap in `async function main()`.

## Code Style
- Single quotes, no semicolons, no trailing commas
- Arrow function parens only when needed
- 180 character line width
- Biome handles linting and formatting
