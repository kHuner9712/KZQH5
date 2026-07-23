import { NextResponse } from "next/server";
import packageJson from "@/package.json";
import { isDemoMode } from "@/lib/demo";
import { isIndexingEnabled } from "@/lib/site-indexing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function commitSha(): string {
  const value =
    process.env.EDGEONE_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GITHUB_SHA ||
    "unknown";
  return /^[a-zA-Z0-9._-]{1,64}$/.test(value) ? value : "unknown";
}

export function GET() {
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
