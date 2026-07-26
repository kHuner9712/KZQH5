import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { AdminProfile, Database } from "@/types/database";

export type AdminVerificationFailureReason =
  | "session-missing"
  | "session-verification-failed"
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

export type GuardStage = "session" | "profile" | "data";

/**
 * Map a verification failure (or a downstream data-read failure) to the
 * coarse external stage that may appear in the redirect URL and logs.
 *
 * The internal `reason` is never exposed to the URL, UI, or logs — only
 * one of the three fixed stage values is returned.
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
    case "admin-client-unavailable":
    case "profile-query-failed":
    case "profile-missing":
      return "profile";
  }
}

export async function getVerifiedAdmin(): Promise<AdminVerificationResult> {
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
}
