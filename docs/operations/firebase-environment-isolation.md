# Firebase environment isolation (I-1/I-2)

Owner decisions: 2026-11-04. Through the application's Firebase modules (`lib/firebase/admin.ts`, `lib/firebase/client.ts`), Production Firebase (`convergepanel`) is reachable only from:
- the Vercel Production deployment;
- the four explicitly granted operator scripts below.

Everything else that uses those modules fails closed.

**Known residual: legacy scripts.** Several older scripts call `initializeApp` themselves and do **not** go through this rule:
- `scripts/setAdmin.ts`
- `scripts/seed-adaptive-multi-reviewer-e2e.ts`
- `scripts/cleanup-adaptive-multi-reviewer-e2e.ts`
- `scripts/set-admin-claim.js`
- `scripts/set-admin-simple.js`
- `scripts/set-admin-by-uid.js`
- `scripts/check-admin-claims.js`
- `scripts/verify-admin-claims.js`

They are manual operator tools with their own credentials. Some default to `convergepanel`, and some carry their own safety guards. Bringing them under this rule, or retiring them, is a tracked follow-up.

## The rule

`lib/firebase/projectIsolation.ts` is the single rule for the server and the browser.

**When a connection counts as Production.** It counts when its resolved identity is the Production project:
- Server: the projectId, or the service-account email's project. Every email form counts: IAM, App Engine default, Compute default, Google-managed.
- Browser: any of the web API key (Firebase Auth resolves the project from it), projectId, authDomain, storageBucket, project number (messagingSenderId) or appId.

**Build-time guard (M-2).** `next.config.js` calls `lib/firebase/productionBuildConfigGuard.js` before anything is built. It fails the build in two cases:
- A Vercel build has no `VERCEL_ENV`.
- A Production build (`VERCEL_ENV`/`NEXT_PUBLIC_VERCEL_ENV` = `production`) does not have all of these:
  - `NEXT_PUBLIC_VERCEL_ENV=production`;
  - all six `NEXT_PUBLIC_FIREBASE_*` values, present and trimmed, identifying the Production project and never the placeholder.

So a broken Production release cannot be created: Vercel keeps serving the previous deployment. Preview, development, local and CI builds are not checked. `NEXT_PUBLIC_VERCEL_ENV` is a Vercel framework system variable, not a project variable. It is available at build and runtime while "Automatically expose System Environment Variables" is on, but it is missing in `vercel --prebuilt` deployments, which the guard would then refuse.

**When it is allowed.** Only when the deployment environment is exactly `production`:
- Server: `VERCEL_ENV`, read at runtime.
- Browser: `NEXT_PUBLIC_VERCEL_ENV`, inlined at build.

Both signals come from Vercel's "Automatically expose System Environment Variables" setting, which is currently on. If it were turned off, Production would fail closed, which means an outage.

**There are no hard-coded fallbacks.** If the config is missing or malformed:
- **Browser, non-Production builds:** an unroutable placeholder project. Its project id contains uppercase and underscores, so it can never be a real project. Its auth domain uses the reserved `.invalid` TLD. Its API key is not a real key. The SDK receives explicit options, so it never auto-discovers a default config.
- **Browser, Production builds:** the module **throws in the browser**, so a misconfiguration is visible and reported, never masked. Server rendering and builds have no `window`, so they still render.
- **Server:** `lib/firebase/admin.ts` throws inside its existing init catch. `adminDb` and `adminAuth` stay undefined, and routes already answer "Firestore unavailable".

### Effect

| | Production deployment | Preview | Local dev | CI (`npm run build`, Jest) |
|---|---|---|---|---|
| Admin SDK → Production | yes | **refused** | **refused** | **refused** (no credentials anyway) |
| Admin SDK → isolated project | yes | yes | yes | n/a |
| Browser → Production | yes | **placeholder** | **placeholder** | placeholder (prerender only) |
| Browser → isolated project | yes | yes | yes | n/a |

- **Initial page loads:** server-rendered pages still render everywhere.
- **Authentication:** works only where the configured project is allowed. On a refused deployment, sign-in fails with a network or auth error from the placeholder project.
- **Server routes:** they need Admin, so they answer their existing "Firestore unavailable" errors (typically 503 or 500) wherever Admin is refused.

## Local development

- Normal development uses the **isolated Preview Firebase project** once it exists (runbook steps E1–E7, which need separate owner authorization).
- **Until then,** development that needs Firebase is unavailable. That is intended: it never silently uses Production.
- **Credentials:**
  - Run `vercel env pull --environment=development`. After step E5 the Development target holds the isolated project's values.
  - **Never** use `vercel env pull --environment=production` to run a local server. It writes `VERCEL_ENV=production`, and with Production credentials that would pass the server rule.
