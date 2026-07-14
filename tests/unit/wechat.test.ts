import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setWechatCacheProvider,
  type WechatCache,
} from "@/lib/services/wechat/cache";
import { createWechatJsSdkConfig } from "@/lib/services/wechat/jssdk";

function memoryCache(): WechatCache {
  const values = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return (values.get(key) as T | undefined) ?? null;
    },
    async set<T>(key: string, value: T) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("WeChat JS-SDK adapter", () => {
  beforeEach(() => {
    vi.stubEnv("WECHAT_APP_ID", "app-id");
    vi.stubEnv("WECHAT_APP_SECRET", "app-secret");
    setWechatCacheProvider(memoryCache());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns null when credentials are not configured", async () => {
    vi.stubEnv("WECHAT_APP_SECRET", "");
    expect(await createWechatJsSdkConfig("https://kzq.test/")).toBeNull();
  });

  it("fetches, caches and signs successfully", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ access_token: "token", expires_in: 7200 }),
      )
      .mockResolvedValueOnce(response({ ticket: "ticket", expires_in: 7200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await createWechatJsSdkConfig("https://kzq.test/#fragment"),
    ).toMatchObject({ appId: "app-id" });
    expect(await createWechatJsSdkConfig("https://kzq.test/")).toMatchObject({
      appId: "app-id",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent token and ticket requests", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return String(url).includes("getticket")
        ? response({ ticket: "ticket", expires_in: 7200 })
        : response({ access_token: "token", expires_in: 7200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all([
      createWechatJsSdkConfig("https://kzq.test/a"),
      createWechatJsSdkConfig("https://kzq.test/b"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes an expired token once", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ access_token: "old", expires_in: 7200 }),
      )
      .mockResolvedValueOnce(
        response({ errcode: 40001, errmsg: "invalid credential" }),
      )
      .mockResolvedValueOnce(
        response({ access_token: "new", expires_in: 7200 }),
      )
      .mockResolvedValueOnce(response({ ticket: "ticket", expires_in: 7200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await createWechatJsSdkConfig("https://kzq.test/")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([400, 500])("rejects HTTP %s", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(response({}, status)),
    );
    await expect(createWechatJsSdkConfig("https://kzq.test/")).rejects.toThrow(
      `WeChat HTTP ${status}`,
    );
  });

  it("rejects non-JSON responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("OK")),
    );
    await expect(createWechatJsSdkConfig("https://kzq.test/")).rejects.toThrow(
      "non-JSON",
    );
  });

  it("aborts a timed-out request", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const configPromise = createWechatJsSdkConfig("https://kzq.test/");
    const expectation = expect(configPromise).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(8000);
    await expectation;
    vi.useRealTimers();
  });
});
