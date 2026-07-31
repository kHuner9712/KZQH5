# Security Audit: Supabase SSR Cookie Compatibility (KZQ-P1-004-a)

> **Status**: COMPLETED
> **Date**: 2026-07-31
> **Auditor**: Trae automated audit
> **Scope**: Establish facts about Supabase SSR cookie attributes before any
> XSS mitigation changes are attempted.
> **Conclusion**: `httpOnly: false` is a **HARD REQUIREMENT** of
> `@supabase/ssr` v0.12.0. Any XSS mitigation MUST NOT modify the cookie
> `httpOnly` attribute. Alternative mitigations (CSP, output encoding,
> Trusted Types) must be used instead.

---

## 1. Audit Trigger

Task KZQ-P1-004 (Auth cookie & XSS risk assessment) was raised to evaluate
whether the Supabase Auth session cookies could be hardened against XSS
exfiltration by switching `httpOnly` to `true`.

This audit (sub-task KZQ-P1-004-a) is the mandatory first step: it
establishes the factual compatibility constraints of `@supabase/ssr` v0.12.0
before any cookie attribute change is proposed.

---

## 2. Installed Package Version

```
// package.json
"@supabase/ssr": "0.12.0"
```

Verified at `package.json:40`.

---

## 3. Project Cookie Usage

The project touches Supabase Auth session cookies in three places:

### 3.1 Browser client — `lib/supabase/client.ts`

```typescript
import { createBrowserClient } from "@supabase/ssr";
// ...
return createBrowserClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);
```

**No custom `cookies` option is provided.** This means `createBrowserClient`
falls back to the `document.cookie` API (see section 4 below).

### 3.2 Server client — `lib/supabase/server.ts`

```typescript
import { createServerClient } from "@supabase/ssr";
// ...
return createServerClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  {
    cookies: {
      getAll() { return cookieStore.getAll(); },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) =>
          cookieStore.set(name, value, options)
        );
      },
    },
  }
);
```

The server client uses Next.js `cookies()` API and passes through whatever
options `@supabase/ssr` provides. It does NOT explicitly set `httpOnly`.

### 3.3 Middleware session refresh — `lib/supabase/middleware-session.ts`

```typescript
// lib/supabase/middleware-session.ts:125-130
const DEFAULT_COOKIE_OPTIONS = {
  path: "/",
  sameSite: "lax" as const,
  httpOnly: false,
  maxAge: 400 * 24 * 60 * 60, // 400 days
};
```

The comment at `:122-124` explicitly states:

> Default cookie options matching @supabase/ssr's DEFAULT_COOKIE_OPTIONS.
> These MUST stay in sync so that cookies written here are indistinguishable
> from cookies written by @supabase/ssr.

At `:607`, refreshed cookies are written with `httpOnly: cookie.httpOnly`
(inheriting from `DEFAULT_COOKIE_OPTIONS`).

---

## 4. @supabase/ssr v0.12.0 Source Evidence

The installed package source at `node_modules/@supabase/ssr/src/cookies.ts`
was inspected. The critical code paths are:

### 4.1 Browser fallback to `document.cookie`

```typescript
// node_modules/@supabase/ssr/src/cookies.ts:195-198
} else if (!isServerClient && isBrowser()) {
  // The environment is browser, so use the document.cookie API to implement getAll and setAll.
  getAll = () => documentCookieGetAll();
  setAll = documentCookieSetAll;
}
```

When `createBrowserClient` is called WITHOUT a custom `cookies` option (as the
project does in `lib/supabase/client.ts`), the client reads and writes cookies
exclusively through `document.cookie`.

### 4.2 `documentCookieGetAll` reads via `document.cookie`

```typescript
// node_modules/@supabase/ssr/src/cookies.ts:93-100
const documentCookieGetAll = () => {
  const parsed = parse(document.cookie);
  return Object.keys(parsed).map((name) => ({
    name,
    value: parsed[name] ?? "",
  }));
};
```

### 4.3 `documentCookieSetAll` writes via `document.cookie`

```typescript
// node_modules/@supabase/ssr/src/cookies.ts:102-106
const documentCookieSetAll: SetAllCookies = (setCookies) => {
  setCookies.forEach(({ name, value, options }) => {
    document.cookie = serialize(name, value, options);
  });
};
```

### 4.4 Official type documentation

```typescript
// node_modules/@supabase/ssr/src/types.ts:70-83
/**
 * Required when reading cookies from a custom store. If both `getAll` and
 * `setAll` are omitted in a browser runtime, the client falls back to
 * reading via `document.cookie`. Tokens and PKCE code verifiers are still
 * persisted in cookies regardless of the `encode` option, so cookie access
 * (custom or fallback) is required for auth to work.
 */
getAll?: GetAllCookies;
/**
 * Required alongside `getAll` when using a custom cookie store. If both
 * `getAll` and `setAll` are omitted in a browser runtime, the client falls
 * back to writing via `document.cookie`.
 */
setAll?: SetAllCookies;
```

The documentation explicitly states that "cookie access (custom or fallback)
is required for auth to work."

---

## 5. Why `httpOnly: true` Breaks Auth

The `document.cookie` API is defined by the HTML specification. A fundamental
security property of `document.cookie` is:

> **httpOnly cookies are NOT visible to `document.cookie`.**

