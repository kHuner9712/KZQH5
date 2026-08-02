// ============================================================
// Rate limiting — global interface + backend drivers
// ------------------------------------------------------------
// The RateLimiter interface is the single replacement point for any
// production-grade implementation (PostgreSQL atomic RPC, KV, Redis).
//
// Two drivers:
//   1. PostgresRateLimiter (KZQ-P1-011-b) — multi-instance SHARED
//      counter via the `rate_limit_check` RPC. Select with
//      `RATE_LIMIT_DRIVER=postgres`. This is the production-grade
//      distributed backend.
//   2. MemoryRateLimiter — consistent only within a single Node
//      process. Intended as a low-cost first layer and as a
//      development/test fallback; on EdgeOne multi-instance
//      deployments the effective limit may be N × configured.
//
// ⚠️ Multi-instance boundary:
// - MemoryRateLimiter is consistent only within a single Node process.
//   On EdgeOne multi-instance deployments the effective limit may be
//   N × configured (N = running instances).
// - Production deployments MUST additionally enable EdgeOne WAF /
//   Rate Limiting rules. This is documented in
//   docs/LAUNCH_CHECKLIST.md and docs/EDGEONE_WAF_RULES.md.
// - For strong global consistency, set RATE_LIMIT_DRIVER=postgres
//   (the PostgresRateLimiter below). Call sites do not need to change.
// ============================================================

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string): Promise<RateLimitResult>;
}

// ============================================================
// PostgreSQL-backed distributed rate limiter (KZQ-P1-011-b)
// ------------------------------------------------------------
// Multi-instance SHARED counter via the `rate_limit_check` RPC
// (migration 20260801000000_distributed_rate_limit_rpc.sql).
//
// Semantics:
//   - FIXED WINDOW — window boundary computed by the RPC as
//     floor(epoch / window_seconds) * window_seconds.
//   - ATOMIC — INSERT ... ON CONFLICT DO UPDATE under row lock; no
//     lost updates across concurrent instances.
//   - Keys are opaque caller-supplied strings (already namespaced by
//     the application: `ip:<addr>`, `admin:<userId>`, etc.). No PII.
//
// Failure policy (P1-011-a decision matrix):
//   - RPC transport error / null / malformed / ok !== true →
//     FAIL-OPEN (allowed). A transient DB hiccup must not block all
//     traffic; EdgeOne WAF provides the cross-instance floor in
//     production (WAF_RATE_LIMIT_VERIFIED release gate).
//   - NEVER throws to callers. Logs a fixed code only.
//
// The client factory is injected so tests can supply a stub; the
// default uses the server-side service_role client.
// ============================================================

/** Shape of the `rate_limit_check` RPC JSONB response. */
interface RateLimitCheckRpcResult {
  ok?: unknown;
  allowed?: unknown;
  remaining?: unknown;
  retry_after_seconds?: unknown;
}

/**
 * Strictly parse the RPC response. Any transport error, null, invalid
 * structure, or ok !== true is a failure → fail-open.
 * Returns null on failure (caller applies fail-open).
 */
function parseRateLimitCheckRpc(
  data: RateLimitCheckRpcResult | null | undefined,
): RateLimitResult | null {
  if (!data || typeof data !== "object") return null;
  if (data.ok !== true) return null;
  if (typeof data.allowed !== "boolean") return null;
  const remaining = typeof data.remaining === "number" ? data.remaining : 0;
  const retryAfterSeconds =
    typeof data.retry_after_seconds === "number"
      ? data.retry_after_seconds
      : 0;
  return {
    allowed: data.allowed,
    remaining,
    retryAfterSeconds,
  };
}

/** Injected RPC transport: returns raw response or throws. */
export type RateLimitRpcTransport = (
  bucket: string,
  key: string,
  maxCount: number,
  windowSeconds: number,
) => Promise<{ data: RateLimitCheckRpcResult | null; error: unknown }>;

/**
 * Default transport using the server-side service_role client. The
 * RPC is service_role-only (migration grant), so this must never be
 * imported from a client component.
 *
 * The admin client is loaded via a lazy dynamic import inside the
 * closure so that importing this module in a pure-Node context
 * (scripts/tests) does not force the Supabase admin client to load;
 * the import is deferred until the first actual RPC call.
 */
