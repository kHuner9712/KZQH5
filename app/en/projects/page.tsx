import { getProjectsMetadata, ProjectsPageContent } from "@/components/public/pages/ProjectsPage";
import { renderPublicPage } from "@/components/public/PublicDataUnavailable";
export const revalidate = 300;
export function generateMetadata() { return getProjectsMetadata("en"); }
export default function ProjectsPage() { return renderPublicPage("en", "/en/projects", () => ProjectsPageContent("en")); }
