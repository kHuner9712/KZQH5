// ============================================================
// CSP Violation Report Endpoint — /api/csp-report
//
// Work Package G: receives Content-Security-Policy-Report-Only
// violation reports submitted by the browser via `report-uri` /
// `Report-To` (or directly to this endpoint when listed as
// `report-to` in the CSP policy).
//
// Security contract:
//   - Accepts ONLY application/reports+json OR application/json
//     (CSP reports are typically sent as `application/reports+json`
//     when triggered by the Reporting API, and as
//     `application/json` when triggered by the legacy `report-uri`
//     directive).
//   - Body size capped at 8 KB — anything larger is dropped.
//     Browsers send one report per violation; 8 KB is generous for
//     a single CSP report.
//   - The endpoint accepts reports from any origin (CSP reports are
//       sent by the browser automatically and cannot be CSRF-protected
//       in the usual way). It is rate-limited per IP to prevent
//       log-flooding.
//   - Sanitization: only the `violated-directive` and a coarse
//     `document-uri` (path only, no query string) are extracted.
//     The full report body is NEVER persisted verbatim — it may
//     contain the blocked URL's query string which could include
//     tokens, PII, or query parameters that the user agent sent.
//   - Returns 204 No Content on success, 413 on body-too-large,
//     415 on wrong Content-Type, 429 on rate-limit, 400 on parse
//     error. The browser ignores the response body for CSP reports.
//
// The collected reports are emitted to server logs with a fixed
// coarse code (CSP_VIOLATION_REPORT) so operators can grep for them.
// Detailed analysis should be done via a dedicated CSP reporting
// service (e.g. Sentry, report-uri.io) in production.
// ============================================================

import { NextResponse, type NextRequest } from "next/server";
import { checkRateLimitKeys } from "@/lib/services/http-security";
import { getAnalyticsRateLimiter } from "@/lib/services/rate-limit";
import { logServerError } from "@/lib/logging/server-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;
const ACCEPTED_CONTENT_TYPES = new Set([
  "application/json",
  "application/reports+json",
  "application/csp-report",
]);

interface CspReportEntry {
  // CSP spec uses kebab-case property names. We accept both kebab-case
  // (spec-compliant) and camelCase (some libraries normalize) for
  // forward-compatibility.
  "violated-directive"?: string;
  "effective-directive"?: string;
  "blocked-uri"?: string;
  "document-uri"?: string;
  "referrer"?: string;
  "source-file"?: string;
  "line-number"?: number;
  "column-number"?: number;
  "status-code"?: number;
  "script-sample"?: string;
  // camelCase aliases (Reporting API / some libraries normalize to these)
  violatedDirective?: string;
  effectiveDirective?: string;
  // Reporting API uses *URL (not *URI) suffix:
  blockedURL?: string;
  documentURL?: string;
  // Some libraries use *URI suffix:
  blockedURI?: string;
  documentURI?: string;
  sourceFile?: string;
  lineNumber?: number;
  columnNumber?: number;
  statusCode?: number;
  scriptSample?: string;
}

interface CspReportPayload {
  "csp-report"?: CspReportEntry;
  // Reporting API array shape
  type?: string;
  body?: CspReportEntry;
}

/**
 * Strip a URL to its origin + path, dropping the query string and
 * fragment. This prevents tokens / PII sent as query parameters
 * from being persisted in CSP violation logs.
 */
function sanitizeUrl(raw: string | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    // Strip the query and hash — they may contain tokens or PII.
    return `${url.origin}${url.pathname}`;
  } catch {
    // Not a URL — return null. We don't log non-URL strings because
    // they could be anything (including user-supplied PII).
    return null;
  }
}

function extractSanitizedReport(payload: unknown): {
  violatedDirective: string | null;
  documentUri: string | null;
  blockedUri: string | null;
} | null {
  if (!payload || typeof payload !== "object") return null;

  // Reporting API sends an array of reports; legacy report-uri sends
  // a single object with a `csp-report` key. Handle both shapes.
  const maybeArray = payload as
    | CspReportPayload
    | CspReportPayload[]
    | { type: string; body: CspReportEntry }[];

  let reportObject: CspReportPayload | undefined;
  if (Array.isArray(maybeArray)) {
    if (maybeArray.length === 0) return null;
    const first = maybeArray[0] as CspReportPayload & {
      type?: string;
      body?: CspReportEntry;
    };
    // Reporting API shape: { type: "csp-violation", body: { ... } }
    if (first.body && typeof first.body === "object") {
      reportObject = { "csp-report": first.body };
    } else {
      reportObject = first;
    }
  } else {
    reportObject = maybeArray;
  }

  const cspReport = reportObject?.["csp-report"];
  if (!cspReport) return null;

  // Read both kebab-case (spec) and camelCase (normalized) variants.
  // Also handle Reporting API's *URL suffix (vs legacy *URI suffix).
  const rawDirective =
    cspReport["violated-directive"] ?? cspReport.violatedDirective;
  const violatedDirective =
    typeof rawDirective === "string" ? rawDirective.slice(0, 128) : null;

  const rawDocUri =
    cspReport["document-uri"] ??
    cspReport.documentURL ??
    cspReport.documentURI;
  const documentUri = sanitizeUrl(rawDocUri);

  const rawBlockedUri =
    cspReport["blocked-uri"] ??
    cspReport.blockedURL ??
    cspReport.blockedURI;
  const blockedUri = sanitizeUrl(rawBlockedUri);

  return { violatedDirective, documentUri, blockedUri };
}

export async function POST(request: NextRequest) {
  // --- Rate limit: re-use the analytics limiter (60 / 60s / IP) ---
  // CSP reports are sent automatically by the browser; a malicious
  // page could trigger thousands of violations to flood logs. The
  // limiter prevents log-flooding from a single source. Two-layer
  // model: global floor (unknown-IP) + optional HMAC sub-bucket.
  const limiter = getAnalyticsRateLimiter();
  const { allowed, retryAfterSeconds } = await checkRateLimitKeys(request, limiter);
  if (!allowed) {
    return new NextResponse(null, {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSeconds),
        "Cache-Control": "no-store",
      },
    });
  }

  // --- Content-Type validation ---
  const contentType = (request.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!ACCEPTED_CONTENT_TYPES.has(contentType)) {
    return new NextResponse(null, {
      status: 415,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // --- Content-Length pre-check ---
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return new NextResponse(null, {
      status: 413,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // --- Read body with hard byte cap ---
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return new NextResponse(null, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return new NextResponse(null, {
      status: 413,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // --- Parse JSON (fail closed on parse error) ---
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new NextResponse(null, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // --- Extract & sanitize ---
  const sanitized = extractSanitizedReport(payload);
  if (sanitized) {
    // Emit only fixed coarse code + sanitized fields to server logs.
    // NEVER log the full report body — it may contain tokens, PII,
    // or query-string secrets from the blocked URL.
    //
    // The violated directive becomes the processing stage (e.g. "img-src",
    // "script-src-elem") so operators can filter CSP reports by directive.
    // The document-uri (already stripped of query string) goes into the
    // detail field, where it is further sanitized by logServerError to
    // strip any residual PII.
    logServerError(
      "CSP_VIOLATION_REPORT",
      sanitized.violatedDirective || "unknown",
      "unknown",
      sanitized.documentUri || "",
    );
  }

  // Browsers ignore the response body for CSP reports; 204 is the
  // standard "report received, no content to return" status.
  return new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET() {
  // CSP reports MUST be POST. A GET is typically a probe from a
  // security scanner or curious user; respond with 204 to avoid
  // leaking information about the endpoint's existence.
  return new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
