# ConvergePanel

**Multi-LLM Expert Panel Research Tool**

ConvergePanel is a production-ready MVP web application that sends one user question to multiple AI models in parallel, then synthesizes a unified answer while explicitly highlighting where models agree or disagree.

## Features

- **Multi-Model Support**: Query GPT 5.2, Claude Opus 4.5, Grok 4, Perplexity Pro, and Gemini 3 Pro simultaneously
- **Parallel Execution**: All models respond in parallel for faster results
- **Consensus Analysis**: Automatically identifies areas of agreement and disagreement
- **Numeric Conflict Detection**: Flags when models provide conflicting numbers or percentages
- **Unified Synthesis**: Generates a comprehensive report combining all perspectives
- **Minimum Panel Rule**: Enforces at least 2 models for meaningful convergence analysis

## Tech Stack

- **Next.js 14** (App Router)
- **React 18** with TypeScript
- **Tailwind CSS** for styling
- **Firebase Authentication** for user auth
- **Firestore** for data storage
- **Firebase Admin SDK** for server-side operations
- **Server-side API routes** for orchestration

## Setup

### Prerequisites

- Node.js 18+ and npm/yarn/pnpm
- API keys for the models you want to use (see below)

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd ConvergePanel
```

2. Install dependencies:
```bash
npm install
# or
yarn install
# or
pnpm install
```

3. Create a `.env.local` file in the root directory:
```bash
cp .env.example .env.local
```

4. Set up Firebase:
   - Create a Firebase project at https://console.firebase.google.com
   - Project ID: `convergepanel` (or update env vars)
   - Enable Authentication (Email/Password)
   - Enable Firestore Database
   - Get your Firebase config from Project Settings

5. **Get Firebase Service Account Credentials (REQUIRED for Admin SDK)**:
   - Go to Firebase Console > Project Settings > Service Accounts
   - Click "Generate new private key"
   - A JSON file will download - **DO NOT commit this file to git**
   - Copy the values from the JSON file:
     - `client_email` → `FIREBASE_CLIENT_EMAIL`
     - `private_key` → `FIREBASE_PRIVATE_KEY` (keep the quotes and `\n` characters)
   - **Important**: The private key must be in quotes and newlines must be escaped as `\n`

6. Add environment variables to `.env.local`:
```env
# Firebase Client Config (from Firebase Console)
NEXT_PUBLIC_FIREBASE_API_KEY=your_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=convergepanel.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=convergepanel
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=convergepanel.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=907484474744
NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id

# Firebase Admin SDK (Service Account) - REQUIRED
# Get these from Firebase Console > Project Settings > Service Accounts > Generate new private key
FIREBASE_PROJECT_ID=convergepanel
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@convergepanel.iam.gserviceaccount.com
# IMPORTANT: Keep the quotes and \n characters exactly as they appear in the JSON file
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...\n-----END PRIVATE KEY-----\n"

# Admin Secret (for setting first admin)
ADMIN_SECRET=your-long-random-secret-string

