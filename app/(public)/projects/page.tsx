import { getProjectsMetadata, ProjectsPageContent } from "@/components/public/pages/ProjectsPage";
import { renderPublicPage } from "@/components/public/PublicDataUnavailable";
export const revalidate = 300;
export function generateMetadata() { return getProjectsMetadata("zh"); }
export default function ProjectsPage() { return renderPublicPage("zh", "/projects", () => ProjectsPageContent("zh")); }
