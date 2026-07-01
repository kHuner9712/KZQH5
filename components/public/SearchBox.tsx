"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { useState, useEffect } from "react";

function SearchBoxInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialQ = searchParams.get("q") || "";
  const [q, setQ] = useState(initialQ);

  useEffect(() => {
    setQ(searchParams.get("q") || "");
  }, [searchParams]);

  function submit(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value.trim()) {
      params.set("q", value.trim());
    } else {
      params.delete("q");
    }
    router.push(`/products?${params.toString()}`);
  }

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-mute" />
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit(q);
        }}
        placeholder="搜索产品名称、规格…"
        className="h-11 w-full rounded-xl border border-ink-line bg-white pl-10 pr-10 text-sm text-ink outline-none transition placeholder:text-ink-mute focus:border-industrial focus:ring-2 focus:ring-industrial/15"
      />
      {q && (
        <button
          onClick={() => {
            setQ("");
            submit("");
          }}
          className="absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-mute hover:text-ink"
          aria-label="清除"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export function SearchBox() {
  return (
    <Suspense fallback={<SearchBoxFallback />}>
      <SearchBoxInner />
    </Suspense>
  );
}

function SearchBoxFallback() {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-mute" />
      <input
        type="text"
        disabled
        placeholder="搜索产品名称、规格…"
        className="h-11 w-full rounded-xl border border-ink-line bg-white pl-10 pr-10 text-sm outline-none transition"
      />
    </div>
  );
}