# Optional: API keys can be set here or via Admin UI
# Firestore keys take precedence over environment variables
OPENAI_API_KEY=your_openai_api_key_here
ANTHROPIC_API_KEY=your_anthropic_api_key_here
XAI_API_KEY=your_xai_api_key_here
PERPLEXITY_API_KEY=your_perplexity_api_key_here
```

6. Set up Firestore Security Rules:
   - In Firebase Console, go to Firestore Database > Rules
   - Paste the rules from `firestore.rules` (see below)
   - Publish the rules

**Note**: 
- You don't need all API keys. Models without keys will return mock responses.
- API keys can be managed via the Admin UI (Firestore) or via environment variables.
- Firestore-stored keys take precedence over environment variables.

### Running the Application

1. Start the development server:
```bash
npm run dev
# or
yarn dev
# or
pnpm dev
```

2. Open [http://localhost:3000](http://localhost:3000) in your browser

3. Enter a question, select models (minimum 2), and click "Run Panel"

## Project Structure

```
ConvergePanel/
├── app/
│   ├── admin/
│   │   ├── login/
│   │   │   └── page.tsx          # Admin login page
│   │   └── page.tsx              # Admin dashboard
│   ├── about/
│   │   └── page.tsx              # About page
│   ├── help/
│   │   └── page.tsx              # Help page
│   ├── contact/
│   │   └── page.tsx              # Contact page
│   ├── api/
│   │   ├── admin/
│   │   │   ├── login/
│   │   │   │   └── route.ts     # Admin login API
│   │   │   ├── logout/
│   │   │   │   └── route.ts     # Admin logout API
│   │   │   └── keys/
│   │   │       └── route.ts     # Admin keys API
│   │   └── run-panel/
│   │       └── route.ts          # API endpoint for running panels
│   ├── globals.css               # Global styles
│   ├── layout.tsx                # Root layout
│   └── page.tsx                  # Main page component
├── components/
│   ├── ModelPicker.tsx           # Model selection UI
│   ├── StatusPill.tsx            # Status indicator component
│   ├── ResultsDisplay.tsx        # Results display component
│   └── TopNav.tsx                # Top navigation component
├── lib/
│   ├── adminAuth.ts              # Admin authentication utilities
│   ├── keyStore.ts               # Server-side key storage
│   ├── types.ts                  # TypeScript type definitions
│   ├── consensus.ts              # Consensus engine and synthesis
│   └── connectors/
│       ├── base.ts               # Base connector class
│       ├── chatgpt.ts            # OpenAI GPT 5.2 connector
│       ├── claude.ts             # Anthropic Claude Opus 4.5 connector
│       ├── grok.ts               # X.AI Grok 4 connector
│       ├── perplexity.ts         # Perplexity Pro connector
│       ├── gemini.ts             # Google Gemini 3 Pro connector
│       └── index.ts              # Connector exports
├── middleware.ts                 # Route protection middleware
├── package.json
├── tsconfig.json
├── tailwind.config.ts
└── README.md
```

## How It Works

### 1. Model Connectors

Each AI model has a dedicated connector that implements the `ModelConnector` interface:

```typescript
interface ModelConnector {
  id: "chatgpt" | "claude" | "grok" | "perplexity" | "gemini";
  displayName: string;
  sendPrompt(question: string, systemWrapper: string): Promise<{
    status: "ok" | "error" | "timeout" | "refused";
    rawText: string | null;
    latencyMs: number;
  }>;
}
```

### 2. API Endpoint

The `/api/run-panel` endpoint:
- Validates that at least 2 models are selected
- Dispatches the question to all selected models in parallel
- Returns results with status, raw text, and latency for each model

### 3. Consensus Engine

The consensus engine:
1. **Extracts claims** from each model's response (sentence-level)
2. **Clusters similar claims** using keyword-based similarity
3. **Identifies consensus** (≥2 models agree) vs disagreements
4. **Detects numeric conflicts** when models provide different numbers
5. **Synthesizes a unified report** with trust summary and agreement/disagreement map

### 4. UI Components

- **ModelPicker**: Allows selection of 2-5 models with presets
- **StatusPill**: Shows real-time status for each model (Queued → Thinking → Done/Error)
- **ResultsDisplay**: Shows unified answer, agreement map, and expandable raw responses

## Adding a New Model Connector

To add a new model connector:

1. Create a new connector file in `lib/connectors/` (e.g., `gemini.ts`):

```typescript
import { BaseConnector } from "./base";

export class GeminiConnector extends BaseConnector {
  id = "gemini" as const;
  displayName = "Gemini 3 Pro";

