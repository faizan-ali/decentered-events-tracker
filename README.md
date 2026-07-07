# DecenteredArts Events Extractor

An AI-powered serverless solution that automatically extracts event details from digital flyers and adds them to a centralized spreadsheet tracker.

https://decentered.org/

Built by [Faizan Ali](https://x.com/faizanali94)


## About DecenteredArts

DecenteredArts is a nonprofit organization dedicated to tracking and centralizing niche artistic events. This system empowers their team to focus on discovering events rather than manually transcribing Instagram flyers.

## What This Does

**For Non-Technical Users:**
Instead of manually copying event details from Instagram posts into a spreadsheet, team members simply:
1. Take a screenshot of an event flyer (or save the image/PDF)
2. Drop it into a shared Google Drive folder — or email it to a special address
3. The system automatically reads the image and adds the event to the tracker within minutes. Files that were picked up move to a "processed" subfolder; anything that can't be processed triggers a friendly email explaining what to fix.

**For Technical Users:**
This serverless application ingests flyer images through two paths — a polled Google Drive folder (primary) and inbound email via [inbound.new](https://inbound.new) — then uses OpenAI's GPT-5.4 vision model to extract structured event data and populates a Google Sheets tracker, with multi-layer deduplication across both paths.

## Architecture & Workflow

Two ingestion paths feed one shared extraction pipeline:

```
PRIMARY  Flyer/PDF → shared Drive folder → EventBridge (5 min) → Lambda poller ─┐
                                                                                ├→ OpenAI Vision → dedupe → Google Sheets
FALLBACK Screenshot → Email Forward → inbound.new Webhook → API Gateway Lambda ─┘
                                                                                └→ AWS S3 (archival + pipeline state)
```

**Drive inbox path (primary, July 2026):**
1. A team member drops images/PDFs into a Google Drive folder shared with a service account
2. A scheduled Lambda polls every 5 minutes, downloading bounded-resolution thumbnails (which makes HEIC photos and PDF flyers work for free)
3. An S3 ledger — not Drive state — is the source of truth for what's been processed, with pre-counted attempts bounding retry cost even across crashes
4. Processed files move to a `processed/` subfolder as visible feedback; failures alert the uploader by email after 3 attempts

**Email path (fallback):**
1. inbound.new receives forwarded emails and posts a JSON webhook
2. Lambda downloads image attachments (or public Google Drive links found in the body) via authenticated URLs

**Shared pipeline:**
- Images archived to S3; GPT-5.4 vision extracts structured event data (the prompt is anchored with today's date so "TONIGHT 8PM" screenshots resolve to real dates)
- Two-layer dedupe before appending: exact per-source-file replay protection, plus fuzzy matching (bigram similarity on title/address + exact date) that catches the same event arriving via different flyers — or different paths
- A cached dedupe index makes appends resilient to spreadsheet-API latency; failures alert on persistence (consecutive-failure streaks with recovery notifications), not one-off blips, with CloudWatch alarms as an independent backstop and every alert archived to S3

> **History**: email ingestion originally used SendGrid Inbound Parse, replaced with inbound.new in March 2026; the Drive folder became the primary path in July 2026 after email-provider size ceilings kept silently dropping large flyer batches.

## Technologies Used

- **Runtime**: Node.js with TypeScript
- **Cloud Platform**: AWS Lambda + EventBridge schedules + CloudWatch alarms/SNS (Serverless)
- **File Ingestion**: Google Drive API (polled shared folder)
- **Email Processing**: [inbound.new](https://inbound.new)
- **AI Vision**: OpenAI GPT-5.4
- **Storage**: AWS S3 (image archive + ledger/cache/alert-archive state)
- **Spreadsheet**: Google Sheets API
- **Framework**: Serverless Framework
- **Code Quality**: Biome (linting & formatting), Vitest (250+ tests)

### Key Dependencies
- `openai` - GPT-5.4 vision API integration
- `inboundemail` - inbound.new TypeScript SDK
- `googleapis` - Google Sheets automation
- `serverless` - SLS framework for deployment
- `@aws-sdk/client-s3` - File storage
- `google-auth-library` - Google services authentication

## Setup & Deployment

### Prerequisites
- A filled out .env file. Reach out to @faizan-ali for access.
- Node.js and pnpm installed

### Deployment
```bash
pnpm run deploy:prod
```

## Contributing

 Improvements to accuracy, performance, or additional features are welcome.

---

*Built with love for San Francisco arts*
