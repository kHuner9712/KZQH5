import { NextResponse, type NextRequest } from "next/server";
import { getFeaturedProjects } from "@/lib/repositories/projects";
import { getFeaturedProjectsRateLimiter } from "@/lib/services/rate-limit";
import { checkRateLimitKeys } from "@/lib/services/http-security";

export async function GET(request: NextRequest) {
  const rate = await checkRateLimitKeys(
    request,
    getFeaturedProjectsRateLimiter(),
  );
  if (!rate.allowed) {
    return new NextResponse(null, {
      status: 429,
      headers: {
        "Retry-After": String(rate.retryAfterSeconds),
        "Cache-Control": "no-store",
      },
    });
  }

  try {
    const projects = await getFeaturedProjects(3);
    return NextResponse.json(
      { projects },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        },
      },
    );
  } catch (error) {
    console.error(
      "Featured projects query failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return NextResponse.json(
      { projects: [], error: "Unable to load projects" },
      { status: 500 },
    );
  }
}