  async sendPrompt(question: string, systemWrapper: string) {
    const startTime = Date.now();
    const apiKey = this.getApiKey();

    if (!apiKey) {
      return this.getMockResponse();
    }

    try {
      // Implement your API call here
      // ...
      
      return {
        status: "ok" as const,
        rawText: responseText,
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      // Handle errors
      return {
        status: "error" as const,
        rawText: null,
        latencyMs: Date.now() - startTime,
      };
    }
  }
}
```

2. Update `lib/types.ts` to include the new model ID:
```typescript
export type ModelId = "chatgpt" | "claude" | "grok" | "perplexity" | "gemini";
```

3. Register the connector in `lib/connectors/index.ts`:
```typescript
import { GeminiConnector } from "./gemini";

const connectors: Record<ModelId, ModelConnector> = {
  // ... existing connectors
  gemini: new GeminiConnector(),
};
```

4. Add the API key to `.env.local`:
```env
GEMINI_API_KEY=your_gemini_api_key_here
```

5. Update the base connector's `getApiKey()` method to include the new key mapping.

## Core Rules

### Minimum Panel Size
- Users must select at least 2 models
- UI prevents running with fewer than 2 models
- Backend validates and returns 400 error if <2 models

### Runtime Failure Rule
- If only 1 model responds successfully:
  - Show the raw response(s)
  - **Do NOT** generate a synthesized convergence report
  - Display a banner with options to re-run or add another model

### Consensus Requirements
- Synthesis only occurs when ≥2 models respond successfully
- All failures are clearly displayed
- Numeric conflicts are explicitly flagged

## Authentication & Authorization

ConvergePanel uses Firebase Authentication with role-based access control.

### User Roles

- **User**: Default role for all accounts. Can use the panel and view their profile.
- **Admin**: Users with `admin: true` custom claim. Can access admin dashboard, manage API keys, and manage users.

### Setting Up the First Admin

1. Sign up a user account through the app (`/signup`)

2. Get the user's UID from Firebase Console or from the user's profile page

3. Call the admin setter endpoint:
```bash
curl -X POST http://localhost:3000/api/admin/set-admin \
  -H "Content-Type: application/json" \
  -d '{"uid": "USER_UID_HERE", "secret": "YOUR_ADMIN_SECRET"}'
```

4. The user must sign out and sign back in for the admin claim to take effect

**Note**: This endpoint is not linked in the UI for security. It's a one-time setup endpoint.

## Admin Dashboard

ConvergePanel includes an admin-only dashboard for managing API keys and users.

### Accessing Admin Dashboard

1. Sign in with an admin account
2. Navigate to `/admin` (link appears in TopNav for admins only)
3. You'll see:
   - **Overview**: Dashboard with user and model statistics
   - **API Keys**: Manage LLM API keys for all models
   - **Users**: View, disable/enable, and delete users

### Admin Features

- **API Key Management**: View and update API keys stored in Firestore
- **User Management**: List users, disable/enable accounts, delete users
- **Secure Storage**: Keys stored in Firestore, only accessible to admins
- **Role-Based Access**: All admin routes protected by Firebase custom claims

### Key Storage

- **Firestore**: API keys are stored in `appConfig/modelKeys` document
- **Fallback**: If Firestore keys are missing, falls back to environment variables
- **Security**: Keys are stored server-side only, never exposed to clients
- **Access Control**: Only admins can read/write keys (enforced by Firestore rules)

**Important Security Notes**:
- The admin dashboard is protected by middleware and requires authentication
- Keys are never exposed in API responses to non-admin users
- The `/admin` route is not linked in public navigation
- Always use strong passwords for `ADMIN_PASSWORD` in production

## Database Setup

ConvergePanel uses PostgreSQL with Prisma ORM for data persistence.

### Initial Setup

1. **Install dependencies:**
```bash
npm install
```

2. **Set up your database:**
   - Create a PostgreSQL database (local or cloud)
   - Add connection string to `.env.local`:
```env
DATABASE_URL="postgresql://user:password@localhost:5432/convergepanel?schema=public"
```

3. **Run migrations:**
```bash
npx prisma migrate dev --name init
```

4. **Generate Prisma Client:**
```bash
npx prisma generate
```

### Database Schema

The database includes:
- **ApiKey**: Stores API keys for all models (replaces file-based storage)
- **PanelRun**: Optional history of panel runs and results
- **AdminSession**: Optional admin session tracking

### Migrations

To create a new migration:
```bash
npx prisma migrate dev --name your_migration_name
```

To apply migrations in production:
```bash
npx prisma migrate deploy
```

### Prisma Studio

View and edit data in a GUI:
```bash
npx prisma studio
```

## Firestore Security Rules

Copy and paste these rules into Firebase Console > Firestore Database > Rules:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    
    // Users collection - users can read/write only their own doc
    // Admins can list all users
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
      allow list: if request.auth != null && request.auth.token.admin == true;
    }

    // App config - only admins can read/write model keys
    match /appConfig/modelKeys {
      allow read, write: if request.auth != null && request.auth.token.admin == true;
    }

    // Default deny all other documents
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

## Environment Variables

### Firebase Client (Required)

| Variable | Description | Required |
|----------|-------------|----------|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Firebase API key | **Yes** |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Firebase auth domain | **Yes** |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Firebase project ID | **Yes** |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | Firebase storage bucket | **Yes** |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | Firebase messaging sender ID | **Yes** |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Firebase app ID | **Yes** |

### Firebase Admin (Required)

| Variable | Description | Required |
|----------|-------------|----------|
| `FIREBASE_PROJECT_ID` | Firebase project ID | **Yes** |
| `FIREBASE_CLIENT_EMAIL` | Service account email | **Yes** |
| `FIREBASE_PRIVATE_KEY` | Service account private key | **Yes** |
| `ADMIN_SECRET` | Secret for setting first admin | **Yes** |

### API Keys (Optional)

| Variable | Description | Required |
|----------|-------------|----------|
| `OPENAI_API_KEY` | OpenAI API key for GPT 5.2 | No (uses mock if missing) |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude Opus 4.5 | No (uses mock if missing) |
| `XAI_API_KEY` | X.AI API key for Grok 4 | No (uses mock if missing) |
| `PERPLEXITY_API_KEY` | Perplexity API key for Perplexity Pro | No (uses mock if missing) |
| `GEMINI_API_KEY` | Google API key for Gemini 3 Pro | No (uses mock if missing) |

**Note**: 
- API keys can be set via environment variables OR via the Admin UI
- Firestore keys (set via Admin UI) take precedence over environment variables
- If Firestore keys are missing, the app falls back to environment variables

## Development

### Building for Production

```bash
npm run build
npm start
```

### Linting

```bash
npm run lint
```

### Troubleshooting ChunkLoadError

If you encounter a `ChunkLoadError` in development (e.g., "Loading chunk app/layout failed"):

1. **Clear Next.js cache:**
   ```bash
   rm -rf .next
   ```

2. **Clear browser cache and service workers:**
   - Open DevTools (F12)
   - Go to Application tab > Storage
   - Click "Clear site data"
   - Or manually unregister service workers:
     - Application tab > Service Workers
     - Click "Unregister" for any registered workers

3. **Restart the dev server:**
   ```bash
   npm run dev
   ```

4. **Hard refresh the browser:**
   - Mac: Cmd + Shift + R
   - Windows/Linux: Ctrl + Shift + R

**Note**: Service workers are automatically unregistered in development mode to prevent caching issues. If you still see errors, ensure no service workers are registered in your browser.

## License

MIT

## Support

For issues or questions, please open an issue on the repository.

<!-- Phase 9D.0-FX deploy trigger: no functional change, this comment exists solely to produce a new Production deployment so a Vercel environment-variable update takes effect. -->
<!-- Phase 9D.0-AC deploy trigger: no functional change, this comment exists solely to produce a new Production deployment so the ADAPTIVE_SCHEMAS_CANARY_UIDS Vercel environment-variable addition takes effect. -->


