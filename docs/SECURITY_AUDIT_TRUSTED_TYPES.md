# Security Audit: Trusted Types Feasibility Assessment (KZQ-P1-004-e)

> **Status**: COMPLETED — NOT FEASIBLE at this time
> **Date**: 2026-08-01
> **Auditor**: Trae automated audit
> **Scope**: Assess whether W3C Trusted Types can be adopted to lock down
> dangerous DOM sinks (innerHTML, eval, etc.) via CSP
> `require-trusted-types-for 'script'`.
> **Conclusion**: Trusted Types enforcement is **not feasible** for production
> adoption at this time. The primary blocker is that React 19.2 (the installed
> version) does **not** natively support Trusted Types — `dangerouslySetInnerHTML`
> assigns raw strings to `element.innerHTML`, which the browser rejects under
> `require-trusted-types-for 'script'`. A passthrough policy would defeat the
> security purpose. The project's XSS risk is already mitigated through
> `serializeJsonLd()` output encoding (KZQ-P1-004-c), CSP script-src restrictions,
> and zero direct `innerHTML` usage in project code. Reassess when React ships
> native Trusted Types support or when the project eliminates
> `dangerouslySetInnerHTML` in favor of `<script>` text-content injection.

---

## 1. Audit Trigger

Task KZQ-P1-004-e is the final sub-task of the KZQ-P1-004 XSS risk assessment
workstream. It evaluates whether Trusted Types — a browser security mechanism
that restricts dangerous DOM injection sinks to accept only typed
`TrustedHTML` / `TrustedScript` / `TrustedScriptURL` objects — can be enforced
via CSP on the KZQH5 public site and admin backend.

Prerequisite audits already completed:
- **KZQ-P1-004-a**: Supabase SSR cookie compatibility (httpOnly:false is required)
- **KZQ-P1-004-c**: Output encoding / dangerouslySetInnerHTML audit (5 sites,
  all via `serializeJsonLd()`, hardened with `<>&` + U+2028/U+2029 escaping)
- **KZQ-P1-004-d**: Client-side dependency audit (zero `eval`/`new Function` in
  project source; only in pdfjs-dist worker with interpreter fallback)

---

## 2. What Trusted Types Governs

When `Content-Security-Policy: require-trusted-types-for 'script'` is set,
the browser intercepts assignments to the following "sinks" and requires
typed objects (`TrustedHTML`, `TrustedScript`, `TrustedScriptURL`) instead
of raw strings:

| Sink | Typed object | Example |
|------|-------------|---------|
| `Element.innerHTML` | `TrustedHTML` | `el.innerHTML = html` |
| `Element.outerHTML` | `TrustedHTML` | `el.outerHTML = html` |
| `Element.insertAdjacentHTML()` | `TrustedHTML` | `el.insertAdjacentHTML(pos, html)` |
| `document.write()` | `TrustedHTML` | `document.write(html)` |
| `document.writeln()` | `TrustedHTML` | `document.writeln(html)` |
| `eval()` | `TrustedScript` | `eval(code)` |
| `new Function()` | `TrustedScript` | `new Function(code)` |
| `setTimeout(string)` | `TrustedScript` | `setTimeout(code, ms)` |
| `setInterval(string)` | `TrustedScript` | `setInterval(code, ms)` |
| `HTMLScriptElement.src` | `TrustedScriptURL` | `script.src = url` |
| `HTMLScriptElement.text` | `TrustedScript` | `script.text = code` |
| `Worker()` constructor | `TrustedScriptURL` | `new Worker(url)` |

Raw string assignments to these sinks throw a `TypeError` at runtime.

---

## 3. Methodology

### 3.1 Project source code scan

Searched all project-authored source files (`*.ts`, `*.tsx`, `*.js`, `*.jsx`,
`*.mjs`, `*.cjs`) for every Trusted Types sink:

- `.innerHTML =` — direct innerHTML assignment
- `.outerHTML =` — direct outerHTML assignment
- `insertAdjacentHTML` — HTML insertion API
- `document.write` / `document.writeln` — document write APIs
- `dangerouslySetInnerHTML` — React's HTML injection prop
- `setTimeout(string)` / `setInterval(string)` — string-based timers
- `new Worker(` — Worker constructor with string URL
- `.src =` / `.href =` — script/href URL assignments
- `trustedTypes` / `TrustedHTML` / `require-trusted-types` — existing policy usage

### 3.2 React DOM compatibility check

Inspected `node_modules/react-dom/` for any `trustedTypes`, `TrustedHTML`,
`createHTML`, or `createPolicy` references to determine whether React 19
natively supports Trusted Types.

