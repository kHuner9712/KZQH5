import { NextResponse } from "next/server";
import { getFeaturedProjects } from "@/lib/repositories/projects";

export async function GET() {
  try {
    const projects = await getFeaturedProjects(3);
    return NextResponse.json({ projects }, { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } });
  } catch (error) {
    console.error("Featured projects query failed:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ projects: [], error: "Unable to load projects" }, { status: 500 });
  }
}
