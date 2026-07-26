import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import {
  createNotificationAdapters,
  NotificationAdapter,
  NotificationError,
  NotificationRuntime,
  NotificationSendContext,
} from "./notifications";
import type { Inquiry } from "@/types/database";

/**
 * Phase 14: Per-provider Outbox processor.
 *
 * Canonical notification delivery path. Driven by the
 * `inquiry_outbox` (parent) + `inquiry_outbox_deliveries` (per-provider)
 * tables written in the same transaction as the inquiry insert.
 *
 * RUNTIME MODEL:
 *   parent event (inquiry_outbox)
 *     └── Provider delivery rows (inquiry_outbox_deliveries)
 *           ├── email
 *           └── wecom
 *
 * The processing unit is ONE delivery row = ONE provider's logical
 * delivery. We NEVER call all adapters for a parent event in a single
 * step. A succeeded delivery is never re-invoked even if another
 * provider's delivery fails and the parent event retries.
 *
 * Workflow (per batch):
 *   1. find_uninitialized_outbox_events(limit) → events that need
 *      provider delivery rows created.
 *   2. For each uninitialized event:
 *      a. Determine the server-configured providers (email, wecom).
 *      b. initialize_inquiry_outbox_deliveries(event_id, providers)
 *         — creates one delivery row per whitelisted provider.
 *         — if 0 providers configured, parent goes directly to
 *           dead_letter with NOTIFICATION_NOT_CONFIGURED.
 *         — otherwise parent transitions to 'processing'.
 *   3. claim_inquiry_outbox_deliveries(limit, stale_timeout) →
 *      atomically marks N pending/retry/stale-claimed delivery rows
 *      as 'claimed' using FOR UPDATE SKIP LOCKED, generates a
 *      per-delivery lock_token, and records processing_started_at.
 *      Returns: id, outbox_event_id, provider, lock_token, attempts,
 *      max_attempts.
 *   4. For each claimed delivery:
 *      a. Select the adapter matching delivery.provider.
 *      b. Load the inquiry.
 *      c. Call adapter.send(inquiry, context) where context.attempt
 *         = delivery.attempts + 1 (NOT hardcoded 1).
 *      d. success → mark_delivery_sent(delivery_id, lock_token,
 *         provider_message_id). The RPC marks the parent event as
 *         'sent' only when ALL deliveries for that event are 'sent'.
 *      e. failure → fail_delivery_event(delivery_id, lock_token,
 *         error_code, force_dead_letter). The RPC marks the parent
 *         as 'dead_letter' when any delivery is dead_letter.
 *
 * Stale processing recovery:
 *   If a Worker crashes after claiming but before mark-sent / fail,
 *   the delivery row stays in 'claimed'. claim_inquiry_outbox_deliveries
 *   re-claims any row whose processing_started_at is older than the
 *   stale timeout (default 300s). This guarantees at-least-once
 *   delivery — a send may be duplicated, but no delivery is silently
 *   lost. Resend's Idempotency-Key Header suppresses email duplicates;
 *   WeCom webhook has no equivalent and may duplicate.
 *
 * Delivery semantics: AT-LEAST-ONCE.
 *   - Resend email: Idempotency-Key Header = `kzq/inquiry/{eventId}/email`
 *     suppresses duplicates across retries of the same delivery.
 *   - WeCom webhook: no idempotency support; duplicate sends possible.
 *   - A succeeded delivery is NEVER re-invoked (per-provider state).
 *
 * NOTIFICATION_NOT_CONFIGURED:
 *   If no adapter is configured, initialize_inquiry_outbox_deliveries
 *   creates 0 delivery rows and marks the parent as dead_letter with
 *   code NOTIFICATION_NOT_CONFIGURED. We never mark an unsent event
 *   as 'sent'.
 *
 * EDGEONE BLOCK NOTE:
 *   EdgeOne does not currently provide a guaranteed long-running
 *   worker / cron mechanism. This processor is invocable from an
 *   admin-authenticated API route (manual / on-demand). Until a
 *   platform cron exists, dead_letter events require manual review.
 */

