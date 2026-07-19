import { DocumentsPageContent, getDocumentsMetadata } from "@/components/public/pages/DocumentsPage";

export const revalidate = 300;

export function generateMetadata() {
  return getDocumentsMetadata("en");
}

export default function EnglishDocumentsPage() {
  return DocumentsPageContent("en");
}