This is enforced by every conformant browser. The MDN documentation for
`Document.cookie` states:

> HttpOnly cookies are excluded from the `document.cookie` property.

Therefore, if the Supabase Auth session cookie (`sb-<project-ref>-auth-token`)
were marked `httpOnly: true`:

1. `createBrowserClient`'s `documentCookieGetAll()` would return an **empty
   list** (the auth cookie is invisible to `document.cookie`).
2. `supabase.auth.getSession()` on the client would return `null` (no session
   cookie found).
3. `supabase.auth.getUser()` on the client would fail (no access token).
4. Auto session refresh on the client would break (no refresh token).
5. All client-side auth state management would fail.
6. The admin login flow (`components/admin/LoginForm.tsx` calls
   `supabase.auth.signInWithPassword` then relies on the client-side session)
   would appear to succeed but immediately lose the session.

**This is not a theoretical risk.** The project previously experienced
black-screen issues from much smaller CSP/cookie mismatches (commits
`3d2d842`, `2206fca`, `69348b5`).

---

## 6. Conclusion: `httpOnly: false` Is a Hard Requirement

| Question | Answer |
|----------|--------|
| Can we set `httpOnly: true` on Supabase Auth cookies? | **NO** |
| Why? | `createBrowserClient` reads cookies via `document.cookie`, which cannot see httpOnly cookies |
| What breaks if we do? | Client-side `getSession()`, `getUser()`, auto-refresh, and the entire admin login flow |
| Is there a workaround within @supabase/ssr v0.12.0? | No — providing a custom `cookies` adapter that bypasses `document.cookie` on the browser would require reimplementing cookie storage (e.g. localStorage), which is explicitly unsupported and would diverge from the server-side cookie format, breaking session sharing |
| Was this verified against the installed source? | Yes — `node_modules/@supabase/ssr/src/cookies.ts:93-106, 195-198` and `types.ts:70-83` |

---

## 7. Approved XSS Mitigation Paths

Since the cookie `httpOnly` attribute CANNOT be used to protect the auth
session from XSS exfiltration, the following alternative mitigations must be
used. Each is tracked as a separate atomic sub-task under KZQ-P1-004:

### 7.1 CSP Enforcement (KZQ-P1-004-b, depends on KZQ-P1-002)

- Switch admin CSP from Report-Only to Enforcing so that inline script
  injection is blocked at the browser level.
- This is the primary defense: if XSS cannot execute, it cannot read
  `document.cookie`.
- **Blocked** by KZQ-P1-002 (requires human CSP violation audit in EdgeOne).

### 7.2 Output Encoding / Ban Dangerous HTML (KZQ-P1-004-c)

- Audit all `dangerouslySetInnerHTML` usage (5 sites for JSON-LD).
- Ensure no user-controllable data flows into HTML injection points.
- Replace unsafe serialization with structured JSON-LD via `<script type="application/ld+json">` with properly escaped content.
- This prevents DOM-based XSS even if CSP is bypassed.

### 7.3 Client-side Dependency Audit (KZQ-P1-004-d)

- Verify no `eval()` or `new Function()` in production bundles.
- Verify pdfjs-dist worker does not introduce exploitable eval paths.
- Lock the bundle against future dependency drift.

### 7.4 Trusted Types Feasibility (KZQ-P1-004-e)

- Assess CSP `require-trusted-types-for 'script'` adoption.
- Evaluate compatibility with Next.js 15 App Router and pdfjs-dist worker.
- This is the strongest DOM XSS defense but may have compatibility costs.

---

## 8. Constraints for Future Tasks

Any future task that touches Supabase Auth cookies MUST:

1. **NOT** set `httpOnly: true` on the `sb-<project-ref>-auth-token` cookie
   or any chunk of it (`sb-<project-ref>-auth-token.0`, `.1`, etc.).
2. **NOT** introduce a custom browser-side cookie adapter that bypasses
   `document.cookie` unless the adapter is fully compatible with the server
   cookie format AND has been tested end-to-end (login, logout, refresh,
   SSR session sharing).
3. Preserve the `sameSite: "lax"` attribute (already correct).
4. Ensure `secure: true` is set in production (handled by EdgeOne TLS
   termination + Supabase SSR defaults when on HTTPS).
5. Keep `lib/supabase/middleware-session.ts` `DEFAULT_COOKIE_OPTIONS` in sync
   with `@supabase/ssr`'s `DEFAULT_COOKIE_OPTIONS` (the existing comment at
   `:121-124` already mandates this).

---

## 9. References

- `@supabase/ssr` v0.12.0 source: `node_modules/@supabase/ssr/src/cookies.ts`
- `@supabase/ssr` v0.12.0 types: `node_modules/@supabase/ssr/src/types.ts`
- `@supabase/ssr` v0.12.0 design doc: `node_modules/@supabase/ssr/docs/design.md`
- Project browser client: `lib/supabase/client.ts`
- Project server client: `lib/supabase/server.ts`
- Project middleware session: `lib/supabase/middleware-session.ts`
- MDN `Document.cookie`: https://developer.mozilla.org/en-US/docs/Web/API/Document/cookie
- Upgrade ledger: `docs/TRAE_UPGRADE_LEDGER.md` (KZQ-P1-004-a row)
