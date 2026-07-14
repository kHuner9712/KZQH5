export interface WechatCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
}

interface MemoryValue {
  value: unknown;
  expiresAt: number;
}

class MemoryWechatCache implements WechatCache {
  private readonly values = new Map<string, MemoryValue>();

  async get<T>(key: string): Promise<T | null> {
    const cached = this.values.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return cached.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.values.set(key, {
      value,
      expiresAt: Date.now() + Math.max(1, ttlSeconds) * 1000,
    });
  }
}

// 未来迁移 KV/Redis 时替换此 provider 即可，调用方不依赖具体缓存产品。
let cache: WechatCache | null = null;

export function getWechatCache(): WechatCache {
  if (!cache) cache = new MemoryWechatCache();
  return cache;
}

export function setWechatCacheProvider(provider: WechatCache): void {
  cache = provider;
}
