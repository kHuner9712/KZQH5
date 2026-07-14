"use client";
import { PublicError } from "@/components/public/PublicError";
export default function EnglishErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) { return <PublicError locale="en" error={error} reset={reset} />; }
