# Buddy Punch Privacy Request Portal

Internal web app for processing CCPA / GDPR privacy requests (opt-out, deletion, access, correction, sensitive PII limit).

## What it does

- **Logs every privacy request** received via Intercom, the `/do-not-sell/` form, email, or mail — with statutory deadline auto-computed (15 business days for opt-out, 45 calendar days for deletion).
- **Automates third-party submissions** for HubSpot, Amplitude (both UserID + AccountID projects), Intercom, Stripe, Meta (LDU signal), GA4 (User Deletion API), and Google Ads (Customer Match audience removal).
- **Manual checklist** for destinations without good APIs (LinkedIn, Microsoft Ads, internal product DB).
- **24-month retention** of every request + every action + a full audit log, per CCPA §1798.130.
- **Slack notifications** to `#privacy-requests` for new requests, approaching deadlines (T-3d), and completions.
- **Quarterly summary** auto-posted to Slack on the first Monday of each quarter.
- **Bulk CSV import** for retroactive request logging.

## Architecture

- Node.js + Express, EJS server-rendered views, Tailwind via CDN
- Google OAuth for sign-in (allowlist via `privacy_request_users` table)
- Supabase Postgres for storage (`tnzonruwauoijhqyfwxw` project)
- Deployed on Railway, auto-deploy from `main`
- Cron jobs (node-cron) for deadline reminders + quarterly summaries

## Setup

### 1. Run the migration

In Supabase SQL Editor for project `tnzonruwauoijhqyfwxw`, paste and run `migrations/001_initial.sql`. This creates:

- `privacy_requests`, `privacy_request_actions`, `privacy_request_audit_log`
- `privacy_request_users` (seeded with `eric@buddypunch.com`)
- `privacy_request_oauth_tokens`
- View `privacy_requests_open` (open requests with urgency)
- Function `compute_privacy_deadline(req_type, received)`

### 2. Create the HubSpot `do_not_sell` custom property

HubSpot → Settings → Properties → Contact properties → Create property:
- **Name:** `do_not_sell`
- **Type:** Single checkbox
- **Default:** false

If you skip this, the HubSpot integration falls back to setting `hs_marketable_status = NON_MARKETABLE` only.

### 3. Set Railway env vars

See `.env.example` for the full list. Key ones:

- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` — for sign-in
- `HUBSPOT_ACCESS_TOKEN`, `INTERCOM_ACCESS_TOKEN`, `STRIPE_SECRET_KEY` — copy from existing bots
- `AMPLITUDE_API_KEY_*`, `AMPLITUDE_SECRET_KEY_*` — for both projects
- `META_PIXEL_ID`, `META_ACCESS_TOKEN` — for LDU signal
- `GA4_PROPERTY_ID`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID` — for GA4/Google Ads
- `SLACK_BOT_TOKEN`, `SLACK_PRIVACY_CHANNEL_ID` — for notifications
- `SESSION_SECRET`, `BASE_URL`

### 4. Configure Google OAuth (for sign-in AND GA4/Google Ads)

In Google Cloud Console:
1. Create an OAuth 2.0 Client ID
2. Authorized redirect URIs:
   - `https://<your-railway-url>/auth/callback` (sign-in)
   - `https://<your-railway-url>/oauth/google/callback` (GA4/Ads)
3. Enable APIs: Google Analytics Admin API, Google Analytics Data API, Google Ads API

### 5. First login + Google API authorization

1. Visit the portal, sign in with `eric@buddypunch.com`
2. Navigate to **Google OAuth** in the top nav
3. Complete the OAuth consent flow — this stores the refresh token in `privacy_request_oauth_tokens` so the GA4 and Google Ads integrations can run on every request

## Usage

1. Privacy request comes in (Intercom, Do Not Sell form, email).
2. Log it via **New Request** with email + type + source.
3. Click **Run All Automated** on the request detail page — fires the API integrations.
4. Mark the manual-checklist items done (LinkedIn, Microsoft Ads, Internal DB).
5. When all destinations are complete, click **Mark Complete + Send Confirmation**.
6. Audit log retains everything for 24 months.

## Statutory clocks

| Request type | Clock | Note |
|---|---|---|
| Opt out of Sale/Share | 15 business days | Cannot require identity verification |
| Right to Delete | 45 calendar days (extendable to 90) | Identity verification required |
| Right to Access | 45 calendar days | Identity verification required |
| Right to Correct | 45 calendar days | Identity verification required |
| Limit Sensitive PII | 15 business days | |

## What's still manual

- **LinkedIn Insight Tag** — no good API for end-user deletion; file support ticket via Campaign Manager
- **Microsoft Ads / Bing UET** — verify with Camel Digital before submitting (only if actively running Bing campaigns)
- **Internal Product DB (app.buddypunch.com)** — ping Nick or Muhammad to run the deletion script

These are surfaced in the request-detail UI as manual-checklist items with **Mark done** buttons.

## Deploy

```bash
cd ~/Desktop/Claude\ Docs/privacy-request-portal
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/bp10162024/privacy-request-portal.git
git push -u origin main
```

Railway will auto-deploy on push.

## Health checks

- `GET /healthz` → `OK`
- Watchdog: add to `railway-watchdog/MONITORED_SERVICES`

## See also

- `legal-and-insurance` skill — case law and architecture decisions that anchor this portal
- `CCPA Request Runbook.md` — human-readable runbook (replaced by this portal but kept for reference)
