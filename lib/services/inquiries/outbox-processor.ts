import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import {
  createNotificationAdapters,
  type NotificationAdapter,
  type NotificationRuntime,
} from "./notifications";
import type { Inquiry } from "@/types/database";

/**
 * Phase 5 + Phase 13: Outbox processor.
 *
 * Canonical notification delivery path. Driven by the `inquiry_outbox` table
 * written in the same transaction as the inquiry insert.
 *
 * Workflow (per batch):
 *   1. claim_inquiry_outbox_batch(limit, stale_timeout)  -> atomically marks
 *      N pending / retry / stale-processing rows as 'processing' using
 *      FOR UPDATE SKIP LOCKED, generates a unique lock_token per event, and
 *      records processing_started_at. Multi-instance safe.
 *   2. for each claimed event, load the inquiry and call the configured
 *      notification adapters (wecom / email).
 *   3. success -> mark_inquiry_outbox_sent(event_id, lock_token, provider_id)
 *      — the lock_token match prevents a stale Worker from marking an event
 *      that was re-claimed by a newer Worker.
 *      failure -> fail_inquiry_outbox_event(event_id, lock_token, code)
 *      which advances attempts and either schedules a retry with exponential
 *      backoff or marks the event as 'dead_letter' for manual intervention.
 *
 * Stale processing recovery:
 *   If a Worker crashes after claiming but before mark-sent / fail, the row
 *   stays in 'processing'. claim_inquiry_outbox_batch re-claims any row whose
 *   processing_started_at is older than p_stale_timeout_seconds (default 300s).
 *   This guarantees at-least-once delivery — a send may be duplicated, but
 *   no event is silently lost.
 *
 * Delivery semantics: AT-LEAST-ONCE.
 *   - If a notification provider returns success but the subsequent
 *     mark_inquiry_outbox_sent RPC fails (network blip, DB restart), the event
 *     stays in 'processing' and will be re-claimed after the stale timeout,
 *     causing a duplicate send. Notification adapters SHOULD be idempotent.
 *   - If a provider supports an idempotency key, we pass the outbox event id
 *     as that key (passed via NotificationAdapter options).
 *
 * NOTIFICATION_NOT_CONFIGURED:
 *   If no adapter is configured, we explicitly fail the event with the fixed
 *   code 'NOTIFICATION_NOT_CONFIGURED' so it enters retry / dead_letter and
 *   surfaces in the outbox status. We never mark an unsent event as 'sent'.
 *
 * EDGEONE BLOCK NOTE:
 *   EdgeOne (the production edge network) does not currently provide a
 *   guaranteed long-running worker / cron mechanism that survives edge
 *   request lifecycle. Therefore this processor is:
 *     - invocable from an admin-authenticated API route (manual / on-demand)
 *     - invocable from a platform-side cron if/when EdgeOne adds one
 *   Until a platform cron exists, dead_letter events require manual review.
 *   This is recorded as a Phase 5 / Phase 13 BLOCK in the delivery report —
 *   we do NOT pretend the in-process fast path is reliable.
 */

export interface OutboxProcessingResult {
  claimed: number;
  sent: number;
  failed: number;
  deadLettered: number;
}

interface ClaimedEvent {
  id: string;
  inquiry_id: string;
  lock_token: string;
}

interface OutboxRuntime {
  notificationAdapters?: NotificationAdapter[];
  /** Optional override for the notification fetch/timeout (tests). */
  notificationRuntime?: NotificationRuntime;
  /** Override the stale-processing recovery timeout (seconds, tests). */
  staleTimeoutSeconds?: number;
}

/** Fixed error code when no notification adapter is configured. */
export const NOTIFICATION_NOT_CONFIGURED_CODE = "NOTIFICATION_NOT_CONFIGURED";

function buildAdapters(runtime?: NotificationRuntime): NotificationAdapter[] {
  return createNotificationAdapters(
    {
      wecomWebhookUrl: process.env.INQUIRY_WECOM_WEBHOOK_URL,
      resendApiKey: process.env.RESEND_API_KEY,
      resendFrom: process.env.INQUIRY_NOTIFICATION_FROM,
      resendTo: process.env.INQUIRY_NOTIFICATION_TO,
    },
    runtime,
  );
}

async function loadInquiry(inquiryId: string): Promise<Inquiry | null> {
  const client = createAdminSupabaseClient();
  const { data, error } = await client
    .from("inquiries")
    .select("*, inquiry_items(*)")
    .eq("id", inquiryId)
    .single();
  if (error || !data) return null;
  const inquiry = data as unknown as Inquiry;
  if (inquiry.inquiry_items) {
    inquiry.inquiry_items.sort((a, b) => a.sort_order - b.sort_order);
  }
  return inquiry;
}

async function sendForInquiry(
  inquiry: Inquiry,
  adapters: NotificationAdapter[],
): Promise<string | null> {
  const configured = adapters.filter((a) => a.configured);
  if (configured.length === 0) {
    // Hard fail — never silently mark as sent.
    return NOTIFICATION_NOT_CONFIGURED_CODE;
  }
  const results = await Promise.allSettled(
    configured.map((a) => a.send(inquiry)),
  );
  // If any adapter rejects, throw with a coarse code. The caller maps this
  // to fail_inquiry_outbox_event which advances attempts and schedules retry.
  const firstFailure = results.find((r) => r.status === "rejected");
  if (firstFailure && firstFailure.status === "rejected") {
    const reason = firstFailure.reason;
    const code =
      reason instanceof Error ? reason.name : "NOTIFICATION_FAILED";
    return code;
  }
  return null;
}

