#!/usr/bin/env node
// ============================================================
// Mock Outbox Endpoint — test fixture for scheduler tests.
//
// Simulates the Outbox dispatch and status API endpoints for
// Phase 2 scheduler/monitor tests. NOT shipped to production.
//
// Usage:
//   node scripts/mock-outbox-endpoint.mjs --port=5434 --mode=<scenario>
//
// Modes (dispatch):
//   success       — 200 {ok:true, processed:true, result:{...}}
//   forbidden     — 403 {ok:false, error:"forbidden"}
//   server-error  — 500 {ok:false, error:"dispatch_failed"}
//   timeout       — 504 {ok:false, error:"dispatch_timeout"}
//   malformed     — 200 "not-json{"
//   aborted-200   — 200 {ok:true, processed:true, result:{aborted:true,...}}
//   disabled      — 503 {ok:false, error:"dispatcher_disabled"}
//
// Modes (status):
//   status-ok         — 200 {ok:true, snapshot:{...}}
//   status-pending-old — 200 with oldest_pending_age_seconds=400
//   status-claimed-old — 200 with oldest_claimed_age_seconds=700
//   status-dead-letter — 200 with dead_letter_count=1
//   status-malformed   — 200 "not-json{"
//   status-error       — 500 {ok:false, error:"snapshot_failed"}
//
// The server reads the OUTBOX_DISPATCH_SECRET env var to validate
// Bearer tokens (same as the real route). If the env var is unset,
// it accepts any token (test mode).
// ============================================================

import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "5434" },
    mode: { type: "string", default: "success" },
  },
});

const port = parseInt(values.port, 10);
const mode = values.mode;
const secret = process.env.OUTBOX_DISPATCH_SECRET || "";

function checkAuth(req) {
  if (secret && secret.length >= 16) {
    const auth = req.headers.authorization || "";
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    return match[1] === secret;
  }
  // Test mode — accept any token
  return true;
}

const DISPATCH_PATH = "/api/internal/outbox/dispatch";
const STATUS_PATH = "/api/internal/outbox/status";

const dispatchResponses = {
  success: {
    status: 200,
    body: JSON.stringify({
      ok: true,
      processed: true,
      result: {
        initialized: 1,
        claimed: 1,
        sent: 1,
        failed: 0,
        deadLettered: 0,
        aborted: false,
        skippedDueToAbort: 0,
      },
    }),
  },
  forbidden: {
    status: 403,
    body: JSON.stringify({ ok: false, error: "forbidden" }),
  },
  "server-error": {
    status: 500,
    body: JSON.stringify({ ok: false, error: "dispatch_failed" }),
  },
  timeout: {
    status: 504,
    body: JSON.stringify({
      ok: false,
      error: "dispatch_timeout",
      result: {
        initialized: 1,
        claimed: 1,
        sent: 0,
        failed: 0,
        deadLettered: 0,
        skippedDueToAbort: 1,
      },
    }),
  },
  malformed: {
    status: 200,
    body: 'not-json{',
    contentType: "text/plain",
  },
  "aborted-200": {
    status: 200,
    body: JSON.stringify({
      ok: true,
      processed: true,
      result: {
        initialized: 1,
        claimed: 1,
        sent: 0,
        failed: 0,
        deadLettered: 0,
        aborted: true,
        skippedDueToAbort: 1,
      },
    }),
  },
  disabled: {
    status: 503,
    body: JSON.stringify({ ok: false, error: "dispatcher_disabled" }),
  },
};

const statusResponses = {
  "status-ok": {
    status: 200,
    body: JSON.stringify({
      ok: true,
      snapshot: {
        pending_count: 0,
        retry_count: 0,
        claimed_count: 0,
        sent_count: 5,
        dead_letter_count: 0,
        cancelled_count: 0,
        oldest_pending_age_seconds: null,
        oldest_claimed_age_seconds: null,
        oldest_dead_letter_age_seconds: null,
        last_sent_at: "2026-07-29T00:00:00Z",
        last_failed_at: null,
        evaluated_at: "2026-07-29T00:00:00Z",
      },
    }),
  },
  "status-pending-old": {
    status: 200,
    body: JSON.stringify({
      ok: true,
      snapshot: {
        pending_count: 3,
        retry_count: 1,
        claimed_count: 0,
        sent_count: 5,
        dead_letter_count: 0,
        cancelled_count: 0,
        oldest_pending_age_seconds: 400,
        oldest_claimed_age_seconds: null,
        oldest_dead_letter_age_seconds: null,
        last_sent_at: "2026-07-29T00:00:00Z",
        last_failed_at: null,
        evaluated_at: "2026-07-29T00:00:00Z",
      },
    }),
  },
  "status-claimed-old": {
    status: 200,
    body: JSON.stringify({
      ok: true,
      snapshot: {
        pending_count: 0,
        retry_count: 0,
        claimed_count: 2,
        sent_count: 5,
        dead_letter_count: 0,
        cancelled_count: 0,
        oldest_pending_age_seconds: null,
        oldest_claimed_age_seconds: 700,
        oldest_dead_letter_age_seconds: null,
        last_sent_at: "2026-07-29T00:00:00Z",
        last_failed_at: null,
        evaluated_at: "2026-07-29T00:00:00Z",
      },
    }),
  },
  "status-dead-letter": {
    status: 200,
    body: JSON.stringify({
      ok: true,
      snapshot: {
        pending_count: 0,
        retry_count: 0,
        claimed_count: 0,
        sent_count: 5,
        dead_letter_count: 1,
        cancelled_count: 0,
        oldest_pending_age_seconds: null,
        oldest_claimed_age_seconds: null,
        oldest_dead_letter_age_seconds: 120,
        last_sent_at: "2026-07-29T00:00:00Z",
        last_failed_at: "2026-07-29T00:00:00Z",
        evaluated_at: "2026-07-29T00:00:00Z",
      },
    }),
  },
  "status-malformed": {
    status: 200,
    body: 'not-json{',
    contentType: "text/plain",
  },
  "status-error": {
    status: 500,
    body: JSON.stringify({ ok: false, error: "snapshot_failed" }),
  },
};

const server = createServer((req, res) => {
  // CORS headers for test clients
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Route to dispatch or status based on path
  const isStatus = req.url === STATUS_PATH;
  const isDispatch = req.url === DISPATCH_PATH;

  if (!isStatus && !isDispatch) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
    return;
  }

  // Auth check
  if (!checkAuth(req)) {
    const errorBody = isStatus
      ? { ok: false, error: "forbidden" }
      : { ok: false, error: "forbidden" };
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify(errorBody));
    return;
  }

  // Method check
  if (isDispatch && req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
    return;
  }
  if (isStatus && req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
    return;
  }

  // Select response based on mode
  const responses = isStatus ? statusResponses : dispatchResponses;
  const response = responses[mode];

  if (!response) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: `unknown_mode:${mode}` }));
    return;
  }

  const headers = {
    "Content-Type": response.contentType || "application/json",
    "Cache-Control": "private, no-store",
  };

  res.writeHead(response.status, headers);
  res.end(response.body);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Mock outbox endpoint listening on http://127.0.0.1:${port} (mode=${mode})`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});

export { server };
