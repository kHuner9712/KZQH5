"use client";

import { useCallback, useEffect, useState } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { MFA_ERROR_MESSAGES, mapMfaError } from "@/lib/security/mfa-errors";
import { Button } from "@/components/ui/Button";
import { AlertCircle, CheckCircle2, Loader2, QrCode, Smartphone } from "lucide-react";

// ============================================================
// KZQ-P1-022-b: Admin MFA TOTP factor enrollment
// ------------------------------------------------------------
// Flow (all calls go through the browser Supabase client using the
// signed-in admin session — the MFA API requires the user's own
// access_token and cannot be driven with the service-role key):
//
//   1. On mount: `auth.mfa.listFactors()` — show verified TOTP
//      factors (status is NOT persisted in our DB; the auth schema
//      owns MFA state per docs/SECURITY_AUDIT_MFA_AAL2.md §2).
//   2. "启用 MFA" → `auth.mfa.enroll({ factorType: "totp" })` —
//      display qr_code (data:image/svg+xml;utf-8,...), secret and
//      totp_uri so the admin can scan or type it into an
//      authenticator app.
//   3. Confirm with a 6-digit code →
//      `auth.mfa.challenge({ factorId })` +
//      `auth.mfa.verify({ factorId, challengeId, code })`.
//   4. On success the factor is verified; listFactors is re-read.
//
// Security rules:
//   - qr_code / secret / totp_uri are session secrets — NEVER
//     logged, never sent to our own API, shown only during the
//     enrollment step.
//   - All errors are mapped to fixed Chinese messages via
//     mapMfaError(); raw Supabase text is never rendered.
//   - Enrollment is a session-scoped operation; the (protected)
//     layout already ran getVerifiedAdmin() before this page.
// ============================================================

/** Fixed issuer label embedded in the TOTP URI. */
const MFA_ISSUER = "KZQH5";

interface VerifiedFactor {
  id: string;
  friendly_name?: string;
  created_at: string;
}

interface PendingEnrollment {
  factorId: string;
  qrCode: string;
  secret: string;
  uri: string;
}