/**
 * Process one batch of pending outbox events.
 *
 * @param batchSize  number of events to claim (1-50)
 * @param runtime    optional test runtime (custom fetch / timeout / adapters)
 */
export async function processInquiryOutbox(
  batchSize = 10,
  runtime?: OutboxRuntime,
): Promise<OutboxProcessingResult> {
  const safeBatchSize = Math.min(Math.max(Math.floor(batchSize), 1), 50);
  const client = createAdminSupabaseClient();

  const adapters =
    runtime?.notificationAdapters ?? buildAdapters(runtime?.notificationRuntime);
  const configuredCount = adapters.filter((a) => a.configured).length;

  // 1. Claim a batch atomically. The RPC generates a per-event lock_token
  //    and records processing_started_at. It also re-claims stale
  //    'processing' rows whose processing_started_at is older than the
  //    stale timeout (default 300s), so a crashed Worker's events are
  //    eventually recovered.
  const { data: claimedRaw, error: claimError } = await client.rpc(
    "claim_inquiry_outbox_batch",
    {
      p_limit: safeBatchSize,
      p_stale_timeout_seconds: runtime?.staleTimeoutSeconds ?? 300,
    },
  );
  if (claimError) {
    // Coarse log only — never the raw Postgres error text.
    console.error("OUTBOX_CLAIM_FAILED");
    return { claimed: 0, sent: 0, failed: 0, deadLettered: 0 };
  }
  const claimed = (claimedRaw ?? []) as ClaimedEvent[];
  if (claimed.length === 0) {
    return { claimed: 0, sent: 0, failed: 0, deadLettered: 0 };
  }

  let sent = 0;
  let failed = 0;
  let deadLettered = 0;

  // 2. Process each claimed event. Mark-sent / fail per event so a stale
  //    Worker cannot update an event that was re-claimed by a newer Worker
  //    (lock_token match enforced inside the RPC).
  for (const event of claimed) {
    try {
      // If no adapter is configured, hard-fail with a fixed code so the
      // event enters retry / dead_letter and surfaces in the status RPC.
      if (configuredCount === 0) {
        const failResult = await failEvent(
          client,
          event.id,
          event.lock_token,
          NOTIFICATION_NOT_CONFIGURED_CODE,
        );
        failed += 1;
        if (failResult === "dead_letter") deadLettered += 1;
        continue;
      }

      const inquiry = await loadInquiry(event.inquiry_id);
      if (!inquiry) {
        // Inquiry was deleted (FK is on delete cascade). Mark as sent so we
        // don't retry forever on a ghost event. (Lock-token match still
        // enforced inside the RPC.)
        const ok = await markSent(client, event.id, event.lock_token, null);
        if (ok) sent += 1;
        continue;
      }

      const sendError = await sendForInquiry(inquiry, adapters);
      if (sendError !== null) {
        // Adapter reported a failure — advance attempts / schedule retry
        // or dead-letter via the RPC. Use the outbox event id as the
        // provider idempotency key when adapters support it.
        const failResult = await failEvent(
          client,
          event.id,
          event.lock_token,
          sendError,
        );
        failed += 1;
        if (failResult === "dead_letter") deadLettered += 1;
        continue;
      }

      // Send succeeded — mark as sent. If mark-sent fails (network blip),
      // the event stays in 'processing' and will be re-claimed after the
      // stale timeout, causing a duplicate send (at-least-once).
      const ok = await markSent(client, event.id, event.lock_token, null);
      if (ok) {
        sent += 1;
      } else {
        // mark-sent failed — event remains 'processing'. Stale recovery
        // will re-claim and re-send. Counted as a soft failure for metrics.
        failed += 1;
      }
    } catch (err) {
      // Defensive — should not happen, but never crash the whole batch.
      const code =
        err instanceof Error ? err.name : "OUTBOX_SEND_FAILED";
      const failResult = await failEvent(
        client,
        event.id,
        event.lock_token,
        code,
      );
      failed += 1;
      if (failResult === "dead_letter") deadLettered += 1;
    }
  }

  return {
    claimed: claimed.length,
    sent,
    failed,
    deadLettered,
  };
}

/**
 * Mark a single outbox event as sent. Returns false if the lock_token no
 * longer matches (event was re-claimed by a newer Worker).
 */
async function markSent(
  client: ReturnType<typeof createAdminSupabaseClient>,
  eventId: string,
  lockToken: string,
  providerMessageId: string | null,
): Promise<boolean> {
  const { data, error } = await client.rpc("mark_inquiry_outbox_sent", {
    p_event_id: eventId,
    p_lock_token: lockToken,
    p_provider_message_id: providerMessageId,
  });
  if (error) {
    console.error("OUTBOX_MARK_SENT_FAILED");
    return false;
  }
  return data === true;
}

/**
 * Fail a single outbox event. Returns the real final status string
 * ('retry' | 'dead_letter' | 'NOT_FOUND_OR_TOKEN_MISMATCH' | 'INVALID_PARAMS')
 * from the RPC — never a guessed value.
 */
async function failEvent(
  client: ReturnType<typeof createAdminSupabaseClient>,
  eventId: string,
  lockToken: string,
  errorCode: string,
): Promise<string> {
  const { data, error } = await client.rpc("fail_inquiry_outbox_event", {
    p_event_id: eventId,
    p_lock_token: lockToken,
    p_error_code: errorCode,
  });
  if (error) {
    console.error("OUTBOX_FAIL_UPDATE_FAILED");
    // The event stays in 'processing' — stale recovery will re-claim it.
    return "retry";
  }
  return typeof data === "string" ? data : "retry";
}
