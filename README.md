# DecenteredArts Events Extractor

An AI-powered serverless solution that automatically extracts event details from digital flyers and adds them to a centralized spreadsheet tracker.

https://decentered.org/

Built by [Faizan Ali](https://x.com/faizanali94)


## About DecenteredArts

DecenteredArts is a nonprofit organization dedicated to tracking and centralizing niche artistic events. This system empowers their team to focus on discovering events rather than manually transcribing Instagram flyers.

## What This Does

**For Non-Technical Users:**
Instead of manually copying event details from Instagram posts into a spreadsheet, team members can now simply:
1. Take a screenshot of an Instagram event flyer
2. Forward it to a special email address
3. The system automatically reads the image and adds the event to the tracker

**For Technical Users:**
This serverless application processes inbound emails via [inbound.new](https://inbound.new), uses OpenAI's GPT-5.4 vision model to extract structured event data from image attachments, and automatically populates a Google Sheets tracker.

## Architecture & Workflow

```
Instagram Screenshot → Email Forward → inbound.new Webhook → AWS Lambda → Download Attachments → OpenAI Vision API → Google Sheets
                                                                                    ↓
                                                                                 AWS S3 Storage
```

1. **Email Ingestion**: inbound.new receives forwarded emails and posts a JSON webhook
2. **Attachment Download**: Lambda downloads image attachments via authenticated URLs
3. **File Storage**: Images are uploaded to AWS S3 for archival
4. **AI Extraction**: OpenAI GPT-5.4 vision model analyzes images and extracts event details
5. **Spreadsheet Update**: Extracted data is automatically added to Google Sheets tracker

> **Note**: This project previously used SendGrid Inbound Parse for email ingestion. It was replaced with inbound.new in March 2026 for better developer experience and lower cost.

## Technologies Used

- **Runtime**: Node.js with TypeScript
- **Cloud Platform**: AWS Lambda (Serverless)
- **Email Processing**: [inbound.new](https://inbound.new)
- **AI Vision**: OpenAI GPT-5.4
- **Storage**: AWS S3
- **Spreadsheet**: Google Sheets API
- **Framework**: Serverless Framework
- **Code Quality**: Biome (linting & formatting)

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
