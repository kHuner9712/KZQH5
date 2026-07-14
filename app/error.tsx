"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-6 text-center" role="alert">
      <div>
        <h1 className="text-xl font-semibold text-ink">页面暂时不可用 / Page temporarily unavailable</h1>
        <p className="mt-3 text-sm leading-6 text-ink-mute">请检查网络后重试。已加载内容不会受到影响。<br />Check your connection and try again. Loaded content remains available.</p>
        <div className="mt-6 flex flex-wrap justify-center gap-3"><button type="button" onClick={reset} className="btn-primary h-11 px-5">重试 / Retry</button><Link href="/" className="btn-outline h-11 px-5">首页 / Home</Link><Link href="/products" className="btn-outline h-11 px-5">产品 / Products</Link></div>
      </div>
    </main>
  );
}
