// ============================================================
// Rate limiting — global interface + in-memory fallback
// ------------------------------------------------------------
// The RateLimiter interface is the single replacement point for any
// production-grade implementation (PostgreSQL atomic RPC, KV, Redis).
// The in-memory implementation here is intended ONLY as a low-cost
// first layer and as a development/test fallback.
//
// ⚠️ Multi-instance boundary:
// - MemoryRateLimiter is consistent only within a single Node process.
//   On EdgeOne multi-instance deployments the effective limit may be
//   N × configured (N = running instances).
// - Production deployments MUST additionally enable EdgeOne WAF /
//   Rate Limiting rules. This is documented in
//   docs/LAUNCH_CHECKLIST.md and docs/CODE_FINALIZATION_REPORT.md.
// - For strong global consistency, replace the factory functions
//   below with a PostgreSQL / KV / Redis-backed implementation. The
//   call sites do not need to change.
// ============================================================

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string): Promise<RateLimitResult>;
}

interface MemoryEntry {
  count: number;
  firstRequestAt: number;
  // Linked-list pointers for LRU-ish eviction when capacity is reached.
  // We keep a doubly-linked list of entries in insertion order so that
  // when the map is full we can evict the OLDEST still-live entry in O(1)
  // instead of scanning the entire map.
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
  // Head = most recently inserted/touched, Tail = oldest.
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

    // New key. Enforce capacity BEFORE inserting to avoid unbounded growth.
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
