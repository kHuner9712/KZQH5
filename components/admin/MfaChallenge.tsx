"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { MFA_ERROR_MESSAGES, mapMfaError } from "@/lib/security/mfa-errors";
import { Button } from "@/components/ui/Button";
import { AlertCircle, Loader2, ShieldCheck, Smartphone } from "lucide-react";

// ============================================================
// KZQ-P1-022-c: Admin MFA TOTP challenge
// ------------------------------------------------------------
// Renders at /admin/mfa/challenge AFTER the password sign-in when
// the admin has a verified TOTP factor. The password session is
// aal1; this page upgrades it to aal2 before the admin reaches
// the dashboard.
//
// Flow (all calls go through the browser Supabase client using the
// signed-in admin session — MFA challenge/verify require the user's
// own access_token and cannot be driven with the service-role key):
//
//   1. `mfa.getAuthenticatorAssuranceLevel()`:
//        - no session (currentLevel null)      → redirect /admin/login
//        - currentLevel === "aal2"             → redirect /admin (done)
//        - nextLevel !== "aal2" (no factor)    → redirect /admin (no MFA)
//        - nextLevel === "aal2" (factor exists) → continue to challenge
//   2. `mfa.listFactors()` → pick the verified TOTP factor.
//   3. `mfa.challenge({ factorId })` → one-time challenge id.
//   4. User enters the 6-digit code →
//      `mfa.verify({ factorId, challengeId, code })` — on success the
//      SDK saves the upgraded (aal2) session, then we go to /admin.
//      On failure the challenge id is consumed, so a fresh challenge
//      is issued before the next attempt.
//
// Security rules:
//   - This page is OUTSIDE the (protected) group on purpose: the
//     aal1 session is valid and getVerifiedAdmin() would pass, so the
//     challenge must gate the dashboard, not live inside it.
//   - All errors are mapped to fixed Chinese messages via
//     mapMfaError(); raw Supabase text is never rendered.
//   - The TOTP code is never sent to our own API — only to Supabase
//     Auth, as required by the MFA protocol.
// ============================================================

interface VerifiedFactor {
  id: string;
}

export function MfaChallenge() {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [factor, setFactor] = useState<VerifiedFactor | null>(null);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");

  const issueChallenge = useCallback(
    async (supabase: ReturnType<typeof createBrowserSupabaseClient>, factorId: string) => {
      const { data: challengeData, error: challengeError } =
        await supabase.auth.mfa.challenge({ factorId });
      if (challengeError) {
        setError(mapMfaError(challengeError));
        return false;
      }
      if (!challengeData?.id) {
        setError(MFA_ERROR_MESSAGES.UNEXPECTED);
        return false;
      }
      setChallengeId(challengeData.id);
      return true;
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = createBrowserSupabaseClient();

        // Stage 1: what is the current assurance level?
        const { data: aal, error: aalError } =
          await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (aalError) {
          setError(mapMfaError(aalError));
          return;
        }
        if (!aal || aal.currentLevel === null) {
          // No session (SDK returns a data object with null levels when
          // there is no session) — back to the login page.
          router.replace("/admin/login");
          return;
        }
        if (aal.currentLevel === "aal2") {
          // Already verified — straight to the dashboard.
          router.replace("/admin");
          return;
        }
        if (aal.nextLevel !== "aal2") {
          // No verified factor — nothing to challenge.
          router.replace("/admin");
          return;
        }

        // Stage 2: locate the verified TOTP factor.
        const { data: factors, error: factorsError } =
          await supabase.auth.mfa.listFactors();
        if (factorsError) {
          setError(mapMfaError(factorsError));
          return;
        }
        const verifiedTotp = (factors?.totp ?? []).filter(
          (f) => f.status === "verified",
        );
        if (verifiedTotp.length === 0) {
          // nextLevel promised aal2 but no verified TOTP factor — this is
          // an inconsistent state; do NOT let the admin into the dashboard.
          setError(MFA_ERROR_MESSAGES.GENERIC);
          return;
        }
        const factorId = verifiedTotp[0].id;

        // Stage 3: issue the challenge.
        const ok = await issueChallenge(supabase, factorId);
        if (cancelled) return;
        if (!ok) return;
        setFactor({ id: factorId });
      } catch {
        setError(MFA_ERROR_MESSAGES.UNEXPECTED);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, issueChallenge]);

  async function handleVerify() {
    if (!factor || !challengeId) return;
    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      setError(MFA_ERROR_MESSAGES.INVALID_CODE);
      return;
    }
    setVerifying(true);
    setError("");
    try {
      const supabase = createBrowserSupabaseClient();
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: factor.id,
        challengeId,
        code: trimmed,
      });
      if (verifyError) {
        // The challenge id is single-use: issue a fresh one for the
        // next attempt. Keep the page on a fixed error message only.
        setError(mapMfaError(verifyError));
        setCode("");
        await issueChallenge(supabase, factor.id);
        return;
      }
      // verify() saved the upgraded (aal2) session — enter the dashboard.
      router.replace("/admin");
      router.refresh();
    } catch {
      setError(MFA_ERROR_MESSAGES.UNEXPECTED);
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="bg-hero-gradient relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      <div className="bg-grid pointer-events-none absolute inset-0 opacity-40" />
      <div className="relative w-full max-w-sm">
        <div className="mb-8 text-center text-white">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-white/10 text-xl font-bold text-gradient-gold">
            KZQ
          </div>
          <h1 className="mt-4 text-xl font-bold">双重验证</h1>
          <p className="mt-1 text-xs text-gray-400">
            请输入身份验证器 App 中显示的 6 位验证码以继续
          </p>
        </div>

        <div className="rounded-2xl bg-white p-6 shadow-2xl">
          {loading ? (
            <div className="flex h-32 items-center justify-center text-gray-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <div className="space-y-4">
              {error && (
                <div
                  data-testid="mfa-challenge-error"
                  className="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-xs text-red-700"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              {factor && challengeId && (
                <>
                  <div className="flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-xs text-emerald-700">
                    <ShieldCheck className="h-4 w-4 shrink-0" />
                    <span>该账号已启用双重验证，需要验证码确认身份</span>
                  </div>

                  <div className="space-y-1.5">
                    <label
                      htmlFor="mfa-challenge-code"
                      className="block text-sm font-medium text-gray-700"
                    >
                      验证码
                    </label>
                    <div className="relative">
                      <Smartphone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                      <input
                        id="mfa-challenge-code"
                        data-testid="mfa-challenge-code-input"
                        value={code}
                        onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, ""))}
                        inputMode="numeric"
                        maxLength={6}
                        placeholder="6 位验证码"
                        autoComplete="one-time-code"
                        autoFocus
                        className="h-11 w-full rounded-lg border border-gray-200 bg-white pl-9 pr-3 text-sm outline-none transition focus:border-steel focus:ring-2 focus:ring-steel/20"
                      />
                    </div>
                  </div>

                  <Button
                    type="button"
                    size="lg"
                    className="w-full"
                    loading={verifying}
                    disabled={verifying}
                    onClick={handleVerify}
                    data-testid="mfa-challenge-verify-button"
                  >
                    验证并进入后台
                  </Button>
                </>
              )}

              {!factor && !challengeId && !error && (
                <p className="text-center text-xs text-gray-500">
                  正在验证身份…
                </p>
              )}
            </div>
          )}
        </div>

        <p className="mt-4 text-center text-[11px] text-gray-500">
          未绑定身份验证器的账号无需此步骤，将自动进入后台。
        </p>
      </div>
    </div>
  );
}
