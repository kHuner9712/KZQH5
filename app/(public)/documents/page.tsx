import { DocumentsPageContent, getDocumentsMetadata } from "@/components/public/pages/DocumentsPage";

export const revalidate = 300;

export function generateMetadata() {
  return getDocumentsMetadata("zh");
}

export default function DocumentsPage() {
  return DocumentsPageContent("zh");
}