export function createPostgresRateLimitTransport(): RateLimitRpcTransport {
  return async (bucket, key, maxCount, windowSeconds) => {
    const { createAdminClient } = (await import("@/lib/supabase/admin")) as unknown as {
      createAdminClient: () => {
        rpc: (
          fn: string,
          args: Record<string, unknown>,
        ) => PromiseLike<{
          data: RateLimitCheckRpcResult | null;
          error: unknown;
        }>;
      };
    };
    const client = createAdminClient();
    return await client.rpc("rate_limit_check", {
      p_bucket: bucket,
      p_key: key,
      p_max_count: maxCount,
      p_window_seconds: windowSeconds,
    });
  };
}

/**
 * Fixed-window distributed rate limiter backed by PostgreSQL.
 *
 * Use via `createRateLimiter()` (or the named factory functions) —
 * call sites consume the same `RateLimiter` interface and do not
 * change.
 */
export class PostgresRateLimiter implements RateLimiter {
  constructor(
    private readonly bucket: string,
    private readonly maximum: number,
    private readonly windowMs: number,
    private readonly transport: RateLimitRpcTransport = createPostgresRateLimitTransport(),
  ) {}

  async check(key: string): Promise<RateLimitResult> {
    const windowSeconds = Math.max(1, Math.ceil(this.windowMs / 1000));
    try {
      const { data, error } = await this.transport(
        this.bucket,
        key,
        this.maximum,
        windowSeconds,
      );
      if (error) {
        // Fail-open per P1-011-a decision matrix.
        console.warn("RATE_LIMIT_POSTGRES_TRANSPORT_FAILED");
        return { allowed: true, remaining: Infinity, retryAfterSeconds: 0 };
      }
      const parsed = parseRateLimitCheckRpc(data);
      if (!parsed) {
        console.warn("RATE_LIMIT_POSTGRES_MALFORMED_RESPONSE");
        return { allowed: true, remaining: Infinity, retryAfterSeconds: 0 };
      }
      return parsed;
    } catch {
      // Transport threw (e.g. env missing, network). Fail-open.
      console.warn("RATE_LIMIT_POSTGRES_EXCEPTION");
      return { allowed: true, remaining: Infinity, retryAfterSeconds: 0 };
    }
  }
}

/**
 * Select the rate-limit backend driver.
 *
 *   RATE_LIMIT_DRIVER=postgres → PostgresRateLimiter (distributed,
 *     multi-instance shared; requires the rate_limit_check RPC).
 *   unset or "memory"         → MemoryRateLimiter (in-process only;
 *     the pre-existing default).
 *
 * Production deployments that need strong global consistency should
 * set `RATE_LIMIT_DRIVER=postgres` (plus EdgeOne WAF as the floor).
 */
export function getRateLimitDriver(): "postgres" | "memory" {
  return process.env.RATE_LIMIT_DRIVER === "postgres" ? "postgres" : "memory";
}

/**
 * Create a rate limiter for the configured driver.
 *
 *   - RATE_LIMIT_DRIVER=postgres → PostgresRateLimiter (distributed,
 *     multi-instance shared).
 *   - unset / "memory" → MemoryRateLimiter (in-process).
 *
 * New call sites SHOULD use this factory so the backend can be
 * switched via environment configuration without code changes.
 */
export function createRateLimiter(
  bucket: string,
  maximum: number,
  windowMs: number,
): RateLimiter {
  if (getRateLimitDriver() === "postgres") {
    return new PostgresRateLimiter(bucket, maximum, windowMs);
  }
  return new MemoryRateLimiter(maximum, windowMs);
}

interface MemoryEntry {
  count: number;
  firstRequestAt: number;
  // Linked-list pointers for insertion-order eviction when capacity is
  // reached. We keep a doubly-linked list of entries in INSERTION order
  // (NOT access/LRU order) so that when the map is full we can evict
  // the OLDEST still-live entry in O(1) instead of scanning the entire
  // map. Accessing an existing entry does NOT move it to the head —
  // eviction is strictly by insertion time, which matches the
  // `firstRequestAt`-based expiry semantics.
  prev: MemoryEntry | null;
  next: MemoryEntry | null;
  key: string;
}

// Default capacity for a single MemoryRateLimiter instance. Each entry
// is small (~80 bytes), so 10k entries is well under 1 MB. This protects
// against unbounded memory growth if an attacker sprays random rate-limit
// keys (e.g. via forged IP headers when no trusted proxy is configured).
const DEFAULT_MAX_ENTRIES = 10_000;

// When the limiter is at capacity and a new key arrives, fail-safe by
// treating the new key as over-limit (reject the request) rather than
// evicting a legitimate in-window entry that could let an attacker reset
// a victim's bucket. This is the conservative choice.
const FAIL_SAFE_ON_CAPACITY = true;

