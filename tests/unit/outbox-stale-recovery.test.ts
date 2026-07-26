import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// Phase 15: Per-provider Outbox runtime — state machine contract
// ------------------------------------------------------------
// Proves the new per-provider outbox processor enforces:
//   1. find_uninitialized_outbox_events + initialize_inquiry_outbox_deliveries
//      is called before claim (pre-claim init step).
//   2. claim_inquiry_outbox_deliveries generates a per-delivery lock_token.
//   3. mark_delivery_sent requires matching lock_token (stale Worker rejected).
//   4. fail_delivery_event requires matching lock_token.
//   5. NOTIFICATION_NOT_CONFIGURED fails the delivery (never marks sent).
//   6. Stale processing deliveries are re-claimed after timeout.
//   7. deadLettered count comes from the RPC return value (not error guessing).
//   8. At-least-once delivery: mark-sent failure leaves delivery in 'claimed',
//      recoverable by stale recovery.
//   9. Adapter matching is per-provider (email delivery only invokes email adapter).
//  10. Force dead_letter for permanent adapter errors (NotificationError permanent).
//  11. claim RPC error returns zero claimed (no crash).
//  12. Empty claim returns zero results immediately.
//  13. Adapter not configured → force dead_letter with NOTIFICATION_NOT_CONFIGURED_<provider>.
//
// These tests mock the Supabase client RPC layer and verify the
// processor's behavior contract matches the migration's RPCs.
// ============================================================

const createAdminSupabaseClient = vi.fn();
const createNotificationAdapters = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({ createAdminSupabaseClient }));
vi.mock("@/lib/services/inquiries/notifications", () => ({
  createNotificationAdapters,
  NotificationError: class NotificationError extends Error {
    readonly kind: "retryable" | "permanent";
    readonly code: string;
    constructor(kind: "retryable" | "permanent", code: string, message?: string) {
      super(message || code);
      this.name = "NotificationError";
      this.kind = kind;
      this.code = code;
    }
  },
}));

interface MockRpcResult {
  data: unknown;
  error: unknown;
}

function makeMockClient(
  rpcResults: Record<string, MockRpcResult | (() => MockRpcResult)>,
) {
  const rpc = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
    const result = rpcResults[name];
    if (typeof result === "function") return result();
    return result ?? { data: null, error: null };
  });
  // Per-delivery row lookup: outbox_event_id -> inquiry_id.
  // Used by the processor to resolve inquiry_id from delivery.outbox_event_id.
  const eventInquiryMap: Record<string, string> = {
    "evt-1": "inq-1",
    "evt-2": "inq-2",
    "evt-stale": "inq-1",
  };
  const single = vi.fn(async (opts?: { args?: unknown[] }) => {
    // The processor calls .eq("id", delivery.outbox_event_id).single().
    // Extract the event id from the call args (first element of args array).
    const args = (opts as { args?: unknown[] } | undefined)?.args ?? [];
    const eventId = (args[0] as string) ?? "evt-1";
    return {
      data: { inquiry_id: eventInquiryMap[eventId] ?? "inq-1" },
      error: null,
    };
  });
  const eq = vi.fn((...args: unknown[]) => ({ single: () => single({ args }) }));
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