### 3.3 Next.js compatibility check

Inspected `node_modules/next/dist/client/trusted-types.js` and
`node_modules/next/dist/client/script.js` to understand Next.js's built-in
Trusted Types policy and its `<Script>` component behavior.

### 3.4 pdfjs-dist compatibility check

Reviewed `components/public/product-asset-viewer/hooks/usePdfDocument.ts` and
the CSP `worker-src` directive to assess worker isolation under Trusted Types.

### 3.5 Browser support review

Verified current browser support for Trusted Types across major browsers.

---

## 4. Findings

### 4.1 Project source code — minimal sink surface

| Sink | Matches in project source | Details |
|------|---------------------------|---------|
| `.innerHTML =` | **0** | No direct innerHTML assignments |
| `.outerHTML =` | **0** | No direct outerHTML assignments |
| `insertAdjacentHTML` | **0** | No insertAdjacentHTML calls |
| `document.write` | **0** | No document.write calls |
| `eval()` / `new Function()` | **0** | Confirmed clean in KZQ-P1-004-d |
| `setTimeout(string)` | **0** | All setTimeout calls use function callbacks |
| `setInterval(string)` | **0** | All setInterval calls use function callbacks |
| `new Worker(string)` | **0** | PDF.js uses `GlobalWorkerOptions.workerSrc` (static asset) |
| `dangerouslySetInnerHTML` | **5** | All via `serializeJsonLd()` — see §4.2 |
| `script.src =` | **1** | `WechatShareBridge.tsx:22` — WeChat JS-SDK loader |
| `trustedTypes` / existing policy | **0** | No existing Trusted Types usage in project code |

The project has an exceptionally clean DOM sink profile: only 6 sink sites
total (5 `dangerouslySetInnerHTML` + 1 `script.src`), all in controlled,
audited code paths.

### 4.2 dangerouslySetInnerHTML sites (5 total)

All 5 sites use `serializeJsonLd()` which escapes `<>&` + U+2028/U+2029:

| File | Line | Data source |
|------|------|-------------|
| `ProductDetailPage.tsx` | 437 | Product JSON-LD (CMS-managed) |
| `ProductDetailPage.tsx` | 442 | FAQ JSON-LD (CMS-managed) |
| `HomePage.tsx` | 559 | Organization JSON-LD (CMS-managed) |
| `AboutPage.tsx` | 183 | Organization JSON-LD (CMS-managed) |
| `DocumentsPage.tsx` | 281 | CollectionPage JSON-LD (CMS-managed) |

React implements `dangerouslySetInnerHTML` by setting `element.innerHTML`
directly. Under Trusted Types enforcement, these 5 sites would throw
`TypeError: Failed to set the 'innerHTML' property on 'Element': This
document requires 'TrustedHTML' assignment.`

### 4.3 WeChat JS-SDK script.src assignment

`WechatShareBridge.tsx:22`:
```typescript
script.src = "https://res.wx.qq.com/open/js/jweixin-1.6.0.js";
```

Under Trusted Types, `script.src` requires a `TrustedScriptURL` object.
This site would throw unless a policy wraps the URL.

### 4.4 React 19.2 — NO native Trusted Types support

**Zero matches** for `trustedTypes`, `TrustedHTML`, `createHTML`, or
`createPolicy` in `node_modules/react-dom/`.

React 19.2 does NOT create a Trusted Types policy, does NOT wrap
`dangerouslySetInnerHTML` output in `TrustedHTML`, and does NOT call
`policy.createHTML()` before setting `innerHTML`. This means every
`dangerouslySetInnerHTML` usage in the project would break under
Trusted Types enforcement.

There is no React RFC or PR that ships Trusted Types support as of
React 19.2. The React team has discussed Trusted Types compatibility
but has not committed to a release.

### 4.5 Next.js 15.5 — partial Trusted Types policy (insufficient)

Next.js ships a Trusted Types policy in
`node_modules/next/dist/client/trusted-types.js`:

```javascript
policy = window.trustedTypes?.createPolicy('nextjs', {
    createHTML: (input) => input,      // passthrough
    createScript: (input) => input,     // passthrough
    createScriptURL: (input) => input   // passthrough
}) || null;
```

This is a **passthrough policy** — it returns the input unchanged. It exists
so that Next.js's own `<Script>` component can load scripts under Trusted
Types enforcement via `__unsafeCreateTrustedScriptURL()`.

However, Next.js's `<Script>` component (`script.js:111`) still assigns raw
strings to `innerHTML`:
```javascript
el.innerHTML = dangerouslySetInnerHTML.__html || '';
```

