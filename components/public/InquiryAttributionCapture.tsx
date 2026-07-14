"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { captureInquiryAttribution } from "@/lib/client/inquiry-attribution";

export function InquiryAttributionCapture() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();

  useEffect(() => {
    captureInquiryAttribution();
  }, [pathname, query]);

  return null;
}
