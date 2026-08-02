// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "@/app/admin/login/LoginForm";

// ============================================================
// KZQ-P1-020: admin login form — fixed error UI
//
// Verifies the login form NEVER renders the raw Supabase Auth
// message and always shows one of the fixed Chinese messages.
// ============================================================

const pushMock = vi.fn();
const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
  useSearchParams: () => new URLSearchParams(),
}));

const signInMock = vi.fn();
const getAalMock = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      signInWithPassword: signInMock,
      mfa: {
        getAuthenticatorAssuranceLevel: getAalMock,
      },
    },
  }),
}));

async function submitCredentials(email = "admin@kzq.com", password = "secret") {
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText("admin@kzq.com"), email);
  await user.type(screen.getByPlaceholderText("••••••••"), password);
  await user.click(screen.getByRole("button", { name: "登录" }));
}

/** aal1 session with no verified factor — no MFA challenge needed. */
function stubAal1() {
  getAalMock.mockResolvedValue({
    data: {
      currentLevel: "aal1",
      nextLevel: "aal1",
      currentAuthenticationMethods: ["password"],
    },
    error: null,
  });
}

describe("LoginForm — error standardization", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    pushMock.mockClear();
    refreshMock.mockClear();
    signInMock.mockReset();
    getAalMock.mockReset();
    // Default: aal1 session without MFA — sign-in proceeds to /admin.
    stubAal1();
    // Default guard response: allowed (200). Individual tests override.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ),
    );
  });

  it("shows the fixed Chinese message for invalid credentials (no raw Supabase text)", async () => {
    signInMock.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Invalid login credentials", code: "invalid_credentials", status: 400 },
    });
    render(<LoginForm />);
    await submitCredentials();
    const alert = screen.getByTestId("login-auth-error");
    expect(alert).toHaveTextContent("邮箱或密码错误，请重新输入");
    expect(alert).not.toHaveTextContent("Invalid login credentials");
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("shows the fixed Chinese message for an unconfirmed email", async () => {
    signInMock.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Email not confirmed", code: "email_not_confirmed", status: 400 },
    });
    render(<LoginForm />);
    await submitCredentials();
    const alert = screen.getByTestId("login-auth-error");
    expect(alert).toHaveTextContent("邮箱尚未验证，请先完成邮箱验证后再登录");
    expect(alert).not.toHaveTextContent("Email not confirmed");
  });

  it("never shows the raw message for an unrecognized auth error", async () => {
    signInMock.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Internal provider detail: retry failed", status: 500 },
    });
    render(<LoginForm />);
    await submitCredentials();
    const alert = screen.getByTestId("login-auth-error");
    expect(alert).toHaveTextContent("登录失败，请检查邮箱和密码后重试");
    expect(alert).not.toHaveTextContent("Internal provider detail");
  });

  it("shows the fixed unexpected message when the client init throws (no raw exception text)", async () => {
    signInMock.mockRejectedValue(new Error("createBrowserClient: env vars missing (SECRET_HINT)"));
    render(<LoginForm />);
    await submitCredentials();
    const alert = screen.getByTestId("login-auth-error");
    expect(alert).toHaveTextContent("登录异常，请稍后重试");
    expect(alert).not.toHaveTextContent("env vars missing");
    expect(alert).not.toHaveTextContent("SECRET_HINT");
  });

  it("redirects to /admin on success and clears any prior error", async () => {
    signInMock.mockResolvedValue({ data: { user: {}, session: {} }, error: null });
    render(<LoginForm />);
    await submitCredentials();
    expect(pushMock).toHaveBeenCalledWith("/admin");
    expect(refreshMock).toHaveBeenCalled();
    expect(screen.queryByTestId("login-auth-error")).not.toBeInTheDocument();
  });

  it("validates empty fields locally before calling Supabase", async () => {
    render(<LoginForm />);
    // Submit with untouched (empty) fields — no userEvent.type call
    // because userEvent rejects empty strings.
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "登录" }));
    expect(screen.getByTestId("login-auth-error")).toHaveTextContent(
      "请填写邮箱和密码",
    );
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("blocks sign-in when the server guard returns 429 (fixed message, no Supabase call)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ ok: false, error: "尝试次数过多，请稍后再试" }),
          { status: 429 },
        ),
      ),
    );
    signInMock.mockResolvedValue({
      data: { user: {}, session: {} },
      error: null,
    });
    render(<LoginForm />);
    await submitCredentials();
    const alert = screen.getByTestId("login-auth-error");
    expect(alert).toHaveTextContent("尝试次数过多，请稍后再试");
    expect(signInMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("continues sign-in when the guard is unreachable (fail-open)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    signInMock.mockResolvedValue({
      data: { user: {}, session: {} },
      error: null,
    });
    render(<LoginForm />);
    await submitCredentials();
    // Fail-open: the guard outage must NOT block the login flow.
    expect(signInMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith("/admin");
  });
});

describe("LoginForm — MFA challenge routing (KZQ-P1-022-c)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    pushMock.mockClear();
    refreshMock.mockClear();
    signInMock.mockReset();
    getAalMock.mockReset();
    stubAal1();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ),
    );
  });

  it("routes to the MFA challenge page when the account has a verified factor (nextLevel aal2)", async () => {
    signInMock.mockResolvedValue({ data: { user: {}, session: {} }, error: null });
    getAalMock.mockResolvedValue({
      data: {
        currentLevel: "aal1",
        nextLevel: "aal2",
        currentAuthenticationMethods: ["password"],
      },
      error: null,
    });
    render(<LoginForm />);
    await submitCredentials();
    expect(pushMock).toHaveBeenCalledWith("/admin/mfa/challenge");
    expect(refreshMock).toHaveBeenCalled();
  });

  it("routes to the MFA challenge page when the AAL probe throws (fail-closed)", async () => {
    signInMock.mockResolvedValue({ data: { user: {}, session: {} }, error: null });
    getAalMock.mockRejectedValue(new Error("network down"));
    render(<LoginForm />);
    await submitCredentials();
    // Fail-closed: an unexpected AAL probe failure must NOT let an
    // MFA-protected account silently into the dashboard — route to the
    // challenge page, which re-evaluates the AAL itself.
    expect(pushMock).toHaveBeenCalledWith("/admin/mfa/challenge");
  });

  it("routes to the MFA challenge page when the AAL probe returns an error (fail-closed)", async () => {
    signInMock.mockResolvedValue({ data: { user: {}, session: {} }, error: null });
    getAalMock.mockResolvedValue({
      data: null,
      error: { message: "Session expired", code: "session_expired", status: 401 },
    });
    render(<LoginForm />);
    await submitCredentials();
    expect(pushMock).toHaveBeenCalledWith("/admin/mfa/challenge");
  });

  it("still routes straight to /admin when the account has no verified factor (nextLevel aal1)", async () => {
    signInMock.mockResolvedValue({ data: { user: {}, session: {} }, error: null });
    // Default stubAal1() returns nextLevel aal1.
    render(<LoginForm />);
    await submitCredentials();
    expect(pushMock).toHaveBeenCalledWith("/admin");
  });
});
