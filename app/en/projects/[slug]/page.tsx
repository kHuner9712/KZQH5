import { getProjectMetadata, ProjectDetailPageContent } from "@/components/public/pages/ProjectDetailPage";
export const revalidate = 300;
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return getProjectMetadata("en", slug);
}
export default async function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return ProjectDetailPageContent("en", slug);
}
