import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { runStagingDiagnostics } from "@/lib/services/staging-diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: NextRequest, expected: string): boolean {
  const authorization = request.headers.get("authorization") || "";
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) return false;
  const supplied = authorization.slice(prefix.length);
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return (
    suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

export async function GET(request: NextRequest) {
  if (process.env.STAGING_DIAGNOSTICS_ENABLED !== "true") {
    return new NextResponse(null, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const token = process.env.STAGING_DIAGNOSTICS_TOKEN;
  if (!token || !authorized(request, token)) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      {
        status: 401,
        headers: {
          "Cache-Control": "no-store",
          "WWW-Authenticate": "Bearer",
        },
      },
    );
  }

  const diagnostics = await runStagingDiagnostics();
  return NextResponse.json(diagnostics, {
    headers: { "Cache-Control": "no-store" },
  });
}
