import { NotFoundContent } from "@/components/public/UtilityPages";
import type { Metadata } from "next";
export const metadata: Metadata = { robots: { index: false, follow: false } };
export default function EnglishNotFound() {
  return <NotFoundContent locale="en" />;
}
