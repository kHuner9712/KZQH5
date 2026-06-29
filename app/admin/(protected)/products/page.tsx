"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { useToast } from "@/components/admin/Toast";
import { Button } from "@/components/ui/Button";
import type { Product, Category } from "@/types/database";
import { Plus, Pencil, Trash2, Search, Loader2, Star, ExternalLink } from "lucide-react";

export default function AdminProductsPage() {
  const supabase = createBrowserSupabaseClient();
  const { show } = useToast();

  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Record<string, Category>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterCat, setFilterCat] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "published" | "draft">("all");

  const load = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from("products")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false });

    if (filterStatus === "published") query = query.eq("is_published", true);
    if (filterStatus === "draft") query = query.eq("is_published", false);
    if (filterCat) query = query.eq("category_id", filterCat);

    if (search.trim()) {
      query = query.or(`name_cn.ilike.%${search}%,name_en.ilike.%${search}%,slug.ilike.%${search}%`);
    }

    const [{ data: list }, { data: cats }] = await Promise.all([
      query,
      supabase.from("categories").select("*").order("sort_order"),
    ]);

    setProducts((list as Product[] | null) || []);
    const map: Record<string, Category> = {};
    ((cats as Category[] | null) || []).forEach((c) => (map[c.id] = c));
    setCategories(map);
    setLoading(false);
  }, [supabase, search, filterCat, filterStatus]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  async function togglePublish(p: Product) {
    const { error } = await supabase
      .from("products")
      .update({ is_published: !p.is_published })
      .eq("id", p.id);
    if (error) {
      show(error.message, "error");
      return;
    }
    show(p.is_published ? "已下架" : "已发布", "success");
    setProducts((prev) =>
      prev.map((it) => (it.id === p.id ? { ...it, is_published: !it.is_published } : it))
    );
  }

  async function toggleFeatured(p: Product) {
    const { error } = await supabase
      .from("products")
      .update({ is_featured: !p.is_featured })
      .eq("id", p.id);
    if (error) {
      show(error.message, "error");
      return;
    }
    show(p.is_featured ? "已取消主推" : "已设为主推", "success");
    setProducts((prev) =>
      prev.map((it) => (it.id === p.id ? { ...it, is_featured: !it.is_featured } : it))
    );
  }

  async function handleDelete(p: Product) {
    if (!confirm(`确定删除产品「${p.name_cn}」？\n该操作不可恢复。`)) return;
    const { error } = await supabase.from("products").delete().eq("id", p.id);
    if (error) {
      show(error.message, "error");
      return;
    }
    show("产品已删除", "success");
    setProducts((prev) => prev.filter((it) => it.id !== p.id));
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-graphite">产品管理</h1>
          <p className="mt-1 text-sm text-gray-500">维护产品信息、图片、发布状态</p>
        </div>
        <Link href="/admin/products/new">
          <Button>
            <Plus className="h-4 w-4" /> 新增产品
          </Button>
        </Link>
      </div>

      {/* 筛选 */}
      <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-gray-100">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索产品名称、slug"
              className="h-10 w-full rounded-lg border border-gray-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-steel focus:ring-2 focus:ring-steel/20"
            />
          </div>
          <select
            value={filterCat}
            onChange={(e) => setFilterCat(e.target.value)}
            className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm outline-none focus:border-steel"
          >
            <option value="">全部一级类目</option>
            {Object.values(categories).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name_cn}
              </option>
            ))}
          </select>
          <div className="flex rounded-lg border border-gray-200 bg-white p-0.5">
            {(["all", "published", "draft"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setFilterStatus(s)}
                className={`rounded-md px-3 py-1.5 text-xs transition ${
                  filterStatus === s
                    ? "bg-steel text-white"
                    : "text-gray-600 hover:bg-gray-50"
                }`}
              >
                {s === "all" ? "全部" : s === "published" ? "已发布" : "草稿"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 列表 */}
      {loading ? (
        <div className="flex h-40 items-center justify-center text-gray-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : products.length === 0 ? (
        <div className="rounded-2xl bg-white p-10 text-center text-sm text-gray-400 ring-1 ring-gray-100">
          暂无产品
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-100">
          {/* 桌面表格 */}
          <table className="hidden w-full table-fixed md:table">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                <th className="w-20 px-4 py-3">封面</th>
                <th className="w-64 px-4 py-3">名称</th>
                <th className="w-32 px-4 py-3">类目</th>
                <th className="w-20 px-4 py-3">防火</th>
                <th className="w-20 px-4 py-3">环保</th>
                <th className="w-20 px-4 py-3">排序</th>
                <th className="w-28 px-4 py-3">状态</th>
                <th className="w-44 px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {products.map((p) => {
                const cat = p.category_id ? categories[p.category_id] : null;
                return (
                  <tr key={p.id} className="text-sm hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="h-12 w-16 overflow-hidden rounded bg-gray-100">
                        {p.cover_image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={p.cover_image_url}
                            alt={p.name_cn}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[10px] text-gray-400">
                            无图
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {p.is_featured && (
                          <Star className="h-3.5 w-3.5 shrink-0 fill-gold text-gold" />
                        )}
                        <div className="min-w-0">
                          <div className="truncate font-medium text-graphite">{p.name_cn}</div>
                          <div className="truncate text-xs text-gray-400">{p.slug}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">
                      {cat?.name_cn || "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">{p.fire_rating || "—"}</td>
                    <td className="px-4 py-3 text-xs text-gray-600">{p.eco_grade || "—"}</td>
                    <td className="px-4 py-3 text-xs text-gray-600">{p.sort_order}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] ${
                          p.is_published
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-gray-100 text-gray-500"
                        }`}
                      >
                        {p.is_published ? "已发布" : "草稿"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Link href={`/products/${p.slug}`} target="_blank">
                          <button
                            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
                            aria-label="预览"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </button>
                        </Link>
                        <button
                          onClick={() => toggleFeatured(p)}
                          className={`rounded-md p-1.5 hover:bg-gray-100 ${
                            p.is_featured ? "text-gold" : "text-gray-400"
                          }`}
                          aria-label="主推"
                          title={p.is_featured ? "取消主推" : "设为主推"}
                        >
                          <Star className={`h-3.5 w-3.5 ${p.is_featured ? "fill-gold" : ""}`} />
                        </button>
                        <button
                          onClick={() => togglePublish(p)}
                          className="rounded-md px-2 py-1 text-xs text-steel hover:bg-steel/10"
                        >
                          {p.is_published ? "下架" : "发布"}
                        </button>
                        <Link href={`/admin/products/${p.id}/edit`}>
                          <button
                            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
                            aria-label="编辑"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </Link>
                        <button
                          onClick={() => handleDelete(p)}
                          className="rounded-md p-1.5 text-red-500 hover:bg-red-50"
                          aria-label="删除"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* 移动卡片 */}
          <div className="divide-y divide-gray-50 md:hidden">
            {products.map((p) => {
              const cat = p.category_id ? categories[p.category_id] : null;
              return (
                <div key={p.id} className="p-4">
                  <div className="flex gap-3">
                    <div className="h-16 w-20 shrink-0 overflow-hidden rounded bg-gray-100">
                      {p.cover_image_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={p.cover_image_url}
                          alt={p.name_cn}
                          className="h-full w-full object-cover"
                        />
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {p.is_featured && (
                          <Star className="h-3.5 w-3.5 shrink-0 fill-gold text-gold" />
                        )}
                        <span className="truncate text-sm font-medium text-graphite">
                          {p.name_cn}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-gray-400">{p.slug}</div>
                      <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] text-gray-500">
                        <span className="rounded bg-gray-100 px-1.5 py-0.5">
                          {cat?.name_cn || "未分类"}
                        </span>
                        <span className="rounded bg-gray-100 px-1.5 py-0.5">
                          {p.fire_rating || "—"}
                        </span>
                        <span className="rounded bg-gray-100 px-1.5 py-0.5">
                          {p.eco_grade || "—"}
                        </span>
                        <span
                          className={`rounded px-1.5 py-0.5 ${
                            p.is_published
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-gray-100 text-gray-500"
                          }`}
                        >
                          {p.is_published ? "已发布" : "草稿"}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      onClick={() => togglePublish(p)}
                      className="flex-1 rounded-md border border-gray-200 py-1.5 text-xs text-steel"
                    >
                      {p.is_published ? "下架" : "发布"}
                    </button>
                    <Link href={`/admin/products/${p.id}/edit`} className="flex-1">
                      <button className="flex w-full items-center justify-center gap-1 rounded-md border border-gray-200 py-1.5 text-xs text-graphite">
                        <Pencil className="h-3 w-3" /> 编辑
                      </button>
                    </Link>
                    <button
                      onClick={() => handleDelete(p)}
                      className="rounded-md border border-red-200 px-3 py-1.5 text-xs text-red-500"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
