# KZQH5 Upgrade Ledger

## Current Baseline

- Repository: https://github.com/kHuner9712/KZQH5
- Base branch: main
- Audited commit: c544e5a
- Node version: 20.x
- Next.js version: 15.5.21
- Supabase client version: 2.109.0
- Last updated: 2026-08-01 (KZQ-P0-001 completed)

## Status Values

- pending
- in_progress
- blocked
- completed
- superseded

## Audit Notes (2026-08-01)

Verified against real code on branch `trae/p0-001-finalize-rpc-strict-parsing`
(created from `origin/main` at commit `c544e5a`).

P0 upload tasks are NOT complete. The previous session incorrectly skipped to
KZQ-P1-020. Per the priority rule (P0 → P1 → P2 → Framework), P0 must be
completed first. KZQ-P0-001 is selected as the highest-priority incomplete task.

## Task Table

| ID | Priority | Workstream | Task | Status | Branch | Commit | Acceptance | Notes |
|----|----------|------------|------|--------|--------|--------|------------|-------|
| KZQ-P0-001 | P0 | Epic A | Strictly parse finalize RPC business return value | completed | trae/p0-001-finalize-rpc-strict-parsing | (see git log) | npm run typecheck ✓; npm run lint ✓; npx vitest run tests/unit/two-phase-upload-service.test.ts ✓ (21 tests passed) | complete_temp_upload_finalize RPC now strictly parses ok field; compensation deletes moved object on failure; fixed error code COMPLETE_RPC_FAILED; 8 new tests added. |
| KZQ-P0-002 | P0 | Epic A | Correct signed upload URL lifecycle model | pending | - | - | - | SIGNED_UPLOAD_URL_TTL_SECONDS defined but never used; docs conflate DB expires_at with signed URL TTL. |
| KZQ-P0-003 | P0 | Epic A | Bind upload token to authorizing admin | pending | - | - | - | claim_temp_upload_for_finalize accepts no actor; FinalizeUploadInput.actorId/actorRole declared but silently discarded. Requires forward-only migration. |
| KZQ-P0-004 | P0 | Epic A | Final extension from verified MIME | pending | - | - | - | Two-phase path uses getExtensionFromFilename (user filename), not centralized MIME→ext mapping. Single-stage path is correct. |
| KZQ-P0-005 | P0 | Epic A | Unify single-stage and two-phase Storage Saga | pending | - | - | - | Workstream: split into atomic sub-tasks. Path gen + cleanup enqueue shared; validation, audit, compensation, ref registration divergent. |
| KZQ-P0-010 | P0 | Epic B | Production schema fallback explicit | pending | - | - | - | ALLOW_SCHEMA_COMPATIBILITY_FALLBACK does not exist; fallback is unconditional and silent (fail-open). |
| KZQ-P0-011 | P0 | Epic B | Strengthen release readiness DB contract | pending | - | - | - | Partial: RPC-based verifier exists. Missing: migration ledger state, RLS enabled, policies, table-level grants/revokes, RPC param/return contracts. |
| KZQ-P1-001 | P1 | Epic C | Clean CSP implementation vs doc conflict | pending | - | - | - | Not yet audited in detail. |
| KZQ-P1-002 | P1 | Epic C | Admin CSP switch to Enforcing | pending | - | - | - | Blocked by KZQ-P1-001 and CSP violation audit. |
| KZQ-P1-003 | P1 | Epic C | Remove public CSP unsafe-eval | pending | - | - | - | Not yet audited in detail. |
| KZQ-P1-004 | P1 | Epic C | Auth cookie and XSS risk assessment | pending | - | - | - | Not yet audited in detail. |
| KZQ-P1-010 | P1 | Epic D | Pre-auth coarse rate limiting | pending | - | - | - | Not yet audited in detail. |
| KZQ-P1-011 | P1 | Epic D | Production distributed rate limiting | pending | - | - | - | Not yet audited in detail. |
| KZQ-P1-012 | P1 | Epic D | Strict canonical origin validation | pending | - | - | - | Not yet audited in detail. |
| KZQ-P1-013 | P1 | Epic D | HSTS and CSP Reporting Endpoint external protocol | pending | - | - | - | Not yet audited in detail. |
| KZQ-P1-020 | P1 | Epic E | Admin login error message standardization | pending | - | - | - | LoginForm.tsx leaks raw Supabase errors. Will be done after P0. |
| KZQ-P1-021 | P1 | Epic E | Admin login brute-force protection | pending | - | - | - | Not yet audited in detail. |
| KZQ-P1-022 | P1 | Epic E | Admin MFA / AAL2 | pending | - | - | - | Workstream: split into 6 atomic sub-tasks. |
| KZQ-P2-001 | P2 | Epic F | Admin auth request-level dedup | pending | - | - | - | Not yet audited in detail. |
| KZQ-P2-002 | P2 | Epic F | Dashboard query convergence | pending | - | - | - | Not yet audited in detail. |
| KZQ-P2-003 | P2 | Epic F | Unified media domain config validation | pending | - | - | - | Not yet audited in detail. |
| KZQ-UPG-001 | Framework | Epic G | Node 20 → Node 22 | pending | - | - | - | Blocked by P0 and core P1 completion. |
| KZQ-UPG-002 | Framework | Epic G | ESLint Flat Config migration | pending | - | - | - | Blocked by P0 and core P1 completion. |
| KZQ-UPG-003 | Framework | Epic G | PDF.js and Turbopack compatibility | pending | - | - | - | Blocked by P0 and core P1 completion. |
| KZQ-UPG-004 | Framework | Epic G | Next.js 16 upgrade | pending | - | - | - | Blocked by UPG-001, UPG-002, UPG-003. |
| KZQ-P2-010 | P2 | Epic H | Clean up superseded draft PRs | pending | - | - | - | Check PR #31, #32, #33. |
| KZQ-P2-011 | P2 | Epic H | Remove deprecated Vercel integration | pending | - | - | - | Not yet audited in detail. |
| KZQ-P2-012 | P2 | Epic H | Security supply chain hardening | pending | - | - | - | Workstream: split into independent sub-tasks (CodeQL, secret scanning, Dependabot, SBOM, license audit, Actions permissions). |
