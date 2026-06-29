"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { useState, useEffect } from "react";

export function SearchBox() {
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