export class MemoryRateLimiter implements RateLimiter {
  private readonly entries = new Map<string, MemoryEntry>();
  // Head = most recently inserted entry, Tail = oldest inserted entry.
  // This is INSERTION order, not LRU access order — see MemoryEntry docs.
  private head: MemoryEntry | null = null;
  private tail: MemoryEntry | null = null;
  private lastCleanupAt: number;

  constructor(
    private readonly maximum: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
  ) {
    this.lastCleanupAt = this.now();
  }

  /**
   * Lazy cleanup: sweep expired entries, but only when at least
   * `windowMs / 4` has elapsed since the last sweep. This avoids the
   * previous O(N) per-request behavior while still bounding staleness.
   */
  private maybeCleanup(now: number): void {
    if (now - this.lastCleanupAt < Math.max(this.windowMs / 4, 1_000)) {
      return;
    }
    this.lastCleanupAt = now;
    // Walk the tail-forward: tail is the oldest entry, so once we hit
    // a non-expired entry we can stop because everything ahead of it
    // in the linked list is newer.
    while (this.tail && now - this.tail.firstRequestAt >= this.windowMs) {
      this.unlinkAndDelete(this.tail);
    }
  }

  private unlinkAndDelete(entry: MemoryEntry): void {
    const { prev, next } = entry;
    if (prev) prev.next = next;
    else this.head = next;
    if (next) next.prev = prev;
    else this.tail = prev;
    this.entries.delete(entry.key);
  }

  private insertHead(entry: MemoryEntry): void {
    entry.prev = null;
    entry.next = this.head;
    if (this.head) this.head.prev = entry;
    this.head = entry;
    if (!this.tail) this.tail = entry;
  }

  async check(key: string): Promise<RateLimitResult> {
    const now = this.now();
    this.maybeCleanup(now);

    const existing = this.entries.get(key);
    if (existing) {
      // Phase 1 Task 1: an existing entry may be STALE — its window may
      // have expired even though the global cleanup throttle has not
      // fired (cleanup runs at most once per windowMs/4). If we merely
      // increment the count on a stale entry, a legitimate request that
      // arrives just after the window ends will be rejected using the
      // OLD window's count, which is the bug.
      //
      // Fix: when the entry's own window has elapsed, treat the request
      // as the first request of a NEW window. Remove the stale entry
      // from the map + linked list, then fall through to the "new key"
      // path below (which inserts a fresh entry with count=1).
      const entryExpired = now - existing.firstRequestAt >= this.windowMs;
      if (!entryExpired) {
        // Entry is still live: increment and return.
        existing.count += 1;
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((this.windowMs - (now - existing.firstRequestAt)) / 1000),
        );
        return {
          allowed: existing.count <= this.maximum,
          remaining: Math.max(0, this.maximum - existing.count),
          retryAfterSeconds,
        };
      }
      // Entry is expired: remove it so the "new key" path re-inserts a
      // fresh entry. This keeps entryCount and the linked list consistent
      // (no duplicate keys, no dangling pointers).
      this.unlinkAndDelete(existing);
      // Fall through to the "new key" path to insert a fresh entry.
    }

    // New key (or freshly-expired key treated as new). Enforce capacity
    // BEFORE inserting to avoid unbounded growth.
    if (this.entries.size >= this.maxEntries) {
      // Try to evict expired entries first (cheap tail walk).
      while (this.tail && now - this.tail.firstRequestAt >= this.windowMs) {
        this.unlinkAndDelete(this.tail);
      }
      if (this.entries.size >= this.maxEntries) {
        if (FAIL_SAFE_ON_CAPACITY) {
          // Fail-safe: deny the new key rather than evicting a live entry.
          // An attacker cannot reset a victim's bucket this way.
          return {
            allowed: false,
            remaining: 0,
            retryAfterSeconds: Math.ceil(this.windowMs / 1000),
          };
        }
        // Last-resort: evict the oldest entry to admit the new one.
        if (this.tail) this.unlinkAndDelete(this.tail);
      }
    }

    const entry: MemoryEntry = {
      count: 1,
      firstRequestAt: now,
      prev: null,
      next: null,
      key,
    };
    this.entries.set(key, entry);
    this.insertHead(entry);

    return {
      allowed: true,
      remaining: Math.max(0, this.maximum - 1),
      retryAfterSeconds: Math.ceil(this.windowMs / 1000),
    };
  }

  entryCount(): number {
    return this.entries.size;
  }
}

