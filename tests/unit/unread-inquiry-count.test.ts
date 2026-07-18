import { describe, expect, it, vi } from "vitest";

// Mock the admin supabase factory so we never touch a real client.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabaseClient: vi.fn(),
}));

import { countUnreadInquiries, UnreadInquiryCountError } from "@/lib/repositories/inquiries";
import type { Database } from "@/types/database";
import type { SupabaseClient } from "@supabase/supabase-js";

type InquiryClient = SupabaseClient<Database>;

function makeClient(opts: {
  count?: number | null;
  error?: unknown;
  throw?: unknown;
}): InquiryClient {
  // Chain: client.from("inquiries").select(...).eq(...).limit(...)
  // limit() resolves to { count, error }.
  const limit = vi.fn(async () => {
    if (opts.throw) throw opts.throw;
    return { count: opts.count ?? null, error: opts.error ?? null };
  });
  const eq = vi.fn(() => ({ limit }));
  const select = vi.fn(() => ({ eq }));
  return {
    from: vi.fn(() => ({ select })),
  } as unknown as InquiryClient;
}

describe("countUnreadInquiries", () => {
  it("returns count when query succeeds with non-null count", async () => {
    const client = makeClient({ count: 1 });
    const result = await countUnreadInquiries(client);
    expect(result).toBe(1);
  });

  it("returns 0 when query succeeds with count=0 (no unread)", async () => {
    const client = makeClient({ count: 0 });
    const result = await countUnreadInquiries(client);
    expect(result).toBe(0);
  });

  it("throws UnreadInquiryCountError with cause=count-unavailable when count is null", async () => {
    const client = makeClient({ count: null });
    await expect(countUnreadInquiries(client)).rejects.toMatchObject({
      name: "UnreadInquiryCountError",
      causeCode: "count-unavailable",
      message: "Unread inquiry count failed",
    });
  });

  it("throws UnreadInquiryCountError with cause=schema when error.code=42703", async () => {
    const client = makeClient({ error: { code: "42703" } });
    await expect(countUnreadInquiries(client)).rejects.toMatchObject({
      name: "UnreadInquiryCountError",
      causeCode: "schema",
    });
  });

  it("throws UnreadInquiryCountError with cause=permission when error.code=42501", async () => {
    const client = makeClient({ error: { code: "42501" } });
    await expect(countUnreadInquiries(client)).rejects.toMatchObject({
      name: "UnreadInquiryCountError",
      causeCode: "permission",
    });
  });

  it("throws UnreadInquiryCountError with cause=connection when error.code=08006", async () => {
    const client = makeClient({ error: { code: "08006" } });
    await expect(countUnreadInquiries(client)).rejects.toMatchObject({
      name: "UnreadInquiryCountError",
      causeCode: "connection",
    });
  });

  it("throws UnreadInquiryCountError with cause=timeout when error.code=57014", async () => {
    const client = makeClient({ error: { code: "57014" } });
    await expect(countUnreadInquiries(client)).rejects.toMatchObject({
      name: "UnreadInquiryCountError",
      causeCode: "timeout",
    });
  });

  it("throws UnreadInquiryCountError with cause=unknown for unknown error code", async () => {
    const client = makeClient({ error: { code: "XYZ123" } });
    await expect(countUnreadInquiries(client)).rejects.toMatchObject({
      name: "UnreadInquiryCountError",
      causeCode: "unknown",
    });
  });

  it("throws UnreadInquiryCountError when client throws AbortError (timeout)", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const client = makeClient({ throw: abort });
    await expect(countUnreadInquiries(client)).rejects.toMatchObject({
      name: "UnreadInquiryCountError",
      causeCode: "timeout",
    });
  });

  it("throws UnreadInquiryCountError with cause=unknown when client throws generic Error", async () => {
    const client = makeClient({ throw: new Error("network down") });
    await expect(countUnreadInquiries(client)).rejects.toMatchObject({
      name: "UnreadInquiryCountError",
      causeCode: "unknown",
    });
  });

  it("does NOT return 0 on failure (no deny-by-default regression)", async () => {
    const client = makeClient({ error: { code: "42501" } });
    const result = countUnreadInquiries(client);
    await expect(result).rejects.toBeInstanceOf(UnreadInquiryCountError);
    // Explicitly assert it's not a resolved 0.
    await expect(result).rejects.not.toEqual(0 as any);
  });

  it("UnreadInquiryCountError.message is the fixed constant string", async () => {
    const client = makeClient({ count: null });
    try {
      await countUnreadInquiries(client);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnreadInquiryCountError);
      expect((err as UnreadInquiryCountError).message).toBe(
        "Unread inquiry count failed",
      );
    }
  });

  it("UnreadInquiryCountError does not expose the original Supabase error", async () => {
    const originalError = {
      code: "42501",
      message: "permission denied for table inquiries",
      details: "row-level security policy",
      hint: "Use service_role key",
      stack: "Error: ...",
    };
    const client = makeClient({ error: originalError });
    try {
      await countUnreadInquiries(client);
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as UnreadInquiryCountError;
      expect(e).toBeInstanceOf(UnreadInquiryCountError);
      // The thrown error must NOT carry the original error as a cause.
      expect((e as unknown as { cause?: unknown }).cause).toBeUndefined();
      // And the message must be the fixed string, not the original message.
      expect(e.message).toBe("Unread inquiry count failed");
      // causeCode is the only safe field exposed.
      expect(e.causeCode).toBe("permission");
    }
  });
});

describe("UnreadInquiryCountError", () => {
  it("is an instance of Error", () => {
    expect(new UnreadInquiryCountError("schema")).toBeInstanceOf(Error);
  });

  it("sets name to UnreadInquiryCountError", () => {
    expect(new UnreadInquiryCountError("unknown").name).toBe(
      "UnreadInquiryCountError",
    );
  });

  it("sets the fixed message", () => {
    expect(new UnreadInquiryCountError("timeout").message).toBe(
      "Unread inquiry count failed",
    );
  });

  it("carries the causeCode as the only safe field", () => {
    const e = new UnreadInquiryCountError("connection");
    expect(e.causeCode).toBe("connection");
  });
});

describe("redirect param safety (regression)", () => {
  // The ProtectedLayout builds a redirect URL using only fixed stage and
  // cause tokens. Here we verify the cause set is exactly the set of values
  // that can appear in the redirect URL — nothing dynamic.
  it("every causeCode is a fixed lowercase-hyphenated token", async () => {
    const causes = [
      "schema",
      "permission",
      "authentication",
      "connection",
      "timeout",
      "count-unavailable",
      "unknown",
    ] as const;
    for (const cause of causes) {
      const e = new UnreadInquiryCountError(cause);
      expect(e.causeCode).toBe(cause);
      expect(cause).toMatch(/^[a-z][a-z-]*$/);
      // The redirect URL would be:
      //   /admin/login?error=admin_guard&stage=data&cause=<cause>
      // Ensure the cause contains no characters that would break a URL or
      // inject additional params.
      expect(cause).not.toMatch(/[&=?#/\s]/);
    }
  });
});
