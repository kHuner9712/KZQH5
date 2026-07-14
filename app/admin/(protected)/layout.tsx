import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/AdminLayout";
import { ToastProvider } from "@/components/admin/Toast";
import { countUnreadInquiries } from "@/lib/repositories/inquiries";
import { getVerifiedAdmin } from "@/lib/services/admin-auth";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // 必须先通过 Supabase Auth 服务验证 JWT，再检查 admin_profiles。
  // 不信任 getSession() 从 cookie 直接读取的未验证会话内容。
  const admin = await getVerifiedAdmin();
  if (!admin) redirect("/admin/login?error=no_permission");

  let unreadCount = 0;
  const email = admin.profile.email || admin.user.email || undefined;
  try {
    unreadCount = await countUnreadInquiries(admin.client);
  } catch {
    // 特权客户端或数据读取异常时拒绝访问，绝不降级放行。
    redirect("/admin/login?error=no_permission");
  }

  return (
    <ToastProvider>
      <AdminShell email={email} unreadCount={unreadCount}>{children}</AdminShell>
    </ToastProvider>
  );
}
