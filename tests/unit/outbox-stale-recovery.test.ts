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

  it("at-least-once: mark-sent lock_token mismatch returns false (soft failure, recoverable)", async () => {
    // Scenario: notification send succeeded, but mark_delivery_sent
    // returned data=false because the lock_token no longer matches
    // (delivery was re-claimed by a newer Worker). This is NOT an
    // infrastructure error — it's a legitimate concurrent-execution
    // signal. The processor treats it as a soft failure (delivery
    // stays 'claimed') and the dispatcher returns 200 with failed=1.
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
      // data=false (no error): lock_token mismatch — soft failure.
      mark_delivery_sent: { data: false, error: null },
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

    // Notification was sent, but mark-sent returned false.
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("Work Package E: mark-sent RPC infrastructure error throws OutboxRpcError (no silent failure)", async () => {
    // Scenario: notification send succeeded, but the mark_delivery_sent
    // RPC failed with a database error (e.g. connection reset). The OLD
    // behavior was to log a fixed code and return { sent: 0, failed: 1 },
    // which made "DB query failed" indistinguishable from "lock_token
    // mismatch" at the dispatcher level. The NEW behavior is to throw
    // OutboxRpcError("OUTBOX_MARK_DELIVERY_SENT_FAILED") so the
    // dispatcher route returns 5xx and the failure is visible to
    // monitoring.
    //
    // At-least-once semantics are PRESERVED: the delivery row stays
    // 'claimed' (the RPC never updated it), and stale recovery will
    // re-claim it after the timeout.
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

    const { processInquiryOutbox, OutboxRpcError } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );

    await expect(processInquiryOutbox(10)).rejects.toMatchObject({
      name: "OutboxRpcError",
      code: "OUTBOX_MARK_DELIVERY_SENT_FAILED",
    });
    expect(OutboxRpcError).toBeDefined();

    // The notification was sent (at-least-once), but the mark-sent RPC
    // failed — the delivery row stays 'claimed' and stale recovery
    // will re-claim it.
    expect(sendFn).toHaveBeenCalledTimes(1);
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

  it("Work Package E: claim RPC infrastructure error throws OutboxRpcError (no silent failure)", async () => {
    // Scenario: claim_inquiry_outbox_deliveries RPC failed with a
    // database error (e.g. db down). The OLD behavior was to log a
    // fixed code and return { claimed: 0, sent: 0, failed: 0 }, which
    // made "DB query failed" indistinguishable from "queue is empty"
    // at the dispatcher level — the dispatcher returned 200 and hid
    // the outage. The NEW behavior is to throw
    // OutboxRpcError("OUTBOX_CLAIM_DELIVERIES_FAILED") so the
    // dispatcher route returns 500 and the failure is visible to
    // monitoring.
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

    await expect(processInquiryOutbox(10)).rejects.toMatchObject({
      name: "OutboxRpcError",
      code: "OUTBOX_CLAIM_DELIVERIES_FAILED",
    });
  });

  it("Work Package E: find_uninitialized_outbox_events RPC error throws OutboxRpcError", async () => {
    // Scenario: find_uninitialized_outbox_events RPC failed. The OLD
    // behavior was to log a fixed code and return initialized=0,
    // hiding the outage. The NEW behavior throws
    // OutboxRpcError("OUTBOX_FIND_UNINITIALIZED_FAILED").
    const client = makeMockClient({
      find_uninitialized_outbox_events: {
        data: null,
        error: { message: "connection refused" },
      },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    createNotificationAdapters.mockReturnValue([
      { name: "email", configured: true, send: vi.fn() },
    ]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );

    await expect(processInquiryOutbox(10)).rejects.toMatchObject({
      name: "OutboxRpcError",
      code: "OUTBOX_FIND_UNINITIALIZED_FAILED",
    });
  });

  it("Work Package E: fail_delivery_event RPC error throws OutboxRpcError", async () => {
    // Scenario: fail_delivery_event RPC failed. The OLD behavior was
    // to log and return "retry", fabricating a state transition. The
    // NEW behavior throws OutboxRpcError("OUTBOX_FAIL_DELIVERY_FAILED").
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
      fail_delivery_event: {
        data: null,
        error: { message: "db down" },
      },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    // No adapter configured → failDelivery is invoked.
    createNotificationAdapters.mockReturnValue([]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );

    await expect(processInquiryOutbox(10)).rejects.toMatchObject({
      name: "OutboxRpcError",
      code: "OUTBOX_FAIL_DELIVERY_FAILED",
    });
  });

  it("Work Package E: orphaned parent event cancels delivery (not marks sent)", async () => {
    // Scenario: parent inquiry_outbox row was deleted (FK cascade)
    // after the delivery was claimed. The OLD behavior was to call
    // mark_delivery_sent, which conflated "delivered" with "gave up
    // because the target vanished" and inflated the sent counter.
    // The NEW behavior calls cancel_orphaned_delivery, which records
    // the granular 'cancelled' status with reason
    // 'ORPHANED_PARENT_EVENT' for operator review.
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
      cancel_orphaned_delivery: { data: "cancelled", error: null },
    });
    // Override the .from('inquiry_outbox').select().single() chain
    // to return null data (simulating a deleted parent event).
    const selectEqSingle = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
    });
    const selectEq = vi.fn(() => ({ single: selectEqSingle }));
    const selectFn = vi.fn(() => ({ eq: selectEq }));
    // Override the parent-event lookup to simulate a deleted parent.
    // Cast through `unknown` because the mock shape is intentionally
    // narrower than the full Supabase query builder type.
    (client as { from: unknown }).from = vi.fn(() => ({ select: selectFn }));
    createAdminSupabaseClient.mockReturnValue(client);
    createNotificationAdapters.mockReturnValue([
      { name: "email", configured: true, send: vi.fn() },
    ]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );
    const result = await processInquiryOutbox(10);

    // Delivery was cancelled — NOT counted as sent.
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    // cancel_orphaned_delivery was called with the right reason.
    const cancelCalls = rpcCallsFor(client.rpc, "cancel_orphaned_delivery");
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]).toEqual(
      expect.objectContaining({
        p_delivery_id: "del-1",
        p_lock_token: "token-a",
        p_reason: "ORPHANED_PARENT_EVENT",
      }),
    );
    // mark_delivery_sent must NOT be called for the orphaned case.
    const sentCalls = rpcCallsFor(client.rpc, "mark_delivery_sent");
    expect(sentCalls).toHaveLength(0);
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

  // ============================================================
  // Review #2 — Work Package E: distinguish missing records from
  // database failures. The previous code treated every Supabase
  // error as "record deleted" and silently cancelled the delivery.
  // The new code only treats PGRST116 (PostgREST's "0 rows
  // returned" signal) as "explicitly missing"; any other error code
  // is an infrastructure failure that MUST propagate as
  // OutboxRpcError so the dispatcher returns 5xx.
  // ============================================================

  it("Review #2: loadInquiry throws OUTBOX_INQUIRY_LOAD_FAILED on non-PGRST116 error", async () => {
    // Scenario: parent inquiry_outbox row exists (lookup succeeds),
    // but the subsequent inquiries lookup fails with a non-PGRST116
    // error (e.g. connection reset). The OLD behavior was to treat
    // every error as "inquiry deleted" and silently cancel the
    // delivery. The NEW behavior throws
    // OutboxRpcError("OUTBOX_INQUIRY_LOAD_FAILED") so the dispatcher
    // returns 500 and the outage is visible to monitoring.
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
    // Override `from` to be table-aware:
    //   - inquiry_outbox lookup → success (inquiry_id present)
    //   - inquiries lookup → non-PGRST116 error (infrastructure failure)
    const inquiryOutboxSingle = vi.fn().mockResolvedValue({
      data: { inquiry_id: "inq-1" },
      error: null,
    });
    const inquiryOutboxEq = vi.fn(() => ({ single: inquiryOutboxSingle }));
    const inquiryOutboxSelect = vi.fn(() => ({ eq: inquiryOutboxEq }));

    const inquiriesSingle = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "08000", message: "connection_failed" },
    });
    const inquiriesEq = vi.fn(() => ({ single: inquiriesSingle }));
    const inquiriesSelect = vi.fn(() => ({ eq: inquiriesEq }));

    (client as { from: unknown }).from = vi.fn((table: string) => {
      if (table === "inquiries") {
        return { select: inquiriesSelect };
      }
      return { select: inquiryOutboxSelect };
    });
    createAdminSupabaseClient.mockReturnValue(client);
    const sendFn = vi.fn().mockResolvedValue({});
    createNotificationAdapters.mockReturnValue([
      { name: "email", configured: true, send: sendFn },
    ]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );

    await expect(processInquiryOutbox(10)).rejects.toMatchObject({
      name: "OutboxRpcError",
      code: "OUTBOX_INQUIRY_LOAD_FAILED",
    });
    // Notification was NEVER sent — the DB outage surfaced before send.
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("Review #2: parent event lookup throws OUTBOX_EVENT_LOAD_FAILED on non-PGRST116 error", async () => {
    // Scenario: claim succeeded, but the parent inquiry_outbox lookup
    // fails with a non-PGRST116 error (e.g. permission denied). The
    // OLD behavior treated every error as "parent deleted" and
    // silently cancelled the delivery. The NEW behavior throws
    // OutboxRpcError("OUTBOX_EVENT_LOAD_FAILED") so the dispatcher
    // returns 500.
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
    });
    // Override the parent-event lookup to return a non-PGRST116 error.
    const selectEqSingle = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "42501", message: "permission denied" },
    });
    const selectEq = vi.fn(() => ({ single: selectEqSingle }));
    const selectFn = vi.fn(() => ({ eq: selectEq }));
    (client as { from: unknown }).from = vi.fn(() => ({ select: selectFn }));
    createAdminSupabaseClient.mockReturnValue(client);
    const sendFn = vi.fn().mockResolvedValue({});
    createNotificationAdapters.mockReturnValue([
      { name: "email", configured: true, send: sendFn },
    ]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );

    await expect(processInquiryOutbox(10)).rejects.toMatchObject({
      name: "OutboxRpcError",
      code: "OUTBOX_EVENT_LOAD_FAILED",
    });
    // Notification was NEVER sent — the DB outage surfaced before send.
    expect(sendFn).not.toHaveBeenCalled();
    // cancel_orphaned_delivery was NOT called (this is not an orphan).
    const cancelCalls = rpcCallsFor(client.rpc, "cancel_orphaned_delivery");
    expect(cancelCalls).toHaveLength(0);
  });

  it("Review #2: initializeUninitializedEvents throws OUTBOX_INITIALIZE_DELIVERIES_FAILED on per-event RPC error", async () => {
    // Scenario: find_uninitialized_outbox_events returns two event ids,
    // but initialize_inquiry_outbox_deliveries fails for the first one
    // with a database error. The OLD behavior was to log the error and
    // continue, returning initialized=1 — which made every init RPC
    // outage look like "some events initialized OK" and hid the
    // failure behind a partial success count. The NEW behavior throws
    // OutboxRpcError("OUTBOX_INITIALIZE_DELIVERIES_FAILED") on the
    // first per-event init failure so the dispatcher returns 500.
    const client = makeMockClient({
      find_uninitialized_outbox_events: {
        data: ["evt-1", "evt-2"],
        error: null,
      },
      // First init call fails with a non-PGRST116-style RPC error.
      initialize_inquiry_outbox_deliveries: (() => {
        let callCount = 0;
        return () => {
          callCount += 1;
          if (callCount === 1) {
            return {
              data: null,
              error: { code: "08000", message: "connection_failed" },
            };
          }
          return { data: 1, error: null };
        };
      })(),
      claim_inquiry_outbox_deliveries: { data: [], error: null },
    });
    createAdminSupabaseClient.mockReturnValue(client);
    createNotificationAdapters.mockReturnValue([
      { name: "email", configured: true, send: vi.fn() },
    ]);

    const { processInquiryOutbox } = await import(
      "@/lib/services/inquiries/outbox-processor"
    );

    await expect(processInquiryOutbox(10)).rejects.toMatchObject({
      name: "OutboxRpcError",
      code: "OUTBOX_INITIALIZE_DELIVERIES_FAILED",
    });
    // The second event must NOT have been initialized after the first
    // failed — the batch aborts on the first per-event init error.
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
});
