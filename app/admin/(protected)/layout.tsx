import { unstable_noStore as noStore } from "next/cache";
import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/AdminLayout";
import { ToastProvider } from "@/components/admin/Toast";
import {
  ADMIN_DATA_LOG_CODE,
  type AdminDataFailureCause,
} from "@/lib/services/admin-data-error";
import { UnreadInquiryCountError, countUnreadInquiries } from "@/lib/repositories/inquiries";
import { getVerifiedAdmin } from "@/lib/services/admin-auth";

// Administrator pages must never be cached or statically rendered.
// Auth cookies and admin state are per-request, so force dynamic rendering
// and emit a no-store header to prevent any intermediate CDN caching.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const STAGE_LOG_CODE = {
  session: "ADMIN_GUARD_SESSION",
  profile: "ADMIN_GUARD_PROFILE",
} as const;

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Explicitly opt out of static rendering before any auth work.
  noStore();

  const admin = await getVerifiedAdmin();

  // Stage 1-3 failure: session or profile verification failed.
  // Map the internal reason to a coarse external stage for the redirect URL.
  if (!admin.ok) {
    const isSession =
      admin.reason === "session-missing" ||
      admin.reason === "session-verification-failed";
    const stage = isSession ? "session" : "profile";
    console.warn(STAGE_LOG_CODE[stage]);
    redirect(`/admin/login?error=admin_guard&stage=${stage}`);
  }

  // Stage 4: protected data-read. On failure, deny access with a coarse
  // `cause` so operators can triage without exposing sensitive payload.
  let unreadCount = 0;
  try {
    unreadCount = await countUnreadInquiries(admin.client);
  } catch (err) {
    const cause: AdminDataFailureCause =
      err instanceof UnreadInquiryCountError ? err.causeCode : "unknown";
    // Single fixed string argument only. No error object, no stack, no
    // message, no second argument.
    console.warn(ADMIN_DATA_LOG_CODE[cause]);
    redirect(`/admin/login?error=admin_guard&stage=data&cause=${cause}`);
  }

  const email = admin.profile.email || admin.user.email || undefined;

  return (
    <ToastProvider>
      <AdminShell email={email} unreadCount={unreadCount}>{children}</AdminShell>
    </ToastProvider>
  );
}
