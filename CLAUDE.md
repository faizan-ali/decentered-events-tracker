# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DecenteredArts Events Extractor - A serverless application that processes inbound emails containing event flyers/screenshots, uses GPT-5.2 vision to extract event details, and populates a Google Sheets tracker.

**Pipeline:** Email with image → Sendgrid Inbound Parse → AWS Lambda → OpenAI GPT-5.2 Vision → Google Sheets + S3 archival

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
curl -X POST -F "to=test@test.com" -F "from=test@example.com" \
  -F "subject=Test" -F "attachment1=@<image>;type=image/png" \
  "<API_GATEWAY_URL>/dev/parse-sendgrid-inbound"
```

## Architecture

### Entry Point
`src/handlers/inbound.ts:parseSendgridInbound` - Lambda handler for POST `/parse-sendgrid-inbound`

### Processing Flow
1. Parse multipart email with `lambda-multipart-parser`
2. For each image attachment (in parallel):
   - Upload to S3 fire-and-forget (`lib/s3.ts`)
   - Extract events via GPT-5.2 vision (`lib/openai.ts` using prompt from `lib/prompt.ts`)
   - Normalize event data (`lib/events.ts`) — fills missing end times (start + 3h), cross-fills missing start/end days
3. Deduplicate against existing sheet rows by title + date + address (`lib/sheets.ts`)
4. Append only new events to Google Sheets (`lib/sheets.ts`)

### Key Data Structure
Events have: title, address, location (SF/Oakland/Berkeley/Other), type (from fixed list), startDay/endDay (YYYY-MM-DD), startTime/endTime (HH:mm), description, cost

### Infrastructure
- **Region:** us-west-1
- **Lambda:** `events-parser-dev-parseSendgridInbound`
- **API Gateway timeout:** 29s (hard AWS limit) — GPT-5.2 typically responds in 11-15s
- **S3 bucket:** set via `S3_BUCKET` env var (us-west-1)
- **Spreadsheet:** ~5700 existing rows, dedupe fetches columns A-G before appending
- **Logs:** `aws logs tail /aws/lambda/events-parser-dev-parseSendgridInbound --region us-west-1 --since 1h --format short`

### Important Constraints
- API Gateway has a hard 29s timeout. GPT-4o was too slow (~31s), which is why we use GPT-5.2 (~13s). Do not switch back to GPT-4o.
- Sendgrid retries failed webhooks every ~3 hours. Dedupe logic prevents duplicate rows from retries.
- Images can be flyers, social media screenshots (LinkedIn, Instagram), posters, etc. — the prompt must handle all formats.
- The prompt in `lib/prompt.ts` must explicitly instruct the model to extract ALL events from images with multiple events (e.g. workshop series). Without this, the model may collapse them into one.

### Environment Variables
Required in `.env`: `OPENAI_API_KEY`, `GOOGLE_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `S3_BUCKET`, `REGION`

## Code Style
- Single quotes, no semicolons, no trailing commas
- Arrow function parens only when needed
- 180 character line width
- Biome handles linting and formatting
