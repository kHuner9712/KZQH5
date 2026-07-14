import { getProjectMetadata, ProjectDetailPageContent } from "@/components/public/pages/ProjectDetailPage";
export const revalidate = 300;
export function generateMetadata({ params }: { params: { slug: string } }) { return getProjectMetadata("en", params.slug); }
export default function ProjectPage({ params }: { params: { slug: string } }) { return ProjectDetailPageContent("en", params.slug); }
