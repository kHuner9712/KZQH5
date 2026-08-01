import { Suspense } from "react";
import { MfaChallenge } from "@/components/admin/MfaChallenge";

// KZQ-P1-022-c: MFA challenge gate page.
//
// Lives OUTSIDE the app/admin/(protected) route group on purpose:
// the (protected) layout calls getVerifiedAdmin() (password session
// is valid at aal1), which would let an admin reach the dashboard
// without completing the MFA challenge. This standalone page gates
// the dashboard entry until the TOTP code is verified (session
// upgraded to aal2).
export default function AdminMfaChallengePage() {
  return (
    <Suspense fallback={null}>
      <MfaChallenge />
    </Suspense>
  );
}