// 数据访问边界：未来接入 KV / Redis 时，只需替换该工厂返回的实现。
// 当前内存实现适用于无持久 KV 的部署，并作为可靠 fallback。
//
// ⚠️ 多实例边界说明：
// - 内存限流器只在单个 Node 进程内一致。EdgeOne 多实例部署时，不同实例之间不共享状态，
//   实际限流阈值可能为 N × 配置阈值（N 为运行实例数）。
// - 因此本实现仅作为第一层低成本防御，不能替代平台级 WAF / Rate Limiting。
// - 生产环境若需要强一致的全局限流，必须在 EdgeOne 控制台启用 WAF / Rate Limiting 规则，
//   或将 RateLimiter 工厂改为基于 KV / Redis 的实现（接口已抽出，调用方无需改动）。
// - 该边界已在 docs/CODE_FINALIZATION_REPORT.md 与 docs/LAUNCH_CHECKLIST.md 中
//   列为生产验收项，不在代码层强制实现。
let inquiryLimiter: RateLimiter | null = null;
let analyticsLimiter: RateLimiter | null = null;
let storageUploadLimiter: RateLimiter | null = null;

export function getInquiryRateLimiter(): RateLimiter {
  if (!inquiryLimiter)
    inquiryLimiter = new MemoryRateLimiter(5, 10 * 60 * 1000);
  return inquiryLimiter;
}

export function getAnalyticsRateLimiter(): RateLimiter {
  if (!analyticsLimiter)
    analyticsLimiter = new MemoryRateLimiter(60, 60 * 1000);
  return analyticsLimiter;
}

/**
 * Storage upload rate limiter (per admin actor).
 *
 * Limit: 20 uploads / 5 minutes / actor. This is intentionally conservative
 * — admin uploads are infrequent operations (image/PDF management) and a
 * burst usually indicates either a script loop or an abuse attempt.
 *
 * Multi-instance caveat applies (see MemoryRateLimiter header). Production
 * deployments MUST additionally enforce EdgeOne WAF rate-limiting rules.
 */
export function getStorageUploadRateLimiter(): RateLimiter {
  if (!storageUploadLimiter)
    storageUploadLimiter = new MemoryRateLimiter(20, 5 * 60 * 1000);
  return storageUploadLimiter;
}

// Work Package G: readiness probe rate limiter.
// Limit: 12 probes / 60s / IP. /api/readiness hits Supabase REST +
// Storage + an RPC via service_role — without rate limiting, an
// attacker could DOS Supabase by repeatedly hitting the endpoint,
// or use it as an oracle to probe service_role behavior. The limit
// is intentionally generous enough to support legitimate monitoring
// (typical: 1 probe / 10s = 6/min) while still bounding abuse.
let readinessLimiter: RateLimiter | null = null;

export function getReadinessRateLimiter(): RateLimiter {
  if (!readinessLimiter)
    readinessLimiter = new MemoryRateLimiter(12, 60 * 1000);
  return readinessLimiter;
}

// Phase 6: OG image generation rate limiter.
// Limit: 30 / 60s / IP. /api/og renders a 1200×630 PNG via Satori +
// resvg (CPU-intensive). Without rate limiting, an attacker could
// DOS the server by requesting many distinct titles (each triggers a
// fresh render since the title is in the query string). The limit is
// generous enough to support legitimate social-sharing crawlers
// (WeChat, Twitter, LinkedIn fetch once per share) and browser
// prefetch, while bounding CPU abuse.
//
// Multi-instance caveat applies (see MemoryRateLimiter header).
let ogLimiter: RateLimiter | null = null;

export function getOgRateLimiter(): RateLimiter {
  if (!ogLimiter) ogLimiter = new MemoryRateLimiter(30, 60 * 1000);
  return ogLimiter;
}

// Phase 6: WeChat JS-SDK config rate limiter.
// Limit: 20 / 60s / IP. /api/wechat/jssdk calls the WeChat backend
// API (which has its own quota) to fetch access_token + jsapi_ticket,
// then signs a config. Without rate limiting, an attacker could
// exhaust the WeChat API quota (which is shared across ALL users of
// the app) by repeatedly hitting this endpoint. The limit is generous
// enough for legitimate page loads (one fetch per page that needs
// JS-SDK) while bounding quota abuse.
//
// Multi-instance caveat applies (see MemoryRateLimiter header).
let wechatJsSdkLimiter: RateLimiter | null = null;