This would ALSO break under Trusted Types enforcement, because the raw
string is not wrapped in `policy.createHTML()` before assignment. The
passthrough policy exists but is not applied to this sink.

Furthermore, the Next.js webpack config sets
`output.trustedTypes = 'nextjs#bundler'` — this is a **webpack-level**
Trusted Types policy for dev-server script loading, NOT a runtime DOM
policy for application code.

### 4.6 pdfjs-dist worker — isolated, low risk

The PDF.js worker is loaded via `GlobalWorkerOptions.workerSrc` which points
to a static asset (`/lib/pdfjs/pdf.worker.min.mjs`). The worker runs in an
isolated Web Worker thread with no DOM access. Trusted Types primarily
governs the main-thread DOM sinks; Web Workers have limited DOM access
(no `innerHTML`, no `document.write`).

The `usePdfDocument.ts` hook uses `pdfjs.getDocument({ url })` which does
not directly set `innerHTML` or `script.src` in project code. The worker's
internal `new Function()` usage (PostScript calculator JIT) is gated by
`isEvalSupported: false` (set in KZQ-P1-003 follow-up), which forces the
interpreter fallback. Under Trusted Types, `new Function()` would require
`TrustedScript` — but since `isEvalSupported: false` disables this path,
the worker should not trigger Trusted Types violations.

### 4.7 Browser support — not universal

As of 2026-08-01:

| Browser | Trusted Types support |
|---------|-----------------------|
| Chrome | Yes (since v83) |
| Edge | Yes (since v83) |
| Safari | Partial (shipped behind flag, limited) |
| Firefox | **No** — not implemented |

Trusted Types enforcement would have no effect on Firefox users, providing
a false sense of security for ~15% of visitors. It is a defense-in-depth
layer, not a complete XSS mitigation.

---

## 5. Feasibility Assessment

### 5.1 Option A: Full enforcement with passthrough policy — NOT RECOMMENDED

