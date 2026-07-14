"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { InquiryListItemInput } from "@/types/database";

const STORAGE_KEY = "kzq.inquiry-list.v1";
const MAX_ITEMS = 30;

interface InquiryListContextValue {
  items: InquiryListItemInput[];
  count: number;
  loaded: boolean;
  add: (item: InquiryListItemInput) => boolean;
  remove: (productId: string) => void;
  updateQuantity: (productId: string, quantity: string) => void;
  clear: () => void;
}

const InquiryListContext = createContext<InquiryListContextValue | null>(null);

function cleanItem(value: unknown): InquiryListItemInput | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.product_id !== "string" || typeof item.slug !== "string" || typeof item.name_cn !== "string") return null;
  return {
    product_id: item.product_id.slice(0, 80),
    slug: item.slug.slice(0, 200),
    name_cn: item.name_cn.slice(0, 300),
    name_en: typeof item.name_en === "string" ? item.name_en.slice(0, 300) : null,
    cover_image_url: typeof item.cover_image_url === "string" ? item.cover_image_url.slice(0, 1000) : null,
    quantity: typeof item.quantity === "string" ? item.quantity.slice(0, 100) : "",
  };
}

function readStoredItems(): InquiryListItemInput[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    const result: InquiryListItemInput[] = [];
    parsed.slice(0, MAX_ITEMS).forEach((value) => {
      const item = cleanItem(value);
      if (item && !result.some((existing) => existing.product_id === item.product_id)) result.push(item);
    });
    return result;
  } catch {
    return [];
  }
}

export function InquiryListProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<InquiryListItemInput[]>([]);
  const [loaded, setLoaded] = useState(false);
  const refreshedIds = useRef("");

  useEffect(() => {
    setItems(readStoredItems());
    setLoaded(true);
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setItems(readStoredItems());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      // 隐私模式、存储被禁用或配额不足时，清单仍在当前页面内可用。
    }
  }, [items, loaded]);

  useEffect(() => {
    if (!loaded || !items.length) return;
    const idsKey = items.map((item) => item.product_id).sort().join(",");
    if (refreshedIds.current === idsKey) return;
    refreshedIds.current = idsKey;
    const controller = new AbortController();
    fetch("/api/products/selection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: items.map((item) => item.product_id) }),
      signal: controller.signal,
    })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (!Array.isArray(data?.items)) return;
        const latest = new Map<string, Record<string, unknown>>(data.items.map((item: Record<string, unknown>) => [String(item.id), item]));
        setItems((current) => current.flatMap((item) => {
          const product = latest.get(item.product_id);
          if (!product) return [];
          return [{
            ...item,
            slug: String(product.slug || item.slug),
            name_cn: String(product.name_cn || item.name_cn),
            name_en: typeof product.name_en === "string" ? product.name_en : null,
            cover_image_url: typeof product.cover_image_url === "string" ? product.cover_image_url : null,
          }];
        }));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [items, loaded]);

  const add = useCallback((item: InquiryListItemInput) => {
    let added = false;
    setItems((current) => {
      const index = current.findIndex((existing) => existing.product_id === item.product_id);
      if (index >= 0) {
        return current.map((existing, itemIndex) => itemIndex === index
          ? { ...existing, ...item, quantity: existing.quantity }
          : existing);
      }
      if (current.length >= MAX_ITEMS) return current;
      added = true;
      return [...current, item];
    });
    return added;
  }, []);

  const value = useMemo<InquiryListContextValue>(() => ({
    items,
    count: items.length,
    loaded,
    add,
    remove: (productId) => setItems((current) => current.filter((item) => item.product_id !== productId)),
    updateQuantity: (productId, quantity) => setItems((current) => current.map((item) => item.product_id === productId ? { ...item, quantity: quantity.slice(0, 100) } : item)),
    clear: () => setItems([]),
  }), [add, items, loaded]);

  return <InquiryListContext.Provider value={value}>{children}</InquiryListContext.Provider>;
}

export function useInquiryList(): InquiryListContextValue {
  const context = useContext(InquiryListContext);
  if (!context) throw new Error("useInquiryList must be used within InquiryListProvider");
  return context;
}
