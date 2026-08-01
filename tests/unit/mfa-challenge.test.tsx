// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MfaChallenge } from "@/components/admin/MfaChallenge";

// ============================================================
// KZQ-P1-022-c: admin MFA TOTP challenge — component flow
//
// Verifies the challenge page gates the dashboard:
//   - aal1 + verified factor → challenge UI → verify → /admin
//   - no session → /admin/login
//   - already aal2 → /admin
//   - no verified factor → /admin
//   - every error path renders a FIXED Chinese message and never
//     surfaces raw Supabase Auth text.
// ============================================================

const replaceMock = vi.fn();
const refreshMock = vi.fn();

// Stable router object: Next.js useRouter() returns a stable reference
// across renders; the mock must mirror that, otherwise an effect keyed
// on `router` re-runs on every state update (re-issuing challenges).
const routerMock = { replace: replaceMock, refresh: refreshMock, push: replaceMock };

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

interface MfaMock {
  getAuthenticatorAssuranceLevel: ReturnType<typeof vi.fn>;
  listFactors: ReturnType<typeof vi.fn>;
  challenge: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
}

let mfaMock: MfaMock;

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      mfa: mfaMock,
    },
  }),
}));

const verifiedTotpFactor = {
  id: "factor-1",
  factor_type: "totp",
  status: "verified",
  created_at: "2026-07-01T00:00:00.000Z",
};

function stubAal(overrides: Partial<Record<"currentLevel" | "nextLevel", string | null>> = {}) {
  mfaMock.getAuthenticatorAssuranceLevel.mockResolvedValue({
    data: {
      // Explicit null must survive (no-session case): use `in` checks
      // instead of `??` which would replace null with the default.
      currentLevel:
        "currentLevel" in overrides ? overrides.currentLevel : "aal1",
      nextLevel: "nextLevel" in overrides ? overrides.nextLevel : "aal2",
      currentAuthenticationMethods: ["password"],
    },
    error: null,
  });
}

function stubChallenge() {
  mfaMock.challenge.mockResolvedValue({
    data: { id: "challenge-1", type: "totp" },
    error: null,
  });
}

function renderChallenge() {
  return render(<MfaChallenge />);
}

describe("MfaChallenge — routing gates", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    replaceMock.mockClear();
    refreshMock.mockClear();
    mfaMock = {
      getAuthenticatorAssuranceLevel: vi.fn(),
      listFactors: vi.fn(),
      challenge: vi.fn(),
      verify: vi.fn(),
    };
  });

  it("redirects to /admin/login when there is no session (currentLevel null)", async () => {
    stubAal({ currentLevel: null, nextLevel: null });
    renderChallenge();
    await vi.waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/admin/login");
    });
  });

  it("redirects to /admin when the session is already aal2", async () => {
    stubAal({ currentLevel: "aal2", nextLevel: "aal2" });
    renderChallenge();
    await vi.waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/admin");
    });
  });

  it("redirects to /admin when the account has no verified factor (nextLevel aal1)", async () => {
    stubAal({ currentLevel: "aal1", nextLevel: "aal1" });
    renderChallenge();
    await vi.waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/admin");
    });
    // No listFactors / challenge calls when no factor is promised.
    expect(mfaMock.listFactors).not.toHaveBeenCalled();
    expect(mfaMock.challenge).not.toHaveBeenCalled();
  });
});

describe("MfaChallenge — challenge flow", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    replaceMock.mockClear();
    refreshMock.mockClear();
    mfaMock = {
      getAuthenticatorAssuranceLevel: vi.fn(),
      listFactors: vi.fn(),
      challenge: vi.fn(),
      verify: vi.fn(),
    };
  });

  it("shows the code input when a verified TOTP factor exists and a challenge is issued", async () => {
    stubAal({ currentLevel: "aal1", nextLevel: "aal2" });
    mfaMock.listFactors.mockResolvedValue({
      data: { all: [verifiedTotpFactor], totp: [verifiedTotpFactor], phone: [], webauthn: [] },
      error: null,
    });
    stubChallenge();
    renderChallenge();

    expect(await screen.findByTestId("mfa-challenge-code-input")).toBeInTheDocument();
    expect(mfaMock.challenge).toHaveBeenCalledWith({ factorId: "factor-1" });
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("verifies the code and enters the dashboard on success", async () => {
    stubAal({ currentLevel: "aal1", nextLevel: "aal2" });
    mfaMock.listFactors.mockResolvedValue({
      data: { all: [verifiedTotpFactor], totp: [verifiedTotpFactor], phone: [], webauthn: [] },
      error: null,
    });
    stubChallenge();
    mfaMock.verify.mockResolvedValue({ data: {}, error: null });

    renderChallenge();
    const user = userEvent.setup();

    await screen.findByTestId("mfa-challenge-code-input");
    await user.type(screen.getByTestId("mfa-challenge-code-input"), "123456");
    await user.click(screen.getByTestId("mfa-challenge-verify-button"));

    expect(mfaMock.verify).toHaveBeenCalledWith({
      factorId: "factor-1",
      challengeId: "challenge-1",
      code: "123456",
    });
    await vi.waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/admin");
    });
    expect(refreshMock).toHaveBeenCalled();
  });

  it("rejects a non-6-digit code locally without calling verify", async () => {
    stubAal({ currentLevel: "aal1", nextLevel: "aal2" });
    mfaMock.listFactors.mockResolvedValue({
      data: { all: [verifiedTotpFactor], totp: [verifiedTotpFactor], phone: [], webauthn: [] },
      error: null,
    });
    stubChallenge();

    renderChallenge();
    const user = userEvent.setup();

    await screen.findByTestId("mfa-challenge-code-input");
    await user.type(screen.getByTestId("mfa-challenge-code-input"), "12345");
    await user.click(screen.getByTestId("mfa-challenge-verify-button"));

    expect(screen.getByTestId("mfa-challenge-error")).toHaveTextContent(
      "验证码不正确，请重新输入",
    );
    expect(mfaMock.verify).not.toHaveBeenCalled();
  });
});