- **Required variables:** all six `NEXT_PUBLIC_FIREBASE_*`, plus **one** Admin credential format (`FIREBASE_SERVICE_ACCOUNT_BASE64` recommended) and a matching `FIREBASE_PROJECT_ID`, all for the isolated project.
- **Production data:** never change it to make local development work.

## CI and tests

- CI has no Firebase credentials.
  - The build prerenders against the placeholder.
  - Jest mocks Firebase (`@/lib/firebase/admin` is mocked per spec, and the in-memory Firestore fakes live in `lib/**/__tests__/helpers`).
  - Emulator specs use the local emulator.
- `lib/firebase/__tests__/projectIsolation.spec.ts` and `operatorAccess.spec.ts` load the real modules with the SDKs mocked.

## Operator Production maintenance

The approach is **dedicated, explicitly granted access, with no environment switch.** It covers these four reviewed scripts:

| Script | Purpose | Writes? | Existing safeguards (unchanged) |
|---|---|---|---|
| `scripts/projects/check-project-run-invariant.ts` | Health check: every Personal-Workspace run has an explicit `projectId` | No (read-only) | `--confirm-project` must equal the resolved project (`checkProjectIdentityConsistency`) |
| `scripts/projects/dry-run-project-normalization.ts` | Report what a `projectId: null` normalization would change | No (structurally write-free; a grep test enforces it) | Now also needs `--confirm-project` to obtain access |
| `scripts/projects/execute-project-normalization.ts` | Bounded historical normalization | Only with `--execute` | `--execute` plus exact candidate count and SHA-256 fingerprint, `--confirm-project` identity check, zero-write preflight |
| `scripts/workspaces/provision-existing-personal-workspaces.ts` | Provision Personal Workspaces for existing users | Only with `--execute` | `--dry-run` default; `--execute` needs `--confirm-project` and `ALLOW_WORKSPACE_PROVISIONING=true`; refuses when `NODE_ENV=production` or `VERCEL_ENV` is present |

**How access works:**
1. Each script's **first** import is `scripts/lib/operatorProductionAccess.ts`.
2. That module creates a frozen, immutable grant **in this process only**, and only when all of these hold:
   - the operator names the target with `--confirm-project=<id>`;
   - it runs in a local operator shell, so `VERCEL`, `VERCEL_ENV` and `NEXT_RUNTIME` are unset and `NODE_ENV` is not `production`;
   - `lib/firebase/admin` has not loaded yet, and no grant exists yet.
3. **The mode is bound to the operation.**
   - The read-only scripts (`check-project-run-invariant.ts`, `dry-run-project-normalization.ts`) refuse `--execute`.
   - The write-capable scripts are `write` only with `--execute`.
   - Any other operation gets no grant.
   - The mode is recorded and logged. Writes themselves remain controlled by each script's own existing gates.
4. It prints an audit line: project, operation, mode and time.
5. `lib/firebase/admin.ts` lifts a Production refusal **only** when all of these hold:
   - the grant is valid;
   - the resolved project is exactly `convergepanel` and the grant names it;
   - the credential is a Production service account (by IAM domain or project number).

   It then logs `OPERATOR access to Production project …`.

**What does not change:**
- No variable can turn operator access on.
- Web request handlers and Preview cannot use it: the reader refuses inside Vercel and inside Next.js.
- Static tests pin that only these four scripts import the writer and only `admin.ts` reads the grant.
- **Credentials:** the operator's existing, approved Production service-account key file. This adds no new authentication path, but it must be selected **explicitly**: `--operator-credentials=<path to the JSON key>`.
  - The writer validates the file: `project_id` is `convergepanel`, `client_email` is a Production service account, and a private key is present.
  - It removes every other Firebase credential variable from the process. This matters because the base64 form would otherwise win.
  - It then installs only that file. Credentials from `.env.local` or the environment are **never** used for Production.
- **Where to run.** Each script loads `.env.local` with dotenv first.
  - A `.env.local` from `vercel env pull` sets `VERCEL`/`VERCEL_ENV`. Production operator access then refuses with a specific message that names `vercel env pull`.
  - Run Production operator commands from a **separate operator checkout** with no pulled Vercel variables, and keep the key file outside any repository.
  - A **non-Production** target (`--confirm-project=<isolated-project>`) needs no grant. It works from an ordinary development checkout with the isolated credentials.
- **Preflight.** `--operator-preflight` runs every check (target, shell, credential file, operation and mode, load order), prints the result, and exits **without** granting or touching Firebase. Example: `npm run verify:project-run-invariant -- --confirm-project=convergepanel --operator-credentials=/secure/convergepanel-operator.json --operator-preflight`.
- Running any write-capable command still needs its own separate approval.
