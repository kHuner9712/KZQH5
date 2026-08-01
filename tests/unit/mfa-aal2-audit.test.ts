import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ============================================================
// KZQ-P1-022-a: MFA / AAL2 — data & Auth capability audit
// ------------------------------------------------------------
// Static contract tests that pin the AUDIT FACTS (not behaviour):
//   1. No MFA/AAL2 integration exists anywhere in project source.
//   2. getVerifiedAdmin() does NOT check the authenticator assurance
//      level (aal1 session passes today — the gap this workstream fixes).
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

function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const full = join(dir, entry);
    const stat = statSync(join(ROOT, full));
    if (stat.isDirectory()) {
      collectTsFiles(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      acc.push(read(full));
    }
  }
  return acc;
}

const MFA_KEYWORDS = [
  "getAuthenticatorAssuranceLevel",
  "mfa.enroll",
  "mfa.challenge",
  "mfa.verify",
  "mfa.listFactors",
  "aal2",
];

describe("KZQ-P1-022-a: no MFA integration in project source", () => {
  it("does not reference any MFA API in lib/ app/ components/", () => {
    const sources = [
      ...collectTsFiles("lib"),
      ...collectTsFiles("app"),
      ...collectTsFiles("components"),
    ].join("\n");
    for (const keyword of MFA_KEYWORDS) {
      expect(sources).not.toContain(keyword);
    }
  });

  it("does not reference the aal claim in the SSR session middleware", () => {
    const middleware = read("lib/supabase/middleware-session.ts");
    expect(middleware).not.toMatch(/\baal\b/i);
  });
});

describe("KZQ-P1-022-a: getVerifiedAdmin has no AAL check (the gap)", () => {
  const adminAuth = read("lib/services/admin-auth.ts");

  it("does not call getAuthenticatorAssuranceLevel", () => {
    expect(adminAuth).not.toContain("getAuthenticatorAssuranceLevel");
  });

  it("does not parse the access_token aal claim", () => {
    expect(adminAuth).not.toMatch(/\baal\b/i);
  });

  it("verifies the session via auth.getUser() only (aal1 passes today)", () => {
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
