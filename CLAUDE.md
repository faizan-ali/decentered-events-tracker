# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DecenteredArts Events Extractor - A serverless application that processes inbound emails containing event flyers, uses GPT-4o vision to extract event details, and populates a Google Sheets tracker.

**Pipeline:** Email with image → Sendgrid Inbound Parse → AWS Lambda → OpenAI GPT-4o Vision → Google Sheets + S3 archival

## Common Commands

```bash
# Development
pnpm dev                    # Start local server with hot reload (serverless offline)
pnpm check                  # TypeScript type checking
pnpm lint                   # Lint and format with Biome (auto-fix)

# Deployment
pnpm deploy:prod            # Deploy to AWS Lambda
```

## Architecture

### Entry Point
`src/handlers/inbound.ts:parseSendgridInbound` - Lambda handler for POST `/parse-sendgrid-inbound`

### Processing Flow
1. Parse multipart email with `lambda-multipart-parser`
2. For each image attachment:
   - Upload to S3 (`lib/s3.ts`)
   - Extract events via GPT-4o (`lib/openai.ts` using prompt from `lib/prompt.ts`)
   - Normalize event data (`lib/events.ts`)
3. Batch append all events to Google Sheets (`lib/sheets.ts`)

### Key Data Structure
Events have: title, address, location (SF/Oakland/Berkeley/Other), type (from fixed list), startDay/endDay (YYYY-MM-DD), startTime/endTime (HH:mm), description, cost

### Environment Variables
Required in `.env`: `OPENAI_API_KEY`, `GOOGLE_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `S3_BUCKET`, `REGION`

## Code Style
- Single quotes, no semicolons, no trailing commas
- Arrow function parens only when needed
- 180 character line width
- Biome handles linting and formatting
