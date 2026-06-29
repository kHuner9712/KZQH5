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

  // 校验是否为管理员（admin_profiles 不开放 RLS，必须用 service_role 读取）
  // service_role 缺失或读取异常时，必须拒绝访问，绝不降级放行
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
    // service_role 未配置或读取失败：拒绝访问，跳转登录页并提示
    redirect("/admin/login?error=no_permission");
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
