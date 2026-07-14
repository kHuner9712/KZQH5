import { CertificatesPageContent, getCertificatesMetadata } from "@/components/public/pages/CertificatesPage";
import { renderPublicPage } from "@/components/public/PublicDataUnavailable";
export const revalidate = 300;
export function generateMetadata() { return getCertificatesMetadata("en"); }
export default function EnglishCertificatesPage() { return renderPublicPage("en", "/en/certificates", () => CertificatesPageContent("en")); }