export function getWechatJsSdkRateLimiter(): RateLimiter {
  if (!wechatJsSdkLimiter)
    wechatJsSdkLimiter = new MemoryRateLimiter(20, 60 * 1000);
  return wechatJsSdkLimiter;
}

// Phase 7: Health endpoint rate limiter.
// Limit: 30 / 60s / IP. /api/health returns app metadata (name, version,
// commit SHA, demo flag). While the data is non-sensitive, unthrottled
// access allows probing and information gathering. The limit is generous
// for legitimate monitoring (typical: 1 probe / 30s = 2/min) while
// bounding abuse.
//
// Multi-instance caveat applies (see MemoryRateLimiter header).
let healthLimiter: RateLimiter | null = null;

export function getHealthRateLimiter(): RateLimiter {
  if (!healthLimiter) healthLimiter = new MemoryRateLimiter(30, 60 * 1000);
  return healthLimiter;
}

// Phase 7: Featured projects rate limiter.
// Limit: 30 / 60s / IP. /api/projects/featured queries the database for
// featured projects. While the response is CDN-cached (s-maxage=300), a
// cache miss hits the database. Without rate limiting, an attacker could
// bypass the CDN cache (e.g. via Vary header manipulation) and DOS the
// database. The limit is generous for legitimate traffic while bounding
// abuse.
//
// Multi-instance caveat applies (see MemoryRateLimiter header).
let featuredProjectsLimiter: RateLimiter | null = null;

export function getFeaturedProjectsRateLimiter(): RateLimiter {
  if (!featuredProjectsLimiter)
    featuredProjectsLimiter = new MemoryRateLimiter(30, 60 * 1000);
  return featuredProjectsLimiter;
}

// Phase 7: Admin API rate limiter (per admin actor).
// Limit: 60 / 60s / admin user. Admin API routes all go through
// requireAdminWrite, which checks this limiter using the admin's
// user.id as the key (NOT IP-based — admin sessions are already
// authenticated, so per-user is more precise than per-IP).
//
// This protects against:
//   - Brute-force scanning of admin endpoints (even with valid session)
//   - Runaway admin scripts (e.g. infinite loop in a batch operation)
//   - Accidental DoS from misbehaving admin UI components
//
// The limit is generous (1 req/sec sustained) to not impede normal
// CMS workflows (editing, searching, paginating) while bounding abuse.
//
// Multi-instance caveat applies (see MemoryRateLimiter header).
let adminApiLimiter: RateLimiter | null = null;

export function getAdminApiRateLimiter(): RateLimiter {
  if (!adminApiLimiter) adminApiLimiter = new MemoryRateLimiter(60, 60 * 1000);
  return adminApiLimiter;
}

// ============================================================
// Phase 8: Global fallback rate-limit bucket
// ------------------------------------------------------------
// Hard constraint: "Rate limiting must enforce global fallback bucket
// for unknown clients, with HMAC Secret configuration not bypassing
// global bucket".
//
// The per-key limiters above (per-IP, per-admin-user) are insufficient
// when an attacker can forge or rotate keys. The global bucket is a
// SINGLE shared counter that caps the total throughput of ALL clients
// combined, regardless of how many distinct keys they present. It is
// the security floor: no attacker can bypass it by rotating headers.
//
// `requireAdminWrite` checks the global bucket FIRST (before the
// per-admin bucket), so a flood of admin requests is capped at the
// global level even before per-user accounting kicks in. Public
// endpoints (inquiries, analytics, etc.) that use `ephemeralRateKeySet`
// already get a `fallback:global` key via `http-security.ts`; this
// limiter provides the matching in-memory counter for admin endpoints
// which authenticate by session cookie rather than IP.
//
// Limit: 1000 / 60s global. Generous enough for legitimate admin
// traffic across all admin users, while bounding a compromised or
// runaway admin client. Multi-instance caveat applies (see
// MemoryRateLimiter header) — EdgeOne WAF provides the cross-instance
// floor in production.
// ============================================================
let globalLimiter: RateLimiter | null = null;

export function getGlobalRateLimiter(): RateLimiter {
  if (!globalLimiter) globalLimiter = new MemoryRateLimiter(1000, 60 * 1000);
  return globalLimiter;
}

/**
 * Phase 8: Inquiry export rate limiter (per admin actor).
 *
 * Limit: 5 exports / 60s / admin user. CSV export loops in batches of
 * 500 rows up to MAX_EXPORT_ROWS (10000), so each export is up to 20
 * DB queries. Without a dedicated limiter, a malicious admin could
 * hammer the endpoint and starve the database. The shared admin API
 * limiter (60/min) is too generous for this heavy operation.
 *
 * Multi-instance caveat applies (see MemoryRateLimiter header).
 */
