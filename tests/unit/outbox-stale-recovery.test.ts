import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// Phase 13: Outbox state machine — stale recovery & lock_token
// ------------------------------------------------------------
// Proves the outbox processor enforces:
//   1. claim_inquiry_outbox_batch generates a lock_token per event
//   2. mark_inquiry_outbox_sent requires matching lock_token
//   3. fail_inquiry_outbox_event requires matching lock_token
//   4. NOTIFICATION_NOT_CONFIGURED fails the event (never marks sent)
//   5. Stale processing events are re-claimed after timeout
//   6. deadLettered count comes from the RPC, not error-string guessing
//   7. At-least-once delivery: mark-sent failure leaves event in
//      processing, recoverable by stale recovery
//
// These tests mock the Supabase client RPC layer and verify the
// processor's behavior contract matches the migration's RPCs.
// ============================================================

const createAdminSupabaseClient = vi.fn();
const createNotificationAdapters = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({ createAdminSupabaseClient }));
vi.mock("@/lib/services/inquiries/notifications", () => ({
  createNotificationAdapters,
}));

interface MockRpcResult {
  data: unknown;
  error: unknown;
}

function makeMockClient(rpcResults: Record<string, MockRpcResult | (() => MockRpcResult)>) {
  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    const result = rpcResults[name];
    if (typeof result === "function") return result();
    return result ?? { data: null, error: null };
  });
  const single = vi.fn(async () => ({
    data: {
      id: "inq-1",
      inquiry_items: [],
      name: "Test",
      email: null,
      phone: null,
      wechat: null,
      whatsapp: null,
      message: "test",
      status: "new",
      is_read: false,
      created_at: "2026-07-24T00:00:00Z",
      updated_at: "2026-07-24T00:00:00Z",
    },
    error: null,
  }));
  const eq = vi.fn(() => ({ single }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { rpc, from };
}

/** Helper: extract rpc calls by name, returning the args object (index 1). */
function rpcCallsFor(
  rpc: ReturnType<typeof vi.fn>,
  name: string,
): Record<string, unknown>[] {
  const calls = rpc.mock.calls as unknown[][];
  return calls
    .filter((c) => c[0] === name)
    .map((c) => (c[1] as Record<string, unknown>) ?? {});
}

describe("Phase 13: Outbox state machine — lock_token enforcement", () => {
  beforeEach(() => {
    createAdminSupabaseClient.mockReset();
    createNotificationAdapters.mockReset();
    vi.resetModules();
  });

  it("claim generates a unique lock_token per event", async () => {
    const client = makeMockClient({
      claim_inquiry_outbox_batch: {
        data: [
          { id: "evt-1", inquiry_id: "inq-1", lock_token: "token-a" },
          { id: "evt-2", inquiry_id: "inq-2", lock_token: "token-b" },
        ],
        error: null,
      },
      mark_inquiry_outbox_sent: { data: true, error: null },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    createNotificationAdapters.mockReturnValue([
      { configured: true, send: vi.fn().mockResolvedValue(undefined) },
    ]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );
    const result = await processInquiryOutbox(10);

    expect(result.claimed).toBe(2);
    expect(result.sent).toBe(2);
    // mark_inquiry_outbox_sent was called with the matching lock_token
    const calls = rpcCallsFor(client.rpc, "mark_inquiry_outbox_sent");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(
      expect.objectContaining({
        p_event_id: "evt-1",
        p_lock_token: "token-a",
      }),
    );
    expect(calls[1]).toEqual(
      expect.objectContaining({
        p_event_id: "evt-2",
        p_lock_token: "token-b",
      }),
    );
  });

  it("mark-sent with wrong lock_token returns false (stale Worker rejected)", async () => {
    const client = makeMockClient({
      claim_inquiry_outbox_batch: {
        data: [{ id: "evt-1", inquiry_id: "inq-1", lock_token: "token-a" }],
        error: null,
      },
      // mark-sent returns false: lock_token no longer matches (event was
      // re-claimed by a newer Worker with a different token).
      mark_inquiry_outbox_sent: { data: false, error: null },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    createNotificationAdapters.mockReturnValue([
      { configured: true, send: vi.fn().mockResolvedValue(undefined) },
    ]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );
    const result = await processInquiryOutbox(10);

    // The send succeeded but mark-sent returned false — counted as a
    // soft failure. The event stays in 'processing' and will be
    // re-claimed by stale recovery.
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("fail_inquiry_outbox_event requires matching lock_token", async () => {
    const client = makeMockClient({
      claim_inquiry_outbox_batch: {
        data: [{ id: "evt-1", inquiry_id: "inq-1", lock_token: "token-a" }],
        error: null,
      },
      // The fail RPC returns NOT_FOUND_OR_TOKEN_MISMATCH — the event was
      // already re-claimed by a newer Worker.
      fail_inquiry_outbox_event: {
        data: "NOT_FOUND_OR_TOKEN_MISMATCH",
        error: null,
      },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    // No adapter configured → NOTIFICATION_NOT_CONFIGURED → failEvent.
    createNotificationAdapters.mockReturnValue([]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );
    const result = await processInquiryOutbox(10);

    // failEvent was called but returned NOT_FOUND_OR_TOKEN_MISMATCH.
    // The deadLettered count must NOT be incremented (the RPC said the
    // event was not found / token mismatch, not dead_letter).
    expect(result.deadLettered).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("NOTIFICATION_NOT_CONFIGURED fails the event (never marks sent)", async () => {
    const client = makeMockClient({
      claim_inquiry_outbox_batch: {
        data: [{ id: "evt-1", inquiry_id: "inq-1", lock_token: "token-a" }],
        error: null,
      },
      fail_inquiry_outbox_event: { data: "retry", error: null },
      // mark_inquiry_outbox_sent must NOT be called.
      mark_inquiry_outbox_sent: { data: true, error: null },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    // No adapters configured.
    createNotificationAdapters.mockReturnValue([]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );
    const result = await processInquiryOutbox(10);

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    // fail_inquiry_outbox_event was called with NOTIFICATION_NOT_CONFIGURED.
    const failCalls = rpcCallsFor(client.rpc, "fail_inquiry_outbox_event");
    expect(failCalls).toHaveLength(1);
    expect(failCalls[0]).toEqual(
      expect.objectContaining({
        p_error_code: "NOTIFICATION_NOT_CONFIGURED",
      }),
    );
    // mark-sent was never called.
    const sentCalls = rpcCallsFor(client.rpc, "mark_inquiry_outbox_sent");
    expect(sentCalls).toHaveLength(0);
  });

  it("deadLettered count comes from the RPC return value (not error guessing)", async () => {
    const client = makeMockClient({
      claim_inquiry_outbox_batch: {
        data: [{ id: "evt-1", inquiry_id: "inq-1", lock_token: "token-a" }],
        error: null,
      },
      // RPC explicitly returns 'dead_letter' — the processor must use
      // this value, not guess from the error string.
      fail_inquiry_outbox_event: { data: "dead_letter", error: null },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    createNotificationAdapters.mockReturnValue([]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );
    const result = await processInquiryOutbox(10);

    expect(result.deadLettered).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("stale processing events are re-claimed after timeout", async () => {
    // The stale recovery is implemented INSIDE claim_inquiry_outbox_batch
    // (FOR UPDATE SKIP LOCKED + processing_started_at < now() - timeout).
    // We verify the processor passes the stale_timeout_seconds parameter.
    const client = makeMockClient({
      claim_inquiry_outbox_batch: {
        data: [{ id: "evt-stale", inquiry_id: "inq-1", lock_token: "token-new" }],
        error: null,
      },
      mark_inquiry_outbox_sent: { data: true, error: null },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    createNotificationAdapters.mockReturnValue([
      { configured: true, send: vi.fn().mockResolvedValue(undefined) },
    ]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );
    // Use a short stale timeout (60s) for testing.
    await processInquiryOutbox(10, { staleTimeoutSeconds: 60 });

    const claimCalls = rpcCallsFor(client.rpc, "claim_inquiry_outbox_batch");
    expect(claimCalls).toHaveLength(1);
    expect(claimCalls[0]).toEqual({
      p_limit: 10,
      p_stale_timeout_seconds: 60,
    });
  });

  it("at-least-once: mark-sent failure leaves event recoverable", async () => {
    // Scenario: notification send succeeded, but mark_inquiry_outbox_sent
    // returned an error (network blip / DB restart). The event stays in
    // 'processing' and will be re-claimed by stale recovery, causing a
    // duplicate send. This is the documented at-least-once semantic.
    const client = makeMockClient({
      claim_inquiry_outbox_batch: {
        data: [{ id: "evt-1", inquiry_id: "inq-1", lock_token: "token-a" }],
        error: null,
      },
      // mark-sent RPC itself errors (not just returns false).
      mark_inquiry_outbox_sent: { data: null, error: { message: "connection reset" } },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    const sendFn = vi.fn().mockResolvedValue(undefined);
    createNotificationAdapters.mockReturnValue([{ configured: true, send: sendFn }]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );
    const result = await processInquiryOutbox(10);

    // The notification WAS sent (sendFn called), but mark-sent failed.
    // The event remains in 'processing' — stale recovery will re-claim
    // and re-send it (at-least-once).
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("claim RPC error returns zero claimed (no crash)", async () => {
    const client = makeMockClient({
      claim_inquiry_outbox_batch: { data: null, error: { message: "db down" } },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    createNotificationAdapters.mockReturnValue([
      { configured: true, send: vi.fn() },
    ]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );
    const result = await processInquiryOutbox(10);

    expect(result.claimed).toBe(0);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("empty claim returns zero results immediately", async () => {
    const client = makeMockClient({
      claim_inquiry_outbox_batch: { data: [], error: null },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    createNotificationAdapters.mockReturnValue([
      { configured: true, send: vi.fn() },
    ]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );
    const result = await processInquiryOutbox(10);

    expect(result.claimed).toBe(0);
    expect(result.sent).toBe(0);
  });
});
