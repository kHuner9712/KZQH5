import { createHash, randomBytes } from "crypto";
import { getWechatCache } from "./cache";

interface WechatAccessTokenResponse {
  access_token?: string;
  expires_in?: number;
  errcode?: number;
  errmsg?: string;
}

interface WechatTicketResponse {
  ticket?: string;
  expires_in?: number;
  errcode?: number;
  errmsg?: string;
}

export interface WechatJsSdkConfig {
  appId: string;
  timestamp: number;
  nonceStr: string;
  signature: string;
}

export function isWechatConfigured(): boolean {
  return Boolean(process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET);
}

async function fetchWechatJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`WeChat HTTP ${response.status}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error("WeChat returned a non-JSON response");
    }
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken(appId: string, appSecret: string): Promise<string> {
  const cache = getWechatCache();
  const cacheKey = `wechat:access-token:${appId}`;
  const cached = await cache.get<string>(cacheKey);
  if (cached) return cached;
  const response = await fetchWechatJson<WechatAccessTokenResponse>(
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`
  );
  if (!response.access_token || response.errcode) {
    throw new Error(`WeChat access token failed (${response.errcode || "unknown"})`);
  }
  await cache.set(cacheKey, response.access_token, Math.max(60, (response.expires_in || 7200) - 300));
  return response.access_token;
}

async function getJsApiTicket(appId: string, accessToken: string): Promise<string> {
  const cache = getWechatCache();
  const cacheKey = `wechat:jsapi-ticket:${appId}`;
  const cached = await cache.get<string>(cacheKey);
  if (cached) return cached;
  const response = await fetchWechatJson<WechatTicketResponse>(
    `https://api.weixin.qq.com/cgi-bin/ticket/getticket?access_token=${encodeURIComponent(accessToken)}&type=jsapi`
  );
  if (!response.ticket || response.errcode) {
    throw new Error(`WeChat JSAPI ticket failed (${response.errcode || "unknown"})`);
  }
  await cache.set(cacheKey, response.ticket, Math.max(60, (response.expires_in || 7200) - 300));
  return response.ticket;
}

export async function createWechatJsSdkConfig(url: string): Promise<WechatJsSdkConfig | null> {
  const appId = process.env.WECHAT_APP_ID;
  const appSecret = process.env.WECHAT_APP_SECRET;
  if (!appId || !appSecret) return null;
  const accessToken = await getAccessToken(appId, appSecret);
  const ticket = await getJsApiTicket(appId, accessToken);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonceStr = randomBytes(16).toString("hex");
  const signatureSource = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url.split("#")[0]}`;
  const signature = createHash("sha1").update(signatureSource).digest("hex");
  return { appId, timestamp, nonceStr, signature };
}