describe("MfaChallenge — error handling (fixed messages only)", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    replaceMock.mockClear();
    refreshMock.mockClear();
    mfaMock = {
      getAuthenticatorAssuranceLevel: vi.fn(),
      listFactors: vi.fn(),
      challenge: vi.fn(),
      verify: vi.fn(),
    };
  });

  it("shows the fixed message when verify fails with an invalid code (no raw text), then re-issues a challenge", async () => {
    stubAal({ currentLevel: "aal1", nextLevel: "aal2" });
    mfaMock.listFactors.mockResolvedValue({
      data: { all: [verifiedTotpFactor], totp: [verifiedTotpFactor], phone: [], webauthn: [] },
      error: null,
    });
    stubChallenge();
    mfaMock.verify.mockResolvedValue({
      data: null,
      error: { message: "Invalid TOTP code", code: "invalid_code", status: 400 },
    });

    renderChallenge();
    const user = userEvent.setup();

    await screen.findByTestId("mfa-challenge-code-input");
    await user.type(screen.getByTestId("mfa-challenge-code-input"), "000000");
    await user.click(screen.getByTestId("mfa-challenge-verify-button"));

    const alert = await screen.findByTestId("mfa-challenge-error");
    expect(alert).toHaveTextContent("验证码不正确，请重新输入");
    expect(alert).not.toHaveTextContent("Invalid TOTP code");
    // A fresh challenge is issued for the next attempt.
    expect(mfaMock.challenge).toHaveBeenCalledTimes(2);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("shows the fixed message when challenge issuance fails (no raw text)", async () => {
    stubAal({ currentLevel: "aal1", nextLevel: "aal2" });
    mfaMock.listFactors.mockResolvedValue({
      data: { all: [verifiedTotpFactor], totp: [verifiedTotpFactor], phone: [], webauthn: [] },
      error: null,
    });
    mfaMock.challenge.mockResolvedValue({
      data: null,
      error: { message: "Factor not enrolled", status: 400 },
    });

    renderChallenge();

    const alert = await screen.findByTestId("mfa-challenge-error");
    // "Factor not enrolled" is not a known classification → generic.
    expect(alert).toHaveTextContent("操作失败，请稍后重试");
    expect(alert).not.toHaveTextContent("Factor not enrolled");
    expect(screen.queryByTestId("mfa-challenge-code-input")).not.toBeInTheDocument();
  });

  it("shows the fixed message when the AAL probe fails (no raw text)", async () => {
    mfaMock.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: null,
      error: { message: "Session expired", code: "session_expired", status: 401 },
    });

    renderChallenge();

    const alert = await screen.findByTestId("mfa-challenge-error");
    expect(alert).toHaveTextContent("会话已过期，请重新登录后再试");
    expect(alert).not.toHaveTextContent("Session expired");
    // No redirect on probe failure — stay on the gate, do not bypass.
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("shows the fixed generic message when listFactors returns no verified TOTP but nextLevel claims aal2", async () => {
    stubAal({ currentLevel: "aal1", nextLevel: "aal2" });
    mfaMock.listFactors.mockResolvedValue({
      data: { all: [], totp: [], phone: [], webauthn: [] },
      error: null,
    });

    renderChallenge();

    const alert = await screen.findByTestId("mfa-challenge-error");
    expect(alert).toHaveTextContent("操作失败，请稍后重试");
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("shows the fixed unexpected message when an exception escapes the flow", async () => {
    mfaMock.getAuthenticatorAssuranceLevel.mockRejectedValue(
      new Error("createBrowserClient: env vars missing"),
    );

    renderChallenge();

    const alert = await screen.findByTestId("mfa-challenge-error");
    expect(alert).toHaveTextContent("操作异常，请稍后重试");
    expect(alert).not.toHaveTextContent("env vars missing");
  });
});