export interface OutboxProcessingResult {
  initialized: number;
  claimed: number;
  sent: number;
  failed: number;
  deadLettered: number;
  /**
   * Section 10 — explicit abort state.
   *
   * `aborted=true` means the AbortSignal fired during processing.
   * The route MUST translate this into HTTP 504 — it MUST NOT
   * return 200 with `aborted=true`. The processor never throws on
   * abort (it stops cleanly), so the route cannot rely on a thrown
   * AbortError to detect the timeout.
   *
   * `aborted=false` is the normal case: the signal never fired, OR
   * no signal was supplied.
   */
  aborted: boolean;
  /**
   * Section 10 — count of claimed delivery rows we never touched
   * because the signal aborted mid-batch. These rows stay 'claimed'
   * and are re-claimed by stale recovery (default 300s). The route
   * surfaces this in the 504 body for observability.
   */
  skippedDueToAbort: number;
}

interface ClaimedDelivery {
  id: string;
  outbox_event_id: string;
  provider: string;
  lock_token: string;
  attempts: number;
  max_attempts: number;
}

interface OutboxRuntime {
  notificationAdapters?: NotificationAdapter[];
  /** Optional override for the notification fetch/timeout (tests). */
  notificationRuntime?: NotificationRuntime;
  /** Override the stale-processing recovery timeout (seconds, tests). */
  staleTimeoutSeconds?: number;
  /**
   * Optional external AbortSignal threaded from the dispatcher route.
   *
   * Behavior when aborted:
   *   - The processor stops claiming NEW delivery rows.
   *   - Any in-flight adapter.send call is aborted via the signal
   *     threaded through NotificationSendContext.signal →
   *     NotificationRuntime.signal → postJson AbortSignal.any.
   *   - The current iteration's failure is recorded as a soft failure
   *     (status remains 'claimed'); stale recovery re-claims it later.
   *   - The processor returns the partial result collected so far.
   *
   * This satisfies Section 11 方案 B of the commercial delivery review:
   * "AbortSignal 贯穿 route → processInquiryOutbox → adapter.send →
   *  provider fetch. 超时时停止领取新 delivery，abort 正在发送的 HTTP."
   */
  signal?: AbortSignal;
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

/**
 * Returns the server-configured provider names in whitelist order.
 * The browser NEVER supplies providers — only server-side env vars.
 */
function getConfiguredProviderNames(
  adapters: NotificationAdapter[],
): string[] {
  return adapters
    .filter((a) => a.configured)
    .map((a) => a.name)
    .filter((name): name is "email" | "wecom" =>
      name === "email" || name === "wecom",
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

/**
 * Step 1: Initialize provider delivery rows for events that haven't
 * been initialized yet. Returns the number of events initialized.
 */
async function initializeUninitializedEvents(
  client: ReturnType<typeof createAdminSupabaseClient>,
  providers: string[],
  batchSize: number,
): Promise<number> {
  // Even when providers is empty, we still call initialize for each
  // event so the RPC marks them as dead_letter with
  // NOTIFICATION_NOT_CONFIGURED.

  const { data: eventIds, error: findError } = await client.rpc(
    "find_uninitialized_outbox_events",
    { p_limit: batchSize },
  );
  if (findError) {
    console.error("OUTBOX_FIND_UNINITIALIZED_FAILED");
    return 0;
  }
  const ids = (eventIds ?? []) as string[];
  if (ids.length === 0) return 0;

  let initialized = 0;
  for (const eventId of ids) {
    const { error: initError } = await client.rpc(
      "initialize_inquiry_outbox_deliveries",
      {
        p_outbox_event_id: eventId,
        p_providers: providers,
      },
    );
    if (initError) {
      console.error("OUTBOX_INITIALIZE_DELIVERIES_FAILED");
      continue;
    }
    initialized += 1;
  }
  return initialized;
}

/**
 * Step 2: Claim a batch of delivery rows for processing.
 */
async function claimDeliveries(
  client: ReturnType<typeof createAdminSupabaseClient>,
  batchSize: number,
  staleTimeoutSeconds: number,
): Promise<ClaimedDelivery[]> {
  const { data, error } = await client.rpc(
    "claim_inquiry_outbox_deliveries",
    {
      p_limit: batchSize,
      p_stale_timeout_seconds: staleTimeoutSeconds,
    },
  );
  if (error) {
    console.error("OUTBOX_CLAIM_DELIVERIES_FAILED");
    return [];
  }
  return (data ?? []) as ClaimedDelivery[];
}

/**
 * Mark a single delivery as sent. Returns false if the lock_token no
 * longer matches (delivery was re-claimed by a newer Worker).
 */
async function markDeliverySent(
  client: ReturnType<typeof createAdminSupabaseClient>,
  deliveryId: string,
  lockToken: string,
  providerMessageId: string | null,
): Promise<boolean> {
  const { data, error } = await client.rpc("mark_delivery_sent", {
    p_delivery_id: deliveryId,
    p_lock_token: lockToken,
    p_provider_message_id: providerMessageId,
  });
  if (error) {
    console.error("OUTBOX_MARK_DELIVERY_SENT_FAILED");
    return false;
  }
  return data === true;
}

/**
 * Fail a single delivery. Returns the real final status string
 * ('retry' | 'dead_letter' | 'NOT_FOUND_OR_TOKEN_MISMATCH' | 'INVALID_PARAMS')
 * from the RPC — never a guessed value.
 */
async function failDelivery(
  client: ReturnType<typeof createAdminSupabaseClient>,
  deliveryId: string,
  lockToken: string,
  errorCode: string,
  forceDeadLetter: boolean,
): Promise<string> {
  const { data, error } = await client.rpc("fail_delivery_event", {
    p_delivery_id: deliveryId,
    p_lock_token: lockToken,
    p_error_code: errorCode,
    p_force_dead_letter: forceDeadLetter,
  });
  if (error) {
    console.error("OUTBOX_FAIL_DELIVERY_FAILED");
    return "retry";
  }
  return typeof data === "string" ? data : "retry";
}

/**
 * Process one batch of pending outbox deliveries.
 *
 * @param batchSize  number of deliveries to claim (1-100)
 * @param runtime    optional test runtime (custom fetch / timeout / adapters)
 */
export async function processInquiryOutbox(
  batchSize = 10,
  runtime?: OutboxRuntime,
): Promise<OutboxProcessingResult> {
  const safeBatchSize = Math.min(Math.max(Math.floor(batchSize), 1), 100);
  const client = createAdminSupabaseClient();

  const adapters =
    runtime?.notificationAdapters ?? buildAdapters(runtime?.notificationRuntime);
  const providers = getConfiguredProviderNames(adapters);
  const externalSignal = runtime?.signal;

  // If the caller already aborted before we even started, do nothing.
  // This keeps the contract simple: abort = stop immediately.
  if (externalSignal?.aborted) {
    return {
      initialized: 0,
      claimed: 0,
      sent: 0,
      failed: 0,
      deadLettered: 0,
      aborted: true,
      skippedDueToAbort: 0,
    };
  }

  // Step 1: Initialize provider delivery rows for uninitialized events.
  const initialized = await initializeUninitializedEvents(
    client,
    providers,
    safeBatchSize,
  );

  // Step 2: Claim a batch of delivery rows.
  // Re-check abort AFTER initialization — initialize can take time when
  // many events are queued.
  if (externalSignal?.aborted) {
    return {
      initialized,
      claimed: 0,
      sent: 0,
      failed: 0,
      deadLettered: 0,
      aborted: true,
      skippedDueToAbort: 0,
    };
  }
  const claimed = await claimDeliveries(
    client,
    safeBatchSize,
    runtime?.staleTimeoutSeconds ?? 300,
  );
  if (claimed.length === 0) {
    return {
      initialized,
      claimed: 0,
      sent: 0,
      failed: 0,
      deadLettered: 0,
      aborted: false,
      skippedDueToAbort: 0,
    };
  }

  let sent = 0;
  let failed = 0;
  let deadLettered = 0;
  // Track how many claimed rows we never touched because of abort.
  // These remain in 'claimed' status and will be re-claimed by stale
  // recovery — we do NOT silently roll them back here.
  let skippedDueToAbort = 0;

  // Step 3: Process each claimed delivery row.
  for (const delivery of claimed) {
    // Re-check abort BEFORE each delivery. If aborted, stop claiming
    // new work; remaining claimed rows stay 'claimed' and are picked
    // up by stale recovery (default 300s).
    if (externalSignal?.aborted) {
      skippedDueToAbort += 1;
      continue;
    }

    try {
      // Select the adapter matching delivery.provider.
      const adapter = adapters.find(
        (a) => a.name === delivery.provider && a.configured,
      );
      if (!adapter) {
        // Provider not configured (e.g. env var removed after init).
        // Force dead_letter so it surfaces for manual review.
        const failResult = await failDelivery(
          client,
          delivery.id,
          delivery.lock_token,
          `${NOTIFICATION_NOT_CONFIGURED_CODE}_${delivery.provider}`,
          true,
        );
        failed += 1;
        if (failResult === "dead_letter") deadLettered += 1;
        continue;
      }

      // Load the inquiry. The delivery row has outbox_event_id, not
      // inquiry_id — we need to look up the inquiry_id via the parent.
      const { data: eventRow, error: eventError } = await client
        .from("inquiry_outbox")
        .select("inquiry_id")
        .eq("id", delivery.outbox_event_id)
        .single() as { data: { inquiry_id: string | null } | null; error: unknown };
      if (eventError || !eventRow) {
        // Parent event was deleted (FK cascade). Mark as sent so we
        // don't retry forever on a ghost delivery.
        const ok = await markDeliverySent(
          client,
          delivery.id,
          delivery.lock_token,
          null,
        );
        if (ok) sent += 1;
        continue;
      }

      const inquiry = await loadInquiry(eventRow.inquiry_id ?? "");
      if (!inquiry) {
        // Inquiry was deleted (FK cascade). Mark as sent so we don't
        // retry forever on a ghost event.
        const ok = await markDeliverySent(
          client,
          delivery.id,
          delivery.lock_token,
          null,
        );
        if (ok) sent += 1;
        continue;
      }

      // Build the idempotency context. eventId is stable across
      // retries (so Resend's Idempotency-Key Header suppresses
      // duplicates). attempt is delivery.attempts + 1 (NOT hardcoded).
      // signal is threaded down so adapter.send → postJson can abort
      // the in-flight HTTP request when the dispatcher route times out.
      const context: NotificationSendContext = {
        eventId: delivery.outbox_event_id,
        lockToken: delivery.lock_token,
        attempt: delivery.attempts + 1,
        provider: delivery.provider as "email" | "wecom",
        signal: externalSignal,
      };

      let providerMessageId: string | null = null;
      try {
        const result = await adapter.send(inquiry, context);
        providerMessageId = result.providerMessageId ?? null;
      } catch (err) {
        // If the abort fired mid-send, the delivery is still in
        // 'claimed' state. Stale recovery will re-claim and retry.
        // We MUST NOT force this to dead_letter — abort is an
        // operational signal, not a permanent provider failure.
        if (externalSignal?.aborted) {
          skippedDueToAbort += 1;
          continue;
        }
        // Adapter threw — classify and fail the delivery.
        const isPermanent =
          err instanceof NotificationError && err.kind === "permanent";
        const code =
          err instanceof NotificationError
            ? err.code
            : err instanceof Error
              ? err.name
              : "NOTIFICATION_FAILED";
        const failResult = await failDelivery(
          client,
          delivery.id,
          delivery.lock_token,
          code,
          isPermanent,
        );
        failed += 1;
        if (failResult === "dead_letter") deadLettered += 1;
        continue;
      }

      // Send succeeded — mark delivery as sent. The RPC will mark
      // the parent event as 'sent' only when ALL deliveries are sent.
      const ok = await markDeliverySent(
        client,
        delivery.id,
        delivery.lock_token,
        providerMessageId,
      );
      if (ok) {
        sent += 1;
      } else {
        // mark-sent failed — delivery remains 'claimed'. Stale
        // recovery will re-claim and re-send. Counted as soft failure.
        failed += 1;
      }
    } catch (err) {
      // If the abort fired during the post-send RPC, the delivery
      // stays 'claimed' and stale recovery will pick it up.
      if (externalSignal?.aborted) {
        skippedDueToAbort += 1;
        continue;
      }
      // Defensive — should not happen, but never crash the whole batch.
      const code =
        err instanceof Error ? err.name : "OUTBOX_SEND_FAILED";
      const failResult = await failDelivery(
        client,
        delivery.id,
        delivery.lock_token,
        code,
        false,
      );
      failed += 1;
      if (failResult === "dead_letter") deadLettered += 1;
    }
  }

  // `skippedDueToAbort` is intentionally NOT added to `failed` — those
  // rows are still 'claimed' and will be re-claimed by stale recovery.
  // We surface the count in the result so the route can return 504
  // (Section 10) and include it in the response body for observability.
  // The `claimed` counter reflects what we picked up (not what we
  // finished), so the route can compute `claimed - skipped` if needed.
  const aborted = externalSignal?.aborted === true;
  return {
    initialized,
    claimed: claimed.length,
    sent,
    failed,
    deadLettered,
    aborted,
    skippedDueToAbort,
  };
}
