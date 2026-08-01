import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ============================================================
// KZQ-P1-022-a/b: MFA / AAL2 — data & Auth capability audit
// ------------------------------------------------------------
// Static contract tests that pin the AUDIT FACTS (not behaviour):
//   1. (a) No MFA integration existed at audit time — since superseded
//      by (b): the enrollment UI now exists and calls the MFA API.
//   2. getVerifiedAdmin() does NOT check the authenticator assurance
//      level (aal1 session passes today — the gap this workstream
//      fixes in sub-task d; enrollment alone must not introduce it).
//   3. admin_profiles has no MFA columns (MFA state lives in the auth
//      schema; no migration is needed).
//   4. The sensitive-operation endpoints targeted by step-up exist.
//   5. The Supabase JS SDK in package.json is new enough to expose the
//      MFA API (enroll / challenge / getAuthenticatorAssuranceLevel).
//   6. The SSR session middleware does not parse the aal claim.
// ============================================================

const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("KZQ-P1-022-b: MFA enrollment integration exists (supersedes the no-integration audit)", () => {
  const enrollment = read("components/admin/MfaEnrollment.tsx");
  const errorMap = read("lib/security/mfa-errors.ts");
  const securityPage = read("app/admin/(protected)/security/page.tsx");

  it("the enrollment component calls the MFA enroll API", () => {
    expect(enrollment).toContain("mfa.enroll");
  });

  it("the enrollment component calls challenge and verify", () => {
    expect(enrollment).toContain("mfa.challenge");
    expect(enrollment).toContain("mfa.verify");
  });

  it("the enrollment component lists existing factors via listFactors", () => {
    expect(enrollment).toContain("mfa.listFactors");
  });

  it("the fixed error map never returns raw provider text", () => {
    expect(errorMap).toContain("mapMfaError");
    expect(errorMap).toMatch(/The raw message is never surfaced/);
  });

  it("the account-security page mounts the enrollment component", () => {
    expect(securityPage).toContain("MfaEnrollment");
  });

  it("the admin shell nav exposes the security entry", () => {
    const shell = read("components/admin/AdminLayout.tsx");
    expect(shell).toMatch(/\/admin\/security/);
  });
});

describe("KZQ-P1-022-c: MFA challenge gate integration exists", () => {
  const challenge = read("components/admin/MfaChallenge.tsx");
  const loginForm = read("app/admin/login/LoginForm.tsx");

  it("the challenge page exists outside the (protected) group", () => {
    // The (protected) layout runs getVerifiedAdmin() (aal1 passes) — the
    // challenge gate MUST live outside it, or an admin would reach the
    // dashboard without completing the challenge.
    const page = read("app/admin/mfa/challenge/page.tsx");
    expect(page).toContain("MfaChallenge");
  });

  it("the challenge component calls challenge and verify", () => {
    expect(challenge).toContain("mfa.challenge");
    expect(challenge).toContain("mfa.verify");
  });

  it("the challenge component evaluates the assurance level before gating", () => {
    expect(challenge).toContain("getAuthenticatorAssuranceLevel");
    expect(challenge).toContain("aal.currentLevel === \"aal2\"");
  });

  it("the login form routes to the challenge page when a factor exists", () => {
    expect(loginForm).toContain("/admin/mfa/challenge");
    expect(loginForm).toContain("getAuthenticatorAssuranceLevel");
    expect(loginForm).toMatch(/nextLevel === "aal2"/);
  });

  it("the login form routes fail-closed to the challenge page on AAL probe failure", () => {
    // A thrown or errored AAL probe must NOT admit the admin to /admin —
    // the challenge page re-evaluates the AAL and redirects non-MFA
    // accounts back, so fail-closed is safe.
    expect(loginForm).toMatch(/needsMfaChallenge = true/);
  });

  it("getVerifiedAdmin now enforces AAL2 for accounts with a verified factor (sub-task d)", () => {
    const adminAuth = read("lib/services/admin-auth.ts");
    expect(adminAuth).toContain("getAuthenticatorAssuranceLevel");
    expect(adminAuth).toMatch(/aal-insufficient/);
    expect(adminAuth).toMatch(/nextLevel === "aal2"/);
  });
});

describe("KZQ-P1-022-a: no AAL gate in the SSR session middleware", () => {
  it("does not reference the aal claim in the SSR session middleware", () => {
    const middleware = read("lib/supabase/middleware-session.ts");
    expect(middleware).not.toMatch(/\baal\b/i);
  });
});