Create a passthrough policy (like Next.js's `'nextjs'` policy) that wraps
all sink inputs:

```javascript
window.trustedTypes.createPolicy('kzq', {
    createHTML: (input) => input,
    createScript: (input) => input,
    createScriptURL: (input) => input,
});
```

**Problem**: This defeats the entire security purpose of Trusted Types.
A passthrough policy accepts any string, including malicious payloads.
It would allow `innerHTML = untrustedString` to execute without blocking.
The only benefit is that it forces all sink assignments to go through a
named policy, providing minor observability — but this is not worth the
complexity, browser compatibility issues, and risk of breaking React
hydration.

**Verdict**: ❌ Not recommended — security theater.

### 5.2 Option B: Full enforcement with strict policy — BLOCKED by React

Create a strict policy that only allows `serializeJsonLd()` output as
`TrustedHTML`, and only allows the WeChat URL as `TrustedScriptURL`:

```javascript
const jsonLdPolicy = window.trustedTypes.createPolicy('kzq-jsonld', {
    createHTML: (input) => {
        // Only allow JSON-LD that passed through serializeJsonLd()
        // ... validation logic ...
        return input;
    },
});
```

**Problem**: React 19.2 does NOT call `policy.createHTML()` before setting
`innerHTML`. React's `dangerouslySetInnerHTML` implementation directly
assigns `element.innerHTML = html.__html`. There is no hook point to
intercept this and wrap the string in `TrustedHTML`.

To make this work, you would need to either:
1. Patch React DOM to create its own Trusted Types policy (fragile, breaks
   on React upgrades), OR
2. Replace all 5 `dangerouslySetInnerHTML` sites with a custom component
   that calls `policy.createHTML()` before passing to React (significant
   refactor, changes the JSON-LD rendering pattern), OR
3. Wait for React to ship native Trusted Types support (no timeline).

**Verdict**: ❌ Blocked — React 19.2 lacks native Trusted Types support.

### 5.3 Option C: Report-Only mode — LOW VALUE

Enable `Content-Security-Policy-Report-Only: require-trusted-types-for 'script'`
to collect violation reports without blocking execution.

**Problem**: Since we already know the 5 `dangerouslySetInnerHTML` sites
and 1 `script.src` site would generate violations, a Report-Only mode would
only confirm what we already know. It would not provide new security value
until the blocking issues are resolved.

**Verdict**: ⚠️ Low value — defer until React adds Trusted Types support,
then enable Report-Only to catch regressions before switching to enforcing.

### 5.4 Option D: Eliminate dangerouslySetInnerHTML — FUTURE TASK

Replace `dangerouslySetInnerHTML` with `<script type="application/ld+json">`
using React's `children` prop (which uses `textContent`, not `innerHTML`):

```tsx
// Before (uses innerHTML via dangerouslySetInnerHTML):
<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />

// After (uses textContent, no Trusted Types sink):
<script type="application/ld+json">{serializeJsonLd(data)}</script>
```

This eliminates the `innerHTML` sink entirely, making Trusted Types
enforcement feasible (only the WeChat `script.src` would need a policy).

**Problem**: This is a code refactor, not an audit task. It should be
tracked as a separate task (e.g., KZQ-P1-004-f or a P2 cleanup task).
React's handling of `<script>` children may vary — the `<script>` element's
`text` property is also a Trusted Types sink (`TrustedScript`), so this
approach may still require a policy. Further investigation needed.

**Verdict**: 🔜 Recommended as a future task — eliminates the primary
Trusted Types blocker.

---

## 6. Conclusion

**Trusted Types enforcement is NOT feasible for KZQH5 at this time.**

| Factor | Status |
|--------|--------|
| Project DOM sink surface | Minimal (6 sites) — favorable |
| React 19.2 native support | ❌ Not available — primary blocker |
| Next.js 15.5 policy | Partial (passthrough, insufficient) |
| Browser support | Chrome/Edge only; Firefox unsupported |
| Current XSS mitigation | Strong (serializeJsonLd escaping, CSP, no eval) |
| Passthrough policy value | Security theater — not recommended |
| Strict policy feasibility | Blocked by React innerHTML assignment |

### 6.1 Current XSS mitigation is sufficient

The project already has robust XSS defenses that do not depend on Trusted Types:

1. **Output encoding** (KZQ-P1-004-c): `serializeJsonLd()` escapes `<>&` +
   U+2028/U+2029 before any `dangerouslySetInnerHTML` assignment.
2. **CSP script-src** restrictions: `'unsafe-inline'` + `'unsafe-eval'` removal
   (KZQ-P1-003 on `trae/p1-003-remove-unsafe-eval` branch, pending merge)
   limits script execution sources.
3. **Zero direct DOM sinks**: No `innerHTML`, `outerHTML`,
   `insertAdjacentHTML`, `document.write`, `eval`, or `new Function` in
   project source code.
4. **Dependency audit** (KZQ-P1-004-d): Only `new Function` usage is in
   pdfjs-dist worker, gated by `isEvalSupported: false`.
5. **Cookie security** (KZQ-P1-004-a): `httpOnly: false` is required by
   Supabase SSR; XSS mitigation relies on CSP + output encoding, not
   cookie attributes.

### 6.2 Reassessment triggers

Trusted Types should be reassessed when ANY of the following occurs:

1. **React ships native Trusted Types support** — React DOM creates its own
   policy and wraps `dangerouslySetInnerHTML` output in `TrustedHTML`.
2. **The project eliminates `dangerouslySetInnerHTML`** — by switching to
   `<script>` text-content injection or a custom JSON-LD component that
   uses `policy.createHTML()`.
3. **Firefox implements Trusted Types** — making it a universal browser
   security layer.
4. **Next.js adds full Trusted Types enforcement support** — including
   `innerHTML` sink wrapping in its `<Script>` component.

### 6.3 Recommended next steps (not part of this task)

- **Future task**: Replace `dangerouslySetInnerHTML` with `<script>` children
  for JSON-LD (eliminates the primary Trusted Types blocker).
- **Future task**: When React adds Trusted Types support, enable
  `require-trusted-types-for 'script'` in Report-Only mode first, collect
  violations, then switch to enforcing.
- **No code change in this task**: This is a pure feasibility assessment.

---

## 7. References

- W3C Trusted Types specification:
  https://w3c.github.io/trusted-types/dist/spec/
- MDN — Content-Security-Policy: require-trusted-types-for:
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/require-trusted-types-for
- Next.js trusted-types client module:
  `node_modules/next/dist/client/trusted-types.js`
- Next.js Script component (innerHTML sink):
  `node_modules/next/dist/client/script.js:111`
- React DOM (zero Trusted Types references):
  `node_modules/react-dom/` — no matches for `trustedTypes|TrustedHTML|createHTML`
- KZQ-P1-004-c audit (serializeJsonLd hardening):
  `docs/SECURITY_AUDIT_CLIENT_DEPENDENCIES.md` + `lib/utils.ts:91-98`
- KZQ-P1-004-d audit (eval/Function scan):
  `docs/SECURITY_AUDIT_CLIENT_DEPENDENCIES.md`
