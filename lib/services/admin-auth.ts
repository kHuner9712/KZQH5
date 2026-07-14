import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function getVerifiedAdmin() {
  try {
    const sessionClient = createServerSupabaseClient();
    const { data: { user } } = await sessionClient.auth.getUser();
    if (!user) return null;

    const adminClient = createAdminSupabaseClient();
    const { data: profile } = await adminClient
      .from("admin_profiles")
      .select("id, email")
      .eq("id", user.id)
      .maybeSingle();
    if (!profile) return null;
    return { user, profile, client: adminClient };
  } catch {
    return null;
  }
}
