# Firebase environment isolation (I-1/I-2)

Owner decisions: 2026-11-04. Production Firebase (`convergepanel`) is reachable only from the Vercel Production deployment and from explicitly granted operator scripts. Everything else fails closed.

## The rule

`lib/firebase/projectIsolation.ts` is the single rule for the server and the browser.

**When a connection counts as Production.** It counts when its resolved identity is the Production project:
- Server: the projectId, or the service-account email's project. Every email form counts: IAM, App Engine default, Compute default, Google-managed.
- Browser: any of the web API key (Firebase Auth resolves the project from it), projectId, authDomain, storageBucket, project number (messagingSenderId) or appId.

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
3. The mode is `write` only with `--execute`; otherwise it is `read-only`.
4. It prints an audit line: project, operation, mode and time.
5. `lib/firebase/admin.ts` lifts a Production refusal **only** for a valid grant that names exactly the resolved project, with a credential that belongs to it. It logs `OPERATOR access to Production project …`.

**What does not change:**
- No variable can turn operator access on.
- Web request handlers and Preview cannot use it: the reader refuses inside Vercel and inside Next.js.
- Static tests pin that only these four scripts import the writer and only `admin.ts` reads the grant.
- **Credentials:** the operator's existing service-account credential, supplied to the shell the same way as today. This adds no new authentication path.
- Running any write-capable command still needs its own separate approval.
