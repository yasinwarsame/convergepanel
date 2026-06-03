<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into ConvergePanel. The existing client-side provider was upgraded to use a reverse proxy (`/ingest`) and exception capture. Eight new events were instrumented across six files — covering the full user lifecycle from signup through activation, core feature usage, and billing conversion. Server-side tracking was added to the Stripe webhook and checkout routes using `posthog-node`. User identification (`posthog.identify()`) was added at login and signup to correlate PostHog persons with Firebase UIDs.

| Event | Description | File |
|---|---|---|
| `user_signed_up` | Fired after successful Firebase account creation. Calls `posthog.identify()` to link the new user. | `app/signup/page.tsx` |
| `user_logged_in` | Fired after successful sign-in. Calls `posthog.identify()` to re-link returning users. | `app/login/page.tsx` |
| `onboarding_completed` | Fired after onboarding form is saved. Captures role, use_case, usage_frequency, and referral_source. | `app/onboarding/page.tsx` |
| `checkout_started` | Fired when user initiates a checkout or upgrade. Captures plan and billing interval. | `app/billing/page.tsx` |
| `subscription_created` | Server-side. Fired after Stripe checkout.session.completed webhook succeeds. Captures plan and interval. | `app/api/stripe/webhook/route.ts` |
| `subscription_upgraded` | Server-side. Fired when an existing subscription is upgraded inline (lite → full). | `app/api/billing/create-checkout-session/route.ts` |
| `subscription_canceled` | Server-side. Fired after Stripe customer.subscription.deleted webhook succeeds. | `app/api/stripe/webhook/route.ts` |
| `run_limit_reached` | Fired when a panel run or claim verification hits the monthly quota. Key churn/upgrade signal. | `app/page.tsx` |

### Other changes

| File | Change |
|---|---|
| `next.config.js` | Added PostHog reverse proxy rewrites (`/ingest/*`) and `skipTrailingSlashRedirect: true` |
| `components/PostHogProvider.tsx` | Updated `api_host` to `/ingest`, added `ui_host` and `capture_exceptions: true` |
| `lib/posthog-server.ts` | New server-side PostHog client (singleton, `posthog-node`) |
| `.env.local` | Added `NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- [Analytics basics dashboard](https://us.posthog.com/project/453239/dashboard/1665989)
- [Activation Funnel: Signup → Onboarding → First Run](https://us.posthog.com/project/453239/insights/g7N1cXDx)
- [New Signups Over Time](https://us.posthog.com/project/453239/insights/moKB2gB7)
- [Revenue Funnel: Checkout Started → Subscription Created](https://us.posthog.com/project/453239/insights/yEVXMpXZ)
- [Run Limit Reached (Churn Signal)](https://us.posthog.com/project/453239/insights/ipMR4dpS)
- [Core Feature Usage](https://us.posthog.com/project/453239/insights/NmXoy5u6)

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
