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
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly entries = new Map<string, MemoryEntry>();

  constructor(
    private readonly maximum: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async check(key: string): Promise<RateLimitResult> {
    const now = this.now();
    for (const [storedKey, entry] of this.entries) {
      if (now - entry.firstRequestAt >= this.windowMs)
        this.entries.delete(storedKey);
    }

    const entry = this.entries.get(key);
    if (!entry) {
      this.entries.set(key, { count: 1, firstRequestAt: now });
      return {
        allowed: true,
        remaining: Math.max(0, this.maximum - 1),
        retryAfterSeconds: Math.ceil(this.windowMs / 1000),
      };
    }

    entry.count += 1;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((this.windowMs - (now - entry.firstRequestAt)) / 1000),
    );
    return {
      allowed: entry.count <= this.maximum,
      remaining: Math.max(0, this.maximum - entry.count),
      retryAfterSeconds,
    };
  }

  entryCount(): number {
    return this.entries.size;
  }
}

// 数据访问边界：未来接入 KV / Redis 时，只需替换该工厂返回的实现。
// 当前内存实现适用于无持久 KV 的部署，并作为可靠 fallback。
let inquiryLimiter: RateLimiter | null = null;
let analyticsLimiter: RateLimiter | null = null;

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
