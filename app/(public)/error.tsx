"use client";
import { PublicError } from "@/components/public/PublicError";
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) { return <PublicError locale="zh" error={error} reset={reset} />; }
