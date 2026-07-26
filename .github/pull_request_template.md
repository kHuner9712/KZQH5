## Summary

<!-- Brief description of what this PR changes and why. -->

## Change type

<!-- Check one: -->
- [ ] Bug fix (non-breaking)
- [ ] Feature (non-breaking)
- [ ] Refactor (non-breaking)
- [ ] Breaking change
- [ ] Database migration (new timestamped file only)
- [ ] CI/CD / infrastructure
- [ ] Documentation

## Scope

<!-- List the files or areas affected. If this touches security, migrations,
     or deployment config, explain why it's necessary. -->

## Validation

<!-- Check all that apply: -->
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm run test:unit` passes
- [ ] `npm run build` passes
- [ ] `npm run build:demo` passes
- [ ] `npm run test:e2e:demo` passes
- [ ] Tested at 390px mobile width
- [ ] Tested at 1440px desktop width

## Database migration (if applicable)

<!-- If this PR adds a migration file, confirm: -->
- [ ] New file in `supabase/migrations/` with `YYYYMMDDHHMMSS_` prefix
- [ ] No existing migration file modified
- [ ] `docs/DATABASE_MIGRATION_LEDGER.md` updated
- [ ] Migration is additive (no destructive ALTER or DROP on existing data)

## Security checklist (if touching auth, API, or storage)

- [ ] No secrets, tokens, or service role keys in code or env
- [ ] No `NEXT_PUBLIC_*` variable exposes a server-only secret
- [ ] State-changing endpoints have CSRF protection (`isSameSiteRequest`)
- [ ] Admin write endpoints go through `requireAdminWrite`
- [ ] No raw SQL error details forwarded to client
- [ ] No hardcoded business claims or unverified certifications

## Business content

- [ ] No invented statistics, certificates, or product specs
- [ ] No content copied from visual reference designs
- [ ] Fire rating remains B级, environmental rating remains E0级
- [ ] No pricing data beyond "contact sales for quotation"

## Notes

<!-- Any additional context, screenshots, or concerns. -->
