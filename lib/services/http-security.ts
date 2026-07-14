import { isIP } from "node:net";
import type { NextRequest } from "next/server";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const IP_HEADERS = [
  "cf-connecting-ip",
  "eo-connecting-ip",
  "x-edgeone-client-ip",
  "x-real-ip",
] as const;

function validIp(value: string | null): string | null {
  const candidate = value?.trim();
  return candidate && isIP(candidate) ? candidate : null;
}

export function getClientIp(
  request: Pick<NextRequest, "headers">,
): string | null {
  for (const header of IP_HEADERS) {
    const candidate = validIp(request.headers.get(header));
    if (candidate) return candidate;
  }
  return validIp(request.headers.get("x-forwarded-for")?.split(",")[0] || null);
}

export function ephemeralRateKey(
  request: Pick<NextRequest, "headers">,
  randomId: () => string = () => crypto.randomUUID(),
): string {
  return getClientIp(request) || `unknown:${randomId()}`;
}

export function isJsonRequest(request: Pick<NextRequest, "headers">): boolean {
  return (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase() === "application/json"
  );
}

export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host =
    request.headers.get("x-forwarded-host") || request.headers.get("host");
  const protocol =
    request.headers.get("x-forwarded-proto") ||
    request.nextUrl.protocol.replace(":", "");
  if (!host) return false;
  try {
    return new URL(origin).origin === `${protocol}://${host}`;
  } catch {
    return false;
  }
}

export async function readJsonBody<T>(
  request: NextRequest,
  maximumBytes: number,
): Promise<{ ok: true; value: T } | { ok: false; status: 400 | 413 | 415 }> {
  if (!isJsonRequest(request)) return { ok: false, status: 415 };
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    return { ok: false, status: 413 };
  }
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
      return { ok: false, status: 413 };
    }
    return { ok: true, value: JSON.parse(raw) as T };
  } catch {
    return { ok: false, status: 400 };
  }
}