describe("Phase 15: Per-provider Outbox runtime — state machine contract", () => {
  beforeEach(() => {
    createAdminSupabaseClient.mockReset();
    createNotificationAdapters.mockReset();
    vi.resetModules();
  });

  it("pre-claim init step calls find_uninitialized + initialize_inquiry_outbox_deliveries", async () => {
    const client = makeMockClient({
      find_uninitialized_outbox_events: {
        data: ["evt-1"],
        error: null,
      },
      initialize_inquiry_outbox_deliveries: { data: 1, error: null },
      claim_inquiry_outbox_deliveries: { data: [], error: null },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    createNotificationAdapters.mockReturnValue([
      { name: "email", configured: true, send: vi.fn().mockResolvedValue({}) },
    ]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );
    const result = await processInquiryOutbox(10);

    expect(result.initialized).toBe(1);
    const initCalls = rpcCallsFor(
      client.rpc,
      "initialize_inquiry_outbox_deliveries",
    );
    expect(initCalls).toHaveLength(1);
    expect(initCalls[0]).toEqual(
      expect.objectContaining({
        p_outbox_event_id: "evt-1",
        p_providers: ["email"],
      }),
    );
  });

  it("claim generates a per-delivery lock_token", async () => {
    const client = makeMockClient({
      find_uninitialized_outbox_events: { data: [], error: null },
      claim_inquiry_outbox_deliveries: {
        data: [
          {
            id: "del-1",
            outbox_event_id: "evt-1",
            provider: "email",
            lock_token: "token-a",
            attempts: 0,
            max_attempts: 5,
          },
          {
            id: "del-2",
            outbox_event_id: "evt-2",
            provider: "email",
            lock_token: "token-b",
            attempts: 0,
            max_attempts: 5,
          },
        ],
        error: null,
      },
      mark_delivery_sent: { data: true, error: null },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    createNotificationAdapters.mockReturnValue([
      { name: "email", configured: true, send: vi.fn().mockResolvedValue({}) },
    ]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );
    const result = await processInquiryOutbox(10);

    expect(result.claimed).toBe(2);
    expect(result.sent).toBe(2);
    // mark_delivery_sent called with matching lock_token per delivery.
    const sentCalls = rpcCallsFor(client.rpc, "mark_delivery_sent");
    expect(sentCalls).toHaveLength(2);
    expect(sentCalls[0]).toEqual(
      expect.objectContaining({
        p_delivery_id: "del-1",
        p_lock_token: "token-a",
      }),
    );
    expect(sentCalls[1]).toEqual(
      expect.objectContaining({
        p_delivery_id: "del-2",
        p_lock_token: "token-b",
      }),
    );
  });

  it("mark_delivery_sent with wrong lock_token returns false (stale Worker rejected)", async () => {
    const client = makeMockClient({
      find_uninitialized_outbox_events: { data: [], error: null },
      claim_inquiry_outbox_deliveries: {
        data: [
          {
            id: "del-1",
            outbox_event_id: "evt-1",
            provider: "email",
            lock_token: "token-a",
            attempts: 0,
            max_attempts: 5,
          },
        ],
        error: null,
      },
      // mark-sent returns false: lock_token no longer matches (delivery was
      // re-claimed by a newer Worker with a different token).
      mark_delivery_sent: { data: false, error: null },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    createNotificationAdapters.mockReturnValue([
      { name: "email", configured: true, send: vi.fn().mockResolvedValue({}) },
    ]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );
    const result = await processInquiryOutbox(10);

    // Send succeeded but mark-sent returned false — counted as soft failure.
    // Delivery stays 'claimed', recoverable by stale recovery.
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("fail_delivery_event requires matching lock_token (NOT_FOUND_OR_TOKEN_MISMATCH)", async () => {
    const client = makeMockClient({
      find_uninitialized_outbox_events: { data: [], error: null },
      claim_inquiry_outbox_deliveries: {
        data: [
          {
            id: "del-1",
            outbox_event_id: "evt-1",
            provider: "email",
            lock_token: "token-a",
            attempts: 0,
            max_attempts: 5,
          },
        ],
        error: null,
      },
      // fail returns NOT_FOUND_OR_TOKEN_MISMATCH — delivery was already
      // re-claimed by a newer Worker.
      fail_delivery_event: {
        data: "NOT_FOUND_OR_TOKEN_MISMATCH",
        error: null,
      },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    // No adapter configured → NOTIFICATION_NOT_CONFIGURED → failDelivery.
    createNotificationAdapters.mockReturnValue([]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );
    const result = await processInquiryOutbox(10);

    // failDelivery was called but returned NOT_FOUND_OR_TOKEN_MISMATCH.
    // deadLettered must NOT be incremented (the RPC said not found, not dead_letter).
    expect(result.deadLettered).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("NOTIFICATION_NOT_CONFIGURED fails the delivery (never marks sent)", async () => {
    const client = makeMockClient({
      find_uninitialized_outbox_events: { data: [], error: null },
      claim_inquiry_outbox_deliveries: {
        data: [
          {
            id: "del-1",
            outbox_event_id: "evt-1",
            provider: "email",
            lock_token: "token-a",
            attempts: 0,
            max_attempts: 5,
          },
        ],
        error: null,
      },
      fail_delivery_event: { data: "retry", error: null },
      // mark_delivery_sent must NOT be called.
      mark_delivery_sent: { data: true, error: null },
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
    // fail_delivery_event was called with NOTIFICATION_NOT_CONFIGURED_email.
    const failCalls = rpcCallsFor(client.rpc, "fail_delivery_event");
    expect(failCalls).toHaveLength(1);
    expect(failCalls[0]).toEqual(
      expect.objectContaining({
        p_error_code: "NOTIFICATION_NOT_CONFIGURED_email",
        p_force_dead_letter: true,
      }),
    );
    // mark-sent was never called.
    const sentCalls = rpcCallsFor(client.rpc, "mark_delivery_sent");
    expect(sentCalls).toHaveLength(0);
  });

  it("deadLettered count comes from the RPC return value (not error guessing)", async () => {
    const client = makeMockClient({
      find_uninitialized_outbox_events: { data: [], error: null },
      claim_inquiry_outbox_deliveries: {
        data: [
          {
            id: "del-1",
            outbox_event_id: "evt-1",
            provider: "email",
            lock_token: "token-a",
            attempts: 0,
            max_attempts: 5,
          },
        ],
        error: null,
      },
      // RPC explicitly returns 'dead_letter' — processor must use this value.
      fail_delivery_event: { data: "dead_letter", error: null },
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

  it("stale processing deliveries are re-claimed after timeout", async () => {
    // Stale recovery is INSIDE claim_inquiry_outbox_deliveries
    // (FOR UPDATE SKIP LOCKED + processing_started_at < now() - timeout).
    // Verify the processor passes the stale_timeout_seconds parameter.
    const client = makeMockClient({
      find_uninitialized_outbox_events: { data: [], error: null },
      claim_inquiry_outbox_deliveries: {
        data: [
          {
            id: "del-stale",
            outbox_event_id: "evt-stale",
            provider: "email",
            lock_token: "token-new",
            attempts: 1,
            max_attempts: 5,
          },
        ],
        error: null,
      },
      mark_delivery_sent: { data: true, error: null },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    createNotificationAdapters.mockReturnValue([
      { name: "email", configured: true, send: vi.fn().mockResolvedValue({}) },
    ]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );
    await processInquiryOutbox(10, { staleTimeoutSeconds: 60 });

    const claimCalls = rpcCallsFor(
      client.rpc,
      "claim_inquiry_outbox_deliveries",
    );
    expect(claimCalls).toHaveLength(1);
    expect(claimCalls[0]).toEqual({
      p_limit: 10,
      p_stale_timeout_seconds: 60,
    });
  });

  it("at-least-once: mark-sent failure leaves delivery recoverable", async () => {
    // Scenario: notification send succeeded, but mark_delivery_sent
    // returned an error. Delivery stays in 'claimed' — stale recovery
    // will re-claim and re-send (at-least-once).
    const client = makeMockClient({
      find_uninitialized_outbox_events: { data: [], error: null },
      claim_inquiry_outbox_deliveries: {
        data: [
          {
            id: "del-1",
            outbox_event_id: "evt-1",
            provider: "email",
            lock_token: "token-a",
            attempts: 0,
            max_attempts: 5,
          },
        ],
        error: null,
      },
      mark_delivery_sent: {
        data: null,
        error: { message: "connection reset" },
      },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    const sendFn = vi.fn().mockResolvedValue({});
    createNotificationAdapters.mockReturnValue([
      { name: "email", configured: true, send: sendFn },
    ]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );
    const result = await processInquiryOutbox(10);

    // Notification was sent, but mark-sent failed.
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("adapter matching is per-provider (email delivery invokes email adapter only)", async () => {
    const emailSend = vi.fn().mockResolvedValue({ providerMessageId: "re_1" });
    const wecomSend = vi.fn().mockResolvedValue({});
    const client = makeMockClient({
      find_uninitialized_outbox_events: { data: [], error: null },
      claim_inquiry_outbox_deliveries: {
        data: [
          {
            id: "del-1",
            outbox_event_id: "evt-1",
            provider: "email",
            lock_token: "token-a",
            attempts: 0,
            max_attempts: 5,
          },
        ],
        error: null,
      },
      mark_delivery_sent: { data: true, error: null },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    createNotificationAdapters.mockReturnValue([
      { name: "wecom", configured: true, send: wecomSend },
      { name: "email", configured: true, send: emailSend },
    ]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );
    await processInquiryOutbox(10);

    // Only the email adapter should be called for an email delivery.
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(wecomSend).not.toHaveBeenCalled();
  });

  it("force dead_letter for permanent adapter errors (NotificationError permanent)", async () => {
    const { NotificationError } = await import(
      "@/lib/services/inquiries/notifications"
    );
    const permanentError = new NotificationError(
      "permanent",
      "RESEND_409_INVALID",
    );
    const client = makeMockClient({
      find_uninitialized_outbox_events: { data: [], error: null },
      claim_inquiry_outbox_deliveries: {
        data: [
          {
            id: "del-1",
            outbox_event_id: "evt-1",
            provider: "email",
            lock_token: "token-a",
            attempts: 0,
            max_attempts: 5,
          },
        ],
        error: null,
      },
      fail_delivery_event: { data: "dead_letter", error: null },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    createNotificationAdapters.mockReturnValue([
      {
        name: "email",
        configured: true,
        send: vi.fn().mockRejectedValue(permanentError),
      },
    ]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );
    const result = await processInquiryOutbox(10);

    expect(result.failed).toBe(1);
    expect(result.deadLettered).toBe(1);
    // fail_delivery_event must be called with p_force_dead_letter=true.
    const failCalls = rpcCallsFor(client.rpc, "fail_delivery_event");
    expect(failCalls).toHaveLength(1);
    expect(failCalls[0]).toEqual(
      expect.objectContaining({
        p_error_code: "RESEND_409_INVALID",
        p_force_dead_letter: true,
      }),
    );
  });

  it("retryable adapter errors do NOT force dead_letter", async () => {
    const { NotificationError } = await import(
      "@/lib/services/inquiries/notifications"
    );
    const retryableError = new NotificationError(
      "retryable",
      "RESEND_429",
    );
    const client = makeMockClient({
      find_uninitialized_outbox_events: { data: [], error: null },
      claim_inquiry_outbox_deliveries: {
        data: [
          {
            id: "del-1",
            outbox_event_id: "evt-1",
            provider: "email",
            lock_token: "token-a",
            attempts: 0,
            max_attempts: 5,
          },
        ],
        error: null,
      },
      fail_delivery_event: { data: "retry", error: null },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    createNotificationAdapters.mockReturnValue([
      {
        name: "email",
        configured: true,
        send: vi.fn().mockRejectedValue(retryableError),
      },
    ]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );
    const result = await processInquiryOutbox(10);

    expect(result.failed).toBe(1);
    expect(result.deadLettered).toBe(0);
    // fail_delivery_event must be called with p_force_dead_letter=false.
    const failCalls = rpcCallsFor(client.rpc, "fail_delivery_event");
    expect(failCalls).toHaveLength(1);
    expect(failCalls[0]).toEqual(
      expect.objectContaining({
        p_error_code: "RESEND_429",
        p_force_dead_letter: false,
      }),
    );
  });

  it("claim RPC error returns zero claimed (no crash)", async () => {
    const client = makeMockClient({
      find_uninitialized_outbox_events: { data: [], error: null },
      claim_inquiry_outbox_deliveries: {
        data: null,
        error: { message: "db down" },
      },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    createNotificationAdapters.mockReturnValue([
      { name: "email", configured: true, send: vi.fn() },
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
      find_uninitialized_outbox_events: { data: [], error: null },
      claim_inquiry_outbox_deliveries: { data: [], error: null },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    createNotificationAdapters.mockReturnValue([
      { name: "email", configured: true, send: vi.fn() },
    ]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );
    const result = await processInquiryOutbox(10);

    expect(result.claimed).toBe(0);
    expect(result.sent).toBe(0);
  });

  it("adapter not configured after init → force dead_letter with NOTIFICATION_NOT_CONFIGURED_<provider>", async () => {
    // Scenario: delivery was initialized when adapter was configured,
    // but env var was removed before claim. Processor must force dead_letter.
    const client = makeMockClient({
      find_uninitialized_outbox_events: { data: [], error: null },
      claim_inquiry_outbox_deliveries: {
        data: [
          {
            id: "del-1",
            outbox_event_id: "evt-1",
            provider: "email",
            lock_token: "token-a",
            attempts: 0,
            max_attempts: 5,
          },
        ],
        error: null,
      },
      fail_delivery_event: { data: "dead_letter", error: null },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    // Adapter exists but is NOT configured (env var missing).
    createNotificationAdapters.mockReturnValue([
      { name: "email", configured: false, send: vi.fn() },
    ]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );
    const result = await processInquiryOutbox(10);

    expect(result.failed).toBe(1);
    expect(result.deadLettered).toBe(1);
    const failCalls = rpcCallsFor(client.rpc, "fail_delivery_event");
    expect(failCalls).toHaveLength(1);
    expect(failCalls[0]).toEqual(
      expect.objectContaining({
        p_error_code: "NOTIFICATION_NOT_CONFIGURED_email",
        p_force_dead_letter: true,
      }),
    );
  });

  it("attempt number passed to adapter is delivery.attempts + 1 (not hardcoded 1)", async () => {
    const client = makeMockClient({
      find_uninitialized_outbox_events: { data: [], error: null },
      claim_inquiry_outbox_deliveries: {
        data: [
          {
            id: "del-1",
            outbox_event_id: "evt-1",
            provider: "email",
            lock_token: "token-a",
            attempts: 3, // third retry
            max_attempts: 5,
          },
        ],
        error: null,
      },
      mark_delivery_sent: { data: true, error: null },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    const sendFn = vi.fn().mockResolvedValue({});
    createNotificationAdapters.mockReturnValue([
      { name: "email", configured: true, send: sendFn },
    ]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );
    await processInquiryOutbox(10);

    expect(sendFn).toHaveBeenCalledTimes(1);
    const contextArg = sendFn.mock.calls[0]?.[1];
    expect(contextArg).toEqual(
      expect.objectContaining({
        attempt: 4, // attempts(3) + 1
        eventId: "evt-1",
        provider: "email",
      }),
    );
  });
});
