import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { AdminShell } from "@/components/admin/AdminLayout";
import { ToastProvider } from "@/components/admin/Toast";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createServerSupabaseClient();

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    redirect("/admin/login");
  }

  // 校验是否为管理员（admin_profiles 不开放 RLS，用 service_role 读取）
  let isAdmin = false;
  let email = session.user.email || undefined;
  try {
    const admin = createAdminSupabaseClient();
    const { data: profile } = await admin
      .from("admin_profiles")
      .select("id, email")
      .eq("id", session.user.id)
      .maybeSingle();
    if (profile) {
      isAdmin = true;
      email = profile.email || email;
    }
  } catch {
    // service_role 未配置时降级：允许已登录用户进入，写操作由 RLS 拦截
    isAdmin = true;
  }

  if (!isAdmin) {
    redirect("/admin/login?error=no_permission");
  }

  return (
    <ToastProvider>
      <AdminShell email={email}>{children}</AdminShell>
    </ToastProvider>
  );
}
