# Google Sheets Integration Setup

This project integrates with Google Sheets to automatically add extracted events to a spreadsheet.

## Prerequisites

1. **Google Cloud Project**: You need a Google Cloud project with the Google Sheets API enabled.
2. **Service Account**: Create a service account with access to Google Sheets API.
3. **Google Spreadsheet**: Create a Google Spreadsheet and share it with your service account email.

## Setup Steps

### 1. Create Google Cloud Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select or create a project
3. Enable the Google Sheets API:
   - Go to "APIs & Services" > "Library"
   - Search for "Google Sheets API"
   - Click "Enable"
4. Create a service account:
   - Go to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "Service Account"
   - Fill in the details and click "Create"
   - Skip role assignment for now and click "Done"
5. Generate a key for the service account:
   - Click on the created service account
   - Go to "Keys" tab
   - Click "Add Key" > "Create New Key"
   - Choose "JSON" format and download the key file

### 2. Create Google Spreadsheet

1. Go to [Google Sheets](https://sheets.google.com/)
2. Create a new spreadsheet
3. Copy the spreadsheet ID from the URL (the long string between `/d/` and `/edit`)
4. Share the spreadsheet with your service account email (found in the JSON key file)
   - Click "Share" button
   - Add the service account email with "Editor" permissions

### 3. Environment Variables

Add the following environment variables to your `.env` file:

```env
# Google Sheets Configuration
GOOGLE_SPREADSHEET_ID=your_spreadsheet_id_here
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY_HERE\n-----END PRIVATE KEY-----\n"
```

**Important Notes:**
- Replace `your_spreadsheet_id_here` with the actual spreadsheet ID
- Replace the email with your service account email from the JSON key file
- Replace the private key with the private key from the JSON key file
- Keep the private key in quotes and preserve the `\n` characters for line breaks

### 4. Initialize Spreadsheet Headers

Run the setup script once to create the proper headers in your spreadsheet:

```bash
npx tsx setup-spreadsheet.ts
```

This will create the following columns in your spreadsheet:
- Date (MM/DD/YYYY format)
- Event Name
- Type
- Start Time (HH:MM AM/PM format)
- End Time (HH:MM AM/PM format)
- Location
- Address
- Description
- Cost ($XX or Free format)
- Link (S3 URL of the source image)

## How It Works

1. When an email with attachments is processed, events are extracted from each image
2. Each event is formatted according to the spreadsheet requirements:
   - Dates are converted to MM/DD/YYYY format
   - Times are converted to 12-hour format with AM/PM
   - Costs are formatted as $XX or "Free"
   - The S3 URL of the source image is included as a link
3. Events are automatically added as new rows to the Google Spreadsheet

## Troubleshooting

### Common Issues

1. **Permission Denied**: Make sure the spreadsheet is shared with the service account email
2. **Invalid Credentials**: Verify that the private key is correctly formatted with proper line breaks
3. **API Not Enabled**: Ensure Google Sheets API is enabled in your Google Cloud project
4. **Spreadsheet Not Found**: Double-check the spreadsheet ID in the environment variable

### Testing

You can test the integration by running the setup script:

```bash
npx tsx setup-spreadsheet.ts
```

If this runs successfully, your Google Sheets integration is properly configured. 