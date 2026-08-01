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
vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      signInWithPassword: signInMock,
    },
  }),
}));

async function submitCredentials(email = "admin@kzq.com", password = "secret") {
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText("admin@kzq.com"), email);
  await user.type(screen.getByPlaceholderText("••••••••"), password);
  await user.click(screen.getByRole("button", { name: "登录" }));
}

describe("LoginForm — error standardization", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    pushMock.mockClear();
    refreshMock.mockClear();
    signInMock.mockReset();
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
});
