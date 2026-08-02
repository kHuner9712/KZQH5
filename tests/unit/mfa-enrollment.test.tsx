// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MfaEnrollment } from "@/components/admin/MfaEnrollment";

// ============================================================
// KZQ-P1-022-b: admin MFA TOTP enrollment — component flow
//
// Verifies the full enrollment journey:
//   listFactors → status display → enroll → qr/secret display →
//   code input → challenge + verify → verified status.
// Also verifies every error path renders a FIXED Chinese message
// and never surfaces raw Supabase Auth text.
// ============================================================

type FactorShape = {
  id: string;
  friendly_name?: string;
  factor_type: string;
  status: string;
  created_at: string;
  updated_at?: string;
};

interface MfaMock {
  listFactors: ReturnType<typeof vi.fn>;
  enroll: ReturnType<typeof vi.fn>;
  challenge: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
  unenroll: ReturnType<typeof vi.fn>;
}

let mfaMock: MfaMock;

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      mfa: mfaMock,
    },
  }),
}));

const verifiedTotpFactor: FactorShape = {
  id: "factor-1",
  friendly_name: "My Authenticator",
  factor_type: "totp",
  status: "verified",
  created_at: "2026-07-01T00:00:00.000Z",
};

function okListFactors(verified: FactorShape[] = []) {
  mfaMock.listFactors.mockResolvedValue({
    data: { all: verified, totp: verified, phone: [], webauthn: [] },
    error: null,
  });
}

function renderEnrollment() {
  return render(<MfaEnrollment />);
}

describe("MfaEnrollment — status display", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mfaMock = {
      listFactors: vi.fn(),
      enroll: vi.fn(),
      challenge: vi.fn(),
      verify: vi.fn(),
      unenroll: vi.fn(),
    };
  });

  it("shows '未启用' when no verified TOTP factor exists and offers enroll", async () => {
    okListFactors([]);
    renderEnrollment();
    expect(await screen.findByTestId("mfa-status")).toHaveTextContent("未启用");
    expect(
      screen.getByTestId("mfa-enroll-button"),
    ).toBeInTheDocument();
    expect(mfaMock.listFactors).toHaveBeenCalledTimes(1);
  });

  it("shows '已启用' and the factor name when a verified TOTP factor exists", async () => {
    okListFactors([verifiedTotpFactor]);
    renderEnrollment();
    expect(await screen.findByTestId("mfa-status")).toHaveTextContent("已启用");
    expect(screen.getByText("My Authenticator")).toBeInTheDocument();
    expect(screen.queryByTestId("mfa-enroll-button")).not.toBeInTheDocument();
  });
});

describe("MfaEnrollment — enrollment flow", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mfaMock = {
      listFactors: vi.fn(),
      enroll: vi.fn(),
      challenge: vi.fn(),
      verify: vi.fn(),
      unenroll: vi.fn(),
    };
  });

  it("enrolls a TOTP factor and shows qr_code / secret / code input", async () => {
    okListFactors([]);
    mfaMock.enroll.mockResolvedValue({
      data: {
        id: "new-factor",
        type: "totp",
        friendly_name: "My Authenticator",
        totp: {
          qr_code: "data:image/svg+xml;utf-8,%3Csvg...%3E",
          secret: "SECRET123",
          uri: "otpauth://totp/KZQH5:admin?secret=SECRET123",
        },
      },
      error: null,
    });
    renderEnrollment();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("mfa-enroll-button"));

    expect(mfaMock.enroll).toHaveBeenCalledWith({
      factorType: "totp",
      issuer: "KZQH5",
    });
    expect(await screen.findByTestId("mfa-pending")).toBeInTheDocument();
    expect(screen.getByTestId("mfa-qr")).toHaveAttribute(
      "src",
      "data:image/svg+xml;utf-8,%3Csvg...%3E",
    );
    expect(screen.getByTestId("mfa-secret")).toHaveTextContent("SECRET123");
    expect(screen.getByTestId("mfa-code-input")).toBeInTheDocument();
  });

  it("completes enrollment: challenge + verify with the 6-digit code, then shows 已启用", async () => {
    okListFactors([]);
    mfaMock.enroll.mockResolvedValue({
      data: {
        id: "new-factor",
        type: "totp",
        totp: {
          qr_code: "data:image/svg+xml;utf-8,%3Csvg...%3E",
          secret: "SECRET123",
          uri: "otpauth://totp/KZQH5:admin?secret=SECRET123",
        },
      },
      error: null,
    });
    mfaMock.challenge.mockResolvedValue({
      data: { id: "challenge-1", type: "totp" },
      error: null,
    });
    mfaMock.verify.mockResolvedValue({ data: {}, error: null });
    // After verify, loadFactors re-reads and now sees the verified factor.
    // The FIRST listFactors call (on mount) must return empty so the
    // enroll button is available; the SECOND (after verify) returns the
    // verified factor. mockResolvedValueOnce is consumed before the base.
    mfaMock.listFactors
      .mockResolvedValueOnce({
        data: { all: [], totp: [], phone: [], webauthn: [] },
        error: null,
      })
      .mockResolvedValue({
        data: { all: [verifiedTotpFactor], totp: [verifiedTotpFactor], phone: [], webauthn: [] },
        error: null,
      });

    renderEnrollment();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("mfa-enroll-button"));
    await screen.findByTestId("mfa-pending");
    await user.type(screen.getByTestId("mfa-code-input"), "123456");
    await user.click(screen.getByTestId("mfa-confirm-button"));

    expect(mfaMock.challenge).toHaveBeenCalledWith({ factorId: "new-factor" });
    expect(mfaMock.verify).toHaveBeenCalledWith({
      factorId: "new-factor",
      challengeId: "challenge-1",
      code: "123456",
    });
    expect(await screen.findByTestId("mfa-success")).toHaveTextContent(
      "MFA 已启用",
    );
    expect(await screen.findByTestId("mfa-status")).toHaveTextContent("已启用");
    expect(screen.queryByTestId("mfa-pending")).not.toBeInTheDocument();
  });

  it("rejects a non-6-digit code locally without calling challenge", async () => {
    okListFactors([]);
    mfaMock.enroll.mockResolvedValue({
      data: {
        id: "new-factor",
        type: "totp",
        totp: {
          qr_code: "data:image/svg+xml;utf-8,%3Csvg...%3E",
          secret: "SECRET123",
          uri: "otpauth://totp/KZQH5:admin?secret=SECRET123",
        },
      },
      error: null,
    });
    renderEnrollment();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("mfa-enroll-button"));
    await screen.findByTestId("mfa-pending");
    await user.type(screen.getByTestId("mfa-code-input"), "12345");
    await user.click(screen.getByTestId("mfa-confirm-button"));

    expect(screen.getByTestId("mfa-error")).toHaveTextContent(
      "验证码不正确，请重新输入",
    );
    expect(mfaMock.challenge).not.toHaveBeenCalled();
    expect(mfaMock.verify).not.toHaveBeenCalled();
  });

  it("cancels enrollment and returns to the 未启用 state", async () => {
    okListFactors([]);
    mfaMock.enroll.mockResolvedValue({
      data: {
        id: "new-factor",
        type: "totp",
        totp: {
          qr_code: "data:image/svg+xml;utf-8,%3Csvg...%3E",
          secret: "SECRET123",
          uri: "otpauth://totp/KZQH5:admin?secret=SECRET123",
        },
      },
      error: null,
    });
    renderEnrollment();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("mfa-enroll-button"));
    await screen.findByTestId("mfa-pending");
    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.queryByTestId("mfa-pending")).not.toBeInTheDocument();
    expect(screen.getByTestId("mfa-status")).toHaveTextContent("未启用");
  });
});

