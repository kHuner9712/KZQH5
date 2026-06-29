"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { useState, useEffect } from "react";

// 内部实际使用 useSearchParams 的客户端组件
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
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit(q);
        }}
        placeholder="搜索产品名称、规格…"
        className="h-10 w-full rounded-full border border-gray-200 bg-white pl-9 pr-9 text-sm outline-none transition focus:border-steel focus:ring-2 focus:ring-steel/20"
      />
      {q && (
        <button
          onClick={() => {
            setQ("");
            submit("");
          }}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          aria-label="清除"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

// 默认导出用 Suspense 包裹，避免 Next.js 生产构建时报
// "useSearchParams() should be wrapped in a suspense boundary"
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
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
      <input
        type="text"
        disabled
        placeholder="搜索产品名称、规格…"
        className="h-10 w-full rounded-full border border-gray-200 bg-white pl-9 pr-9 text-sm outline-none transition"
      />
    </div>
  );
}