export function MfaEnrollment() {
  const [loading, setLoading] = useState(true);
  const [factors, setFactors] = useState<VerifiedFactor[]>([]);
  const [enrolling, setEnrolling] = useState(false);
  const [pending, setPending] = useState<PendingEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const loadFactors = useCallback(async () => {
    try {
      const supabase = createBrowserSupabaseClient();
      const { data, error: err } = await supabase.auth.mfa.listFactors();
      if (err) {
        setError(mapMfaError(err));
        setFactors([]);
        return;
      }
      const verified = (data?.totp ?? []).filter((f) => f.status === "verified");
      setFactors(
        verified.map((f) => ({
          id: f.id,
          friendly_name: f.friendly_name,
          created_at: f.created_at,
        })),
      );
    } catch {
      setError(MFA_ERROR_MESSAGES.UNEXPECTED);
      setFactors([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFactors();
  }, [loadFactors]);

  async function handleStartEnroll() {
    setError("");
    setSuccess("");
    setEnrolling(true);
    try {
      const supabase = createBrowserSupabaseClient();
      const { data, error: err } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        issuer: MFA_ISSUER,
      });
      if (err) {
        setError(mapMfaError(err));
        return;
      }
      // The SDK returns a discriminated union; TOTP enrollment always
      // carries totp. Guard the shape at runtime (never assume).
      if (!data || data.type !== "totp" || !data.totp) {
        setError(MFA_ERROR_MESSAGES.UNEXPECTED);
        return;
      }
      setPending({
        factorId: data.id,
        qrCode: data.totp.qr_code,
        secret: data.totp.secret,
        uri: data.totp.uri,
      });
      setCode("");
    } catch {
      setError(MFA_ERROR_MESSAGES.UNEXPECTED);
    } finally {
      setEnrolling(false);
    }
  }

  async function handleConfirm() {
    if (!pending) return;
    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      setError(MFA_ERROR_MESSAGES.INVALID_CODE);
      return;
    }
    setError("");
    setVerifying(true);
    try {
      const supabase = createBrowserSupabaseClient();
      const { data: challengeData, error: challengeError } =
        await supabase.auth.mfa.challenge({ factorId: pending.factorId });
      if (challengeError) {
        setError(mapMfaError(challengeError));
        return;
      }
      if (!challengeData?.id) {
        setError(MFA_ERROR_MESSAGES.UNEXPECTED);
        return;
      }
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: pending.factorId,
        challengeId: challengeData.id,
        code: trimmed,
      });
      if (verifyError) {
        setError(mapMfaError(verifyError));
        return;
      }
      setPending(null);
      setCode("");
      setSuccess("MFA 已启用，后续登录将要求身份验证器验证码");
      await loadFactors();
    } catch {
      setError(MFA_ERROR_MESSAGES.UNEXPECTED);
    } finally {
      setVerifying(false);
    }
  }

  function handleCancel() {
    setPending(null);
    setCode("");
    setError("");
  }

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center text-gray-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 状态卡片 */}
      <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-100 sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-graphite">双重验证（MFA）</h2>
            <p className="mt-0.5 text-xs text-gray-400">
              使用身份验证器 App（如 Google Authenticator）绑定 TOTP 因子
            </p>
          </div>
          {factors.length > 0 ? (
            <span
              data-testid="mfa-status"
              className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700"
            >
              <CheckCircle2 className="h-3.5 w-3.5" /> 已启用
            </span>
          ) : (
            <span
              data-testid="mfa-status"
              className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-500"
            >
              <Smartphone className="h-3.5 w-3.5" /> 未启用
            </span>
          )}
        </div>

        {error && (
          <div
            data-testid="mfa-error"
            className="mb-4 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-xs text-red-700"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {success && (
          <div
            data-testid="mfa-success"
            className="mb-4 flex items-start gap-2 rounded-lg bg-emerald-50 p-3 text-xs text-emerald-700"
          >
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{success}</span>
          </div>
        )}

        {factors.length > 0 && (
          <ul className="space-y-2">
            {factors.map((f) => (
              <li
                key={f.id}
                className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-3 py-2.5 text-sm"
              >
                <span className="text-gray-700">
                  {f.friendly_name || "TOTP 身份验证器"}
                </span>
                <span className="text-xs text-gray-400">
                  绑定于 {new Date(f.created_at).toLocaleDateString("zh-CN")}
                </span>
              </li>
            ))}
          </ul>
        )}

        {factors.length === 0 && !pending && (
          <div className="rounded-lg border border-dashed border-gray-300 p-4 text-center">
            <p className="text-xs text-gray-500">
              尚未启用 MFA。启用后，登录后台需要同时输入密码和身份验证器验证码。
            </p>
            <Button
              className="mt-4"
              onClick={handleStartEnroll}
              loading={enrolling}
              data-testid="mfa-enroll-button"
            >
              启用 MFA
            </Button>
          </div>
        )}
      </section>

      {/* 绑定流程 */}
      {pending && (
        <section
          data-testid="mfa-pending"
          className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-100 sm:p-6"
        >
          <div className="mb-4">
            <h2 className="text-sm font-semibold text-graphite">绑定身份验证器</h2>
            <p className="mt-0.5 text-xs text-gray-400">
              使用身份验证器 App 扫描下方二维码，或手动输入密钥，然后输入 App 中显示的 6 位验证码完成绑定。
            </p>
          </div>

          <div className="flex flex-col items-start gap-6 sm:flex-row">
            <div className="flex flex-col items-center gap-2">
              <div className="rounded-xl border border-gray-200 p-3">
                {/* qr_code is a data:image/svg+xml;utf-8,... URI returned by the SDK */}
                <img
                  data-testid="mfa-qr"
                  src={pending.qrCode}
                  alt="TOTP 二维码"
                  className="h-44 w-44"
                />
              </div>
              <span className="flex items-center gap-1 text-[11px] text-gray-400">
                <QrCode className="h-3 w-3" /> 扫描二维码
              </span>
            </div>

            <div className="min-w-0 flex-1 space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-ink-soft">
                  手动密钥（密钥仅在此处展示一次）
                </label>
                <code
                  data-testid="mfa-secret"
                  className="block break-all rounded-md border border-ink-line bg-gray-50 px-3 py-2 text-sm text-ink"
                >
                  {pending.secret}
                </code>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="mfa-code" className="block text-xs font-medium text-ink-soft">
                  验证码
                </label>
                <input
                  id="mfa-code"
                  data-testid="mfa-code-input"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, ""))}
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="6 位验证码"
                  autoComplete="one-time-code"
                  className="h-11 w-44 rounded-md border border-ink-line bg-white px-3.5 text-sm text-ink outline-none transition placeholder:text-ink-mute focus:border-gold focus:ring-2 focus:ring-gold/15"
                />
              </div>

              <div className="flex items-center gap-2">
                <Button
                  onClick={handleConfirm}
                  loading={verifying}
                  disabled={verifying}
                  data-testid="mfa-confirm-button"
                >
                  确认绑定
                </Button>
                <Button
                  variant="ghost"
                  onClick={handleCancel}
                  disabled={verifying}
                >
                  取消
                </Button>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
