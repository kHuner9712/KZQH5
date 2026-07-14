import { describe, expect, it } from "vitest";
import { ephemeralRateKey } from "@/lib/services/http-security";
import { MemoryRateLimiter } from "@/lib/services/rate-limit";

describe("memory rate limiter", () => {
  it("allows requests in the window and rejects over-limit requests", async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(2, 1000, () => now);
    expect((await limiter.check("client")).allowed).toBe(true);
    expect((await limiter.check("client")).allowed).toBe(true);
    expect((await limiter.check("client")).allowed).toBe(false);
    now = 1000;
    expect((await limiter.check("client")).allowed).toBe(true);
  });

  it("cleans expired records", async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(2, 1000, () => now);
    await limiter.check("old");
    now = 1001;
    await limiter.check("new");
    expect(limiter.entryCount()).toBe(1);
  });

  it("does not put all unknown-IP clients in one shared bucket", () => {
    const headers = new Headers();
    const first = ephemeralRateKey({ headers }, () => "one");
    const second = ephemeralRateKey({ headers }, () => "two");
    expect(first).toBe("unknown:one");
    expect(second).toBe("unknown:two");
  });
});
