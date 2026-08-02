import type { SupabaseClient, User } from "@supabase/supabase-js";
import { cache } from "react";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { AdminProfile, Database } from "@/types/database";

export type AdminVerificationFailureReason =
  | "session-missing"
  | "session-verification-failed"
  | "aal-insufficient"
  | "admin-client-unavailable"
  | "profile-query-failed"
  | "profile-missing";

export type AdminVerificationResult =
  | {
      ok: true;
      user: User;
      profile: AdminProfile;
      client: SupabaseClient<Database>;
    }
  | {
      ok: false;
      reason: AdminVerificationFailureReason;
    };

export type GuardStage = "session" | "profile" | "data" | "mfa";

/**
 * Map a verification failure (or a downstream data-read failure) to the
 * coarse external stage that may appear in the redirect URL and logs.
 *
 * The internal `reason` is never exposed to the URL, UI, or logs — only
 * one of the four fixed stage values is returned.
 */
export function failureStage(
  result: AdminVerificationResult,
  dataError = false,
): GuardStage | null {
  if (dataError) return "data";
  if (result.ok) return null;
  switch (result.reason) {
    case "session-missing":
    case "session-verification-failed":
      return "session";
    case "aal-insufficient":
      return "mfa";
    case "admin-client-unavailable":
    case "profile-query-failed":
    case "profile-missing":
      return "profile";
  }
}

/**
 * Verify the current admin session + profile (single source of truth for
 * the admin guard, used by the protected layout, page components, and the
 * API write/read boundary).
 *
 * KZQ-P2-001: `getVerifiedAdmin` is wrapped with React `cache()` so that a
 * single request that calls it from multiple places (protected layout +
 * dashboard + analytics + product edit) only executes the expensive
 * verification once per request — `auth.getUser()`, the AAL probe and the
 * `admin_profiles` query are NOT repeated. This follows the same pattern
 * already used by `lib/queries/cms.ts` (fetchSiteSettings).
 *
 * Security properties:
 *   - Request-scoped only: React `cache()` keys the memoization on the
 *     React request dispatcher (AsyncLocalStorage), so the result NEVER
 *     leaks across users or across requests.
 *   - No request context (pure Node / tests): `cache()` passes through —
 *     every call executes for real, which is the safe lower bound (never
 *     caches identity across calls).
 *   - The service-role result is never cached to a public CDN: every
 *     caller already opts out of static rendering / caching via
 *     `force-dynamic` + `unstable_noStore()`.
 */
export const getVerifiedAdmin = cache(
  async function getVerifiedAdmin(): Promise<AdminVerificationResult> {
    // Stage 1: verify the user session via Supabase Auth.
    // Read both `user` and `error` to distinguish between "no session"
    // (session-missing) and "session verification failed" (e.g. JWT expired
    // or cookie tampered — session-verification-failed).
    let sessionClient: Awaited<ReturnType<typeof createServerSupabaseClient>>;
    try {
      sessionClient = await createServerSupabaseClient();
    } catch {
      return { ok: false, reason: "session-verification-failed" };
    }

    let user: User | null = null;
    let authError = false;
    try {
      const { data, error } = await sessionClient.auth.getUser();
      if (error) {
        authError = true;
      } else {
        user = data.user;
      }
    } catch {
      authError = true;
    }

    if (authError) {
      return { ok: false, reason: "session-verification-failed" };
    }
    if (!user) {
      return { ok: false, reason: "session-missing" };
    }

    // Stage 1.5 (KZQ-P1-022-d): AAL2 server guard.
    //
    // An admin whose account has a VERIFIED MFA factor must reach the
    // dashboard with an aal2 session (password + verified factor). The
    // signed-in session is aal1 right after password login; the MFA
    // challenge (app/admin/mfa/challenge) upgrades it to aal2 via
    // mfa.verify(). Any direct visit to /admin with an aal1 session and a
    // verified factor must be denied and routed to the challenge page.
    //
    // Accounts WITHOUT a verified factor (nextLevel === "aal1") are NOT
    // blocked — there is nothing to challenge for them, and forcing aal2
    // would lock out every admin who never enrolled MFA (and also block
    // /admin/security where they would enroll).
    //
    // Fail-closed: an AAL probe error/exception is treated as
    // aal-insufficient (we cannot confirm the assurance level, so we must
    // not admit). The challenge page re-evaluates and shows a fixed error.
    try {
      const { data: aal, error: aalError } =
        await sessionClient.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aalError || !aal) {
        return { ok: false, reason: "aal-insufficient" };
      }
      if (aal.nextLevel === "aal2" && aal.currentLevel !== "aal2") {
        return { ok: false, reason: "aal-insufficient" };
      }
    } catch {
      return { ok: false, reason: "aal-insufficient" };
    }

    // Stage 2: create the privileged admin client (service_role).
    // Throws when NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is
    // missing — classified as admin-client-unavailable.
    let adminClient: SupabaseClient<Database>;
    try {
      adminClient = createAdminSupabaseClient();
    } catch {
      return { ok: false, reason: "admin-client-unavailable" };
    }

    // Stage 3: query admin_profiles for the verified user id.
    // Phase 3: now selects role + updated_at for RBAC and audit logging.
    // Distinguish between a query error (profile-query-failed) and a
    // missing profile row (profile-missing).
    let profile: AdminProfile | null = null;
    let profileError = false;
    try {
      const { data, error } = await adminClient
        .from("admin_profiles")
        .select("id, email, role, created_at, updated_at")
        .eq("id", user.id)
        .maybeSingle();
      if (error) {
        profileError = true;
      } else {
        profile = data as AdminProfile | null;
      }
    } catch {
      profileError = true;
    }

    if (profileError) {
      return { ok: false, reason: "profile-query-failed" };
    }
    if (!profile) {
      return { ok: false, reason: "profile-missing" };
    }

    return { ok: true, user, profile, client: adminClient };
  },
);
