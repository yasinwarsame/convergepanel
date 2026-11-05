# Firebase Admin SDK Setup Guide

## Quick Setup (5 minutes)

The Firebase Admin SDK is required for server-side authentication (session cookies). Follow these steps.

> **Local development uses the isolated, non-Production Firebase project.** The Production project (`convergepanel`) is refused outside the Vercel Production deployment (`lib/firebase/projectIsolation.ts`). Never download a Production key into a development checkout.
> - The Production deployment's credentials are managed in Vercel.
> - Production maintenance uses the operator workflow in `docs/operations/firebase-environment-isolation.md`.

In the examples below, `<isolated-project-id>` is the isolated project.

### Step 1: Get Service Account Credentials

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select the **isolated (non-Production) project**: `<isolated-project-id>`
3. Click the **gear icon** (⚙️) next to "Project Overview"
4. Select **Project Settings**
5. Click the **Service Accounts** tab
6. Click **Generate new private key**
7. Click **Generate key** in the confirmation dialog
8. A JSON file will download (e.g., `<isolated-project-id>-firebase-adminsdk-xxxxx.json`)

### Step 2: Extract Values from JSON

Open the downloaded JSON file. It looks like this:

```json
{
  "type": "service_account",
  "project_id": "<isolated-project-id>",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk-xxxxx@<isolated-project-id>.iam.gserviceaccount.com",
  "client_id": "...",
  "auth_uri": "...",
  "token_uri": "...",
  "auth_provider_x509_cert_url": "...",
  "client_x509_cert_url": "..."
}
```

### Step 3: Add to .env.local

Open your `.env.local` file and add/update these lines:

```env
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@<isolated-project-id>.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...\n-----END PRIVATE KEY-----\n"
```

**Important Notes:**
- Copy the **entire** `private_key` value including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`
- Keep the quotes around `FIREBASE_PRIVATE_KEY`
- Keep all `\n` characters (they represent newlines)
- Replace `xxxxx` with your actual values from the JSON file

### Step 4: Restart Dev Server

```bash
# Stop the current server (Ctrl+C)
npm run dev
```

### Example .env.local Entry

```env
# Firebase Admin SDK (Service Account)
FIREBASE_PROJECT_ID=<isolated-project-id>
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-abc123@<isolated-project-id>.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7vV...\n-----END PRIVATE KEY-----\n"
```

## Troubleshooting

### Error: "Missing: FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY"
- Make sure both values are in `.env.local`
- Check for typos in variable names
- Restart your dev server after adding them

### Error: "Failed to fetch access token"
- Verify the private key is correctly formatted (with quotes and `\n`)
- Make sure you copied the entire key including BEGIN/END markers
- Check that the service account hasn't been deleted in Firebase Console

### Still having issues?
1. Double-check the JSON file you downloaded
2. Verify the values match exactly (especially the private key)
3. Make sure `.env.local` is in the project root (same folder as `package.json`)
4. Restart the dev server completely

## Security Note

⚠️ **NEVER commit the service account JSON file or `.env.local` to git!**

The `.env.local` file is already in `.gitignore`, but make sure the downloaded JSON file is also not committed.