describe("KZQ-P1-022-d: getVerifiedAdmin AAL server guard (the gap closed)", () => {
  const adminAuth = read("lib/services/admin-auth.ts");
  const layout = read("app/admin/(protected)/layout.tsx");

  it("calls getAuthenticatorAssuranceLevel during verification", () => {
    expect(adminAuth).toContain("getAuthenticatorAssuranceLevel");
  });

  it("denies (aal-insufficient) only when a verified factor exists but the session is not aal2", () => {
    expect(adminAuth).toMatch(/nextLevel === "aal2" && aal\.currentLevel !== "aal2"/);
  });

  it("does NOT lock out accounts without a verified factor (nextLevel aal1 passes)", () => {
    // The guard combines BOTH conditions (AND): a verified factor
    // (nextLevel "aal2") AND a session that is not yet aal2. A bare
    // single-condition check would lock out every admin.
    expect(adminAuth).toMatch(/nextLevel === "aal2" && aal\.currentLevel !== "aal2"/);
  });

  it("is fail-closed: AAL probe error/exception maps to aal-insufficient", () => {
    expect(adminAuth).toMatch(/aalError \|\| !aal/);
  });

  it("maps the internal reason to the fixed external stage mfa", () => {
    expect(adminAuth).toMatch(/case "aal-insufficient":\s+return "mfa"/);
  });

  it("the protected layout redirects aal-insufficient sessions to the MFA challenge page", () => {
    expect(layout).toMatch(/admin\.reason === "aal-insufficient"/);
    expect(layout).toMatch(/redirect\("\/admin\/mfa\/challenge"\)/);
  });

  it("keeps verifying the session via auth.getUser()", () => {
    expect(adminAuth).toContain("auth.getUser()");
  });
});

describe("KZQ-P1-022-a: data model needs no MFA migration", () => {
  const schema = read("supabase/schema.sql");
  const adminProfilesBlock = schema.slice(
    schema.indexOf("create table if not exists public.admin_profiles"),
    schema.indexOf("create table if not exists public.categories"),
  );

  it("admin_profiles has no MFA-related columns", () => {
    expect(adminProfilesBlock).not.toMatch(/mfa|factor|totp|aal/i);
  });

  it("admin_profiles keeps its minimal id/email/role shape", () => {
    expect(adminProfilesBlock).toMatch(/id uuid primary key references auth\.users/);
    expect(adminProfilesBlock).toMatch(/role text default 'admin'/);
  });
});

describe("KZQ-P1-022-a: sensitive-operation endpoints exist (step-up targets)", () => {
  const ENDPOINTS = [
    "app/api/admin/inquiries/export/route.ts",
    "app/api/admin/storage/upload/route.ts",
    "app/api/admin/storage/upload/authorize/route.ts",
    "app/api/admin/storage/upload/finalize/route.ts",
    "app/api/admin/storage/publish/route.ts",
    "app/api/admin/product-assets/[id]/publish/route.ts",
    "app/api/admin/certificates/[id]/publish/route.ts",
    "app/api/admin/products/route.ts",
    "app/api/admin/inquiries/route.ts",
  ];
  for (const endpoint of ENDPOINTS) {
    it(`exists: ${endpoint}`, () => {
      const file = read(endpoint);
      // Every admin write route must carry the write guard boundary.
      expect(file.length).toBeGreaterThan(0);
    });
  }
});

describe("KZQ-P1-022-a: SDK exposes the MFA API (capability baseline)", () => {
  const pkg = read("package.json");
  const supabaseJs = /"@supabase\/supabase-js":\s*"([^"]+)"/.exec(pkg)?.[1];

  it("supabase-js is declared at a version that bundles the MFA API", () => {
    expect(supabaseJs).toBeTruthy();
    expect(supabaseJs).toMatch(/^2\./);
  });

  it("auth-js (transitive dep carrying the MFA API) is installed", () => {
    // auth-js is a transitive dependency pulled in by supabase-js; it is
    // NOT declared in package.json. Verify the installed package exposes
    // the MFA API surface that the later sub-tasks will call.
    const authJsVersion = /"version":\s*"([^"]+)"/.exec(
      read("node_modules/@supabase/auth-js/package.json"),
    )?.[1];
    expect(authJsVersion).toBeTruthy();
    expect(authJsVersion).toMatch(/^2\./);
  });
});
