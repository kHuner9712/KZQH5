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
