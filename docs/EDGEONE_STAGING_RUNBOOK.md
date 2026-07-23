# EdgeOne Staging Runbook

> **Status:** Configuration preparation only. Do NOT deploy until the
> migrations in `docs/POST_MERGE_MIGRATION_RUNBOOK.md` have been applied
> and verified.

## Build Configuration

| Setting   | Value                  |
| --------- | ---------------------- |
| Node.js   | 20                     |
| Install   | `npm ci`               |
| Build     | `npm run build`        |
| Output    | `.next`                |
| Branch    | `main`                 |

EdgeOne must run a clean install (`npm ci`, not `npm install`) to ensure
the lockfile is respected and no unexpected dependency drift occurs.

## Required Environment Variables

These MUST be configured as EdgeOne build/runtime secrets before staging
goes live:

| Variable                              | Scope        | Notes                                                              |
| ------------------------------------- | ------------ | ------------------------------------------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`            | build + runtime | Supabase project URL                                             |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`        | build + runtime | Supabase anon public key                                         |
| `SUPABASE_SERVICE_ROLE_KEY`           | runtime only | Server-side only. NEVER add `NEXT_PUBLIC_` prefix. Must not appear in client bundles. |
| `NEXT_PUBLIC_SITE_URL`                | build + runtime | EdgeOne Staging root URL (HTTPS). Do NOT append `/en`. Do NOT use Vercel URL or localhost. |
| `NEXT_PUBLIC_DEMO_MODE`               | build + runtime | Must be `false` for staging.                                      |
| `NEXT_PUBLIC_SITE_INDEXING_ENABLED`   | build + runtime | Must be `false` for staging. Only `true` after production domain acceptance. |

## Optional Environment Variables

| Variable                          | Scope        | Notes                                                |
| --------------------------------- | ------------ | ---------------------------------------------------- |
| `INQUIRY_WECOM_WEBHOOK_URL`       | runtime only | WeCom webhook for new inquiry notifications          |
| `RESEND_API_KEY`                  | runtime only | Email notification API key                           |
| `INQUIRY_NOTIFICATION_FROM`        | runtime only | Sender address for inquiry emails                    |
| `INQUIRY_NOTIFICATION_TO`          | runtime only | Recipient for inquiry notifications                  |
| `WECHAT_APP_ID`                   | runtime only | WeChat JS-SDK app ID (server-side only)             |
| `WECHAT_APP_SECRET`               | runtime only | WeChat JS-SDK secret (server-side only)              |

## Security Requirements

- `SUPABASE_SERVICE_ROLE_KEY` must be readable by the server runtime only.
  It must NEVER be inlined into client bundles or exposed via
  `NEXT_PUBLIC_*`.
- Staging must keep `NEXT_PUBLIC_SITE_INDEXING_ENABLED=false` so search
  engines do not index the unfinished site.
- `NEXT_PUBLIC_SITE_URL` must be the EdgeOne Staging root URL:
  - HTTPS only.
  - Do NOT append `/en` (the app handles locale routing internally).
  - Do NOT use a `vercel.app` domain.
  - Do NOT use `localhost` or `127.0.0.1`.
- Do NOT reuse ambiguous production credentials. Staging should use its own
  Supabase project or a clearly separated staging schema if sharing a
  project.
- Write-operation tests (inquiry submission, catalog asset save) require an
  independent explicit confirmation toggle. Do not enable writes by default.

## Verification Paths

After deployment, verify each path returns the expected content. All
Chinese routes use no locale prefix; English routes use `/en`.

### Public pages

```
/
/en
/products
/en/products
/documents
/en/documents
/projects
/en/projects
/certificates
/en/certificates
/contact
/en/contact
```

### Admin & API

```
/admin/login
/api/health
/robots.txt
/sitemap.xml
```

### `/api/health` expectations

```json
{
  "success": true,
  "demo": false,
  "indexingEnabled": false,
  "runtime": "nodejs"
}
```

`indexingEnabled` must be `false` in staging.

### `/robots.txt` expectations (staging)

```
User-Agent: *
Disallow: /
```

No `Sitemap:` line should appear when indexing is disabled.

## Pre-Deployment Checklist

- [ ] Migrations applied and verified (see `docs/POST_MERGE_MIGRATION_RUNBOOK.md`)
- [ ] `npm run check:release-readiness -- --mode=staging` returns no BLOCK
- [ ] `NEXT_PUBLIC_SITE_URL` set to EdgeOne Staging HTTPS root
- [ ] `NEXT_PUBLIC_DEMO_MODE=false`
- [ ] `NEXT_PUBLIC_SITE_INDEXING_ENABLED=false`
- [ ] Supabase service role configured as runtime secret (not build-time public)
- [ ] Storage buckets reviewed (see `docs/STORAGE_SECURITY_REVIEW.md`)
- [ ] No placeholder contact data in `company_profile` (or placeholder guard
      active, hiding it from public pages)
- [ ] Build succeeds locally with the same env vars

## Post-Deployment Checks

- [ ] All verification paths return 200 (or expected redirect)
- [ ] `/api/health` reports `indexingEnabled: false`
- [ ] `/robots.txt` disallows all crawling
- [ ] No placeholder phone/email/address visible on any public page
- [ ] Inquiry form submits successfully
- [ ] Catalog viewer opens PDFs without errors (if catalog assets exist)
- [ ] Admin login works and catalog asset save works