describe("MfaEnrollment — error handling (fixed messages only)", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mfaMock = {
      listFactors: vi.fn(),
      enroll: vi.fn(),
      challenge: vi.fn(),
      verify: vi.fn(),
      unenroll: vi.fn(),
    };
  });

  it("shows the fixed message when verify fails with an invalid code (no raw text)", async () => {
    okListFactors([]);
    mfaMock.enroll.mockResolvedValue({
      data: {
        id: "new-factor",
        type: "totp",
        totp: {
          qr_code: "data:image/svg+xml;utf-8,%3Csvg...%3E",
          secret: "SECRET123",
          uri: "otpauth://totp/KZQH5:admin?secret=SECRET123",
        },
      },
      error: null,
    });
    mfaMock.challenge.mockResolvedValue({
      data: { id: "challenge-1", type: "totp" },
      error: null,
    });
    mfaMock.verify.mockResolvedValue({
      data: null,
      error: { message: "Invalid TOTP code", code: "invalid_code", status: 400 },
    });

    renderEnrollment();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("mfa-enroll-button"));
    await screen.findByTestId("mfa-pending");
    await user.type(screen.getByTestId("mfa-code-input"), "000000");
    await user.click(screen.getByTestId("mfa-confirm-button"));

    const alert = await screen.findByTestId("mfa-error");
    expect(alert).toHaveTextContent("验证码不正确，请重新输入");
    expect(alert).not.toHaveTextContent("Invalid TOTP code");
  });

  it("shows the fixed message when challenge fails (no raw text)", async () => {
    okListFactors([]);
    mfaMock.enroll.mockResolvedValue({
      data: {
        id: "new-factor",
        type: "totp",
        totp: {
          qr_code: "data:image/svg+xml;utf-8,%3Csvg...%3E",
          secret: "SECRET123",
          uri: "otpauth://totp/KZQH5:admin?secret=SECRET123",
        },
      },
      error: null,
    });
    mfaMock.challenge.mockResolvedValue({
      data: null,
      error: { message: "Factor is not enrolled", status: 400 },
    });

    renderEnrollment();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("mfa-enroll-button"));
    await screen.findByTestId("mfa-pending");
    await user.type(screen.getByTestId("mfa-code-input"), "123456");
    await user.click(screen.getByTestId("mfa-confirm-button"));

    const alert = await screen.findByTestId("mfa-error");
    // "Factor is not enrolled" is not a known classification → generic.
    expect(alert).toHaveTextContent("操作失败，请稍后重试");
    expect(alert).not.toHaveTextContent("Factor is not enrolled");
  });

  it("shows the fixed message when enroll fails (no raw text)", async () => {
    okListFactors([]);
    mfaMock.enroll.mockResolvedValue({
      data: null,
      error: {
        message: "A factor of this type has already been enrolled",
        code: "factor_already_enrolled",
        status: 400,
      },
    });

    renderEnrollment();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("mfa-enroll-button"));

    const alert = await screen.findByTestId("mfa-error");
    expect(alert).toHaveTextContent("该账号已启用 MFA，请勿重复绑定");
    expect(alert).not.toHaveTextContent("already been enrolled");
    expect(screen.queryByTestId("mfa-pending")).not.toBeInTheDocument();
  });

  it("shows the fixed message when listFactors fails (no raw text)", async () => {
    mfaMock.listFactors.mockResolvedValue({
      data: null,
      error: { message: "Session expired", code: "session_expired", status: 401 },
    });

    renderEnrollment();

    const alert = await screen.findByTestId("mfa-error");
    expect(alert).toHaveTextContent("会话已过期，请重新登录后再试");
    expect(alert).not.toHaveTextContent("Session expired");
  });
});