let inquiryExportLimiter: RateLimiter | null = null;

export function getInquiryExportRateLimiter(): RateLimiter {
  if (!inquiryExportLimiter)
    inquiryExportLimiter = new MemoryRateLimiter(5, 60 * 1000);
  return inquiryExportLimiter;
}

// ============================================================
// KZQ-P1-010: Pre-auth coarse rate limiting for admin endpoints
// ------------------------------------------------------------
// requireAdminWrite() and requireAdminRead() historically called
// getVerifiedAdmin() (which performs a REMOTE auth.getUser() call +
// a DB profile query) BEFORE any rate limiting. An unauthenticated
// attacker could send unlimited requests to /api/admin/* endpoints,
// each triggering expensive remote Supabase Auth calls, without
// consuming any rate-limit quota.
//
// This limiter is checked BEFORE getVerifiedAdmin() in both
// requireAdminWrite and requireAdminRead. It uses the two-layer
// ephemeralRateKeySet model:
//   - Trusted IP available (EdgeOne TRUSTED_PROXY_HEADER configured):
//     per-IP bucket "ip:<addr>" — each IP gets its own 30-req budget.
//   - No trusted IP: "fallback:global" floor (all unknown-IP clients
//     share a single 30-req budget) + optional "fallback:<hmac>"
//     sub-bucket when RATE_LIMIT_FALLBACK_SECRET is set.
//
// Limit: 30 / 60s per key. This is:
//   - Generous enough for legitimate admin users whose session expired
//     (they send 1-2 unauthenticated requests before being redirected
//     to login).
//   - Strict enough to block brute-force/probing/flood attacks against
//     admin endpoints.
//   - Lower than the post-auth per-admin limit (60/60s) so the pre-auth
//     layer is the more restrictive floor for unauthenticated traffic.
//
// This limiter is a SEPARATE MemoryRateLimiter instance from the
// post-auth global/per-admin limiters — its key map is independent,
// so pre-auth and post-auth buckets do not interfere. The post-auth
// limiters (getGlobalRateLimiter + getAdminApiRateLimiter) continue
// to run after successful authentication, unchanged.
//
// Multi-instance caveat applies (see MemoryRateLimiter header).
// EdgeOne WAF provides the cross-instance floor in production.
// ============================================================
let adminPreAuthLimiter: RateLimiter | null = null;

export function getAdminPreAuthRateLimiter(): RateLimiter {
  if (!adminPreAuthLimiter)
    adminPreAuthLimiter = new MemoryRateLimiter(30, 60 * 1000);
  return adminPreAuthLimiter;
}

// ============================================================
// KZQ-P1-021: Admin login brute-force protection
// ------------------------------------------------------------
// The admin login form calls `supabase.auth.signInWithPassword`
// directly from the browser — the Auth API request does NOT pass
// through the application server. This dedicated limiter backs the
// server-side login guard endpoint (/api/admin/login-guard) which the
// form calls BEFORE attempting sign-in. Counting and the over-limit
// decision happen entirely on the server (never client-side counters).
//
// Limits:
//   - 5 attempts / 60s per key. With `checkRateLimitKeys` the key is
//     the trusted client IP (`ip:<addr>`) when available, otherwise
//     the shared `fallback:global` floor + optional HMAC sub-bucket.
//     Legitimate admins type credentials far slower than 5/min; a
//     scripted brute force is blocked after 5 attempts.
//
// Boundary (documented in docs/EDGEONE_WAF_RULES.md §2.12):
//   The guard only gates the application login flow. A client that
//   bypasses the form and calls Supabase Auth directly is NOT stopped
//   here — the real floor for that path is (a) Supabase Auth's built-in
//   login rate limiting (Auth dashboard, per-IP + per-email) and (b)
//   an EdgeOne WAF rule on the guard endpoint. The guard is the
//   application-layer defense for the normal flow and for scripted
//   browser automation that executes the page's own login JS.
//
// Multi-instance caveat applies (see MemoryRateLimiter header).
// ============================================================
let loginLimiter: RateLimiter | null = null;

export function getLoginRateLimiter(): RateLimiter {
  if (!loginLimiter) loginLimiter = new MemoryRateLimiter(5, 60 * 1000);
  return loginLimiter;
}
