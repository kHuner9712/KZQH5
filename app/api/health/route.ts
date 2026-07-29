import { NextResponse, type NextRequest } from "next/server";
import packageJson from "@/package.json";
import { isDemoMode } from "@/lib/demo";
import { isIndexingEnabled } from "@/lib/site-indexing";
import { getHealthRateLimiter } from "@/lib/services/rate-limit";
import { checkRateLimitKeys } from "@/lib/services/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function commitSha(): string {
  const value =
    process.env.EDGEONE_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT_SHA ||
    process.env.GITHUB_SHA ||
    "unknown";
  return /^[a-zA-Z0-9._-]{1,64}$/.test(value) ? value : "unknown";
}

export async function GET(request: NextRequest) {
  const rate = await checkRateLimitKeys(request, getHealthRateLimiter());
  if (!rate.allowed) {
    return new NextResponse(null, {
      status: 429,
      headers: {
        "Retry-After": String(rate.retryAfterSeconds),
        "Cache-Control": "no-store",
      },
    });
  }

  return NextResponse.json(
    {
      success: true,
      app: packageJson.name,
      version: packageJson.version,
      commit: commitSha(),
      demo: isDemoMode(),
      // Boolean only — never expose the raw env value or any other detail.
      indexingEnabled: isIndexingEnabled(),
      dataProvider: "supabase",
      runtime: "nodejs",
      timestamp: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
