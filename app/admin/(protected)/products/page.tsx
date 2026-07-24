"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import {
  bulkUpdateProductsApi,
  deleteProductsApi,
  saveProduct,
} from "@/lib/services/admin-fetch";
import { useToast } from "@/components/admin/Toast";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/admin/Modal";
import { normalizeSearchTerm } from "@/lib/utils";
import type { Product, Category, Subcategory, ProductImage } from "@/types/database";
import {
  Plus,
  Pencil,
  Trash2,
  Search,
  Loader2,
  Star,
  ExternalLink,
  Copy,
  CheckSquare,
  Square,
  X,
} from "lucide-react";

type StatusFilter = "all" | "published" | "draft" | "featured";
type SortKey = "default" | "updated" | "name";

export default function AdminProductsPage() {
  const supabase = createBrowserSupabaseClient();
  const { show } = useToast();

  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Record<string, Category>>({});
  const [subcategories, setSubcategories] = useState<Subcategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterCat, setFilterCat] = useState("");
  const [filterSub, setFilterSub] = useState("");
  const [filterStatus, setFilterStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortKey>("default");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<20 | 50>(20);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 批量改类目 modal
  const [bulkCatOpen, setBulkCatOpen] = useState(false);
  const [bulkCat, setBulkCat] = useState("");
  const [bulkSub, setBulkSub] = useState("");
  const [bulkSubs, setBulkSubs] = useState<Subcategory[]>([]);
  const [bulkSaving, setBulkSaving] = useState(false);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // 读取列表（带分页 + 筛选 + 排序）
  const load = useCallback(async () => {
    setLoading(true);
    let query = supabase.from("products").select("*");

    if (filterStatus === "published") query = query.eq("is_published", true);
    else if (filterStatus === "draft") query = query.eq("is_published", false);
    else if (filterStatus === "featured") query = query.eq("is_featured", true);

    if (filterCat) query = query.eq("category_id", filterCat);
    if (filterSub) query = query.eq("subcategory_id", filterSub);

    const safeSearch = normalizeSearchTerm(search);
    if (safeSearch) {
      query = query.or(
        `name_cn.ilike.%${safeSearch}%,name_en.ilike.%${safeSearch}%,slug.ilike.%${safeSearch}%`
      );
    }

    if (sort === "updated") {
      query = query.order("updated_at", { ascending: false });
    } else if (sort === "name") {
      query = query.order("name_cn", { ascending: true });
    } else {
      query = query
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: false });
    }

    const from = (page - 1) * pageSize;
    const to = page * pageSize - 1;
    query = query.range(from, to);

    // count 查询（head）需应用相同筛选条件
    let countQuery = supabase
      .from("products")
      .select("id", { count: "exact", head: true });
    if (filterStatus === "published") countQuery = countQuery.eq("is_published", true);
    else if (filterStatus === "draft") countQuery = countQuery.eq("is_published", false);
    else if (filterStatus === "featured") countQuery = countQuery.eq("is_featured", true);
    if (filterCat) countQuery = countQuery.eq("category_id", filterCat);
    if (filterSub) countQuery = countQuery.eq("subcategory_id", filterSub);
    if (safeSearch) {
      countQuery = countQuery.or(
        `name_cn.ilike.%${safeSearch}%,name_en.ilike.%${safeSearch}%,slug.ilike.%${safeSearch}%`
      );
    }

    const [listRes, countRes, catsRes] = await Promise.all([
      query,
      countQuery,
      supabase.from("categories").select("*").order("sort_order"),
    ]);

    setProducts((listRes.data as Product[] | null) || []);
    setTotal(countRes.count || 0);
    const map: Record<string, Category> = {};
    ((catsRes.data as Category[] | null) || []).forEach((c) => (map[c.id] = c));
    setCategories(map);
    setLoading(false);
  }, [supabase, search, filterCat, filterSub, filterStatus, sort, page, pageSize]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  // 筛选/排序/每页大小变化时重置页码
  useEffect(() => {
    setPage(1);
  }, [search, filterCat, filterSub, filterStatus, sort, pageSize]);

  // 当前页超出总页数时回退（删除后可能发生）
  useEffect(() => {
    if (!loading && totalPages > 0 && page > totalPages) {
      setPage(totalPages);
    }
  }, [loading, page, totalPages]);

  // 加载筛选栏的二级类目（filterCat 变化时）
  useEffect(() => {
    if (!filterCat) {
      setSubcategories([]);
      setFilterSub("");
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: subs } = await supabase
        .from("subcategories")
        .select("*")
        .eq("category_id", filterCat)
        .order("sort_order", { ascending: true });
      if (cancelled) return;
      setSubcategories((subs as Subcategory[] | null) || []);
      setFilterSub("");
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, filterCat]);

  // 批量改类目 modal：加载二级类目
  useEffect(() => {
    if (!bulkCat) {
      setBulkSubs([]);
      setBulkSub("");
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: subs } = await supabase
        .from("subcategories")
        .select("*")
        .eq("category_id", bulkCat)
        .order("sort_order", { ascending: true });
      if (cancelled) return;
      setBulkSubs((subs as Subcategory[] | null) || []);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, bulkCat]);

  // 选中操作
  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => {
      const ids = products.map((p) => p.id);
      const allSelected = ids.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allSelected) {
        ids.forEach((id) => next.delete(id));
      } else {
        ids.forEach((id) => next.add(id));
      }
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  const allOnPageSelected =
    products.length > 0 && products.every((p) => selected.has(p.id));

  async function togglePublish(p: Product) {
    const result = await bulkUpdateProductsApi([p.id], {
      is_published: !p.is_published,
    });
    if (!result.ok) {
      show("操作失败，请稍后重试", "error");
      return;
    }
    show(p.is_published ? "已下架" : "已发布", "success");
    setProducts((prev) =>
      prev.map((it) => (it.id === p.id ? { ...it, is_published: !it.is_published } : it))
    );
  }

  async function toggleFeatured(p: Product) {
    const result = await bulkUpdateProductsApi([p.id], {
      is_featured: !p.is_featured,
    });
    if (!result.ok) {
      show("操作失败，请稍后重试", "error");
      return;
    }
    show(p.is_featured ? "已取消主推" : "已设为主推", "success");
    setProducts((prev) =>
      prev.map((it) => (it.id === p.id ? { ...it, is_featured: !it.is_featured } : it))
    );
  }

  async function handleDelete(p: Product) {
    if (!confirm(`确定删除产品「${p.name_cn}」？\n该操作不可恢复。`)) return;
    const result = await deleteProductsApi(p.id);
    if (!result.ok) {
      show("删除失败，请稍后重试", "error");
      return;
    }
    show("产品已删除", "success");
    load();
  }

  async function handleCopy(p: Product) {
    const [{ data: full }, { data: imgs }] = await Promise.all([
      supabase.from("products").select("*").eq("id", p.id).single(),
      supabase
        .from("product_images")
        .select("*")
        .eq("product_id", p.id)
        .order("sort_order", { ascending: true }),
    ]);
    if (!full) {
      show("读取产品失败", "error");
      return;
    }
    const src = full as Product;
    const newPayload: Record<string, unknown> = { ...src };
    delete newPayload.id;
    delete newPayload.created_at;
    delete newPayload.updated_at;
    delete newPayload.product_images;
    delete newPayload.category;
    delete newPayload.subcategory;
    delete newPayload.search_document;
    newPayload.name_cn = `${src.name_cn} 副本`;
    newPayload.slug = `${src.slug}-copy-${Date.now().toString().slice(-6)}`;
    newPayload.is_published = false;
    newPayload.is_featured = false;

    // Phase 2: copy via the transactional API (product + images atomically).
    const imgList = (imgs as ProductImage[] | null) || [];
    const result = await saveProduct({
      product: newPayload,
      images: imgList.map((img, i) => ({
        image_url: img.image_url || "",
        alt_cn: img.alt_cn || null,
        alt_en: img.alt_en || null,
        sort_order: i,
      })),
    });
    if (!result.ok) {
      show("复制失败，请稍后重试", "error");
      return;
    }
    show("已复制产品", "success");
    load();
  }

  async function bulkUpdate(field: "is_published" | "is_featured", value: boolean) {
    if (selected.size === 0) return;
    const result = await bulkUpdateProductsApi([...selected], {
      [field]: value,
    } as { is_published?: boolean; is_featured?: boolean });
    if (!result.ok) {
      show("批量操作失败，请稍后重试", "error");
      return;
    }
    show(`已更新 ${selected.size} 个产品`, "success");
    clearSelection();
    load();
  }

  async function bulkDelete() {
    if (selected.size === 0) return;
    if (!confirm(`确定删除选中的 ${selected.size} 个产品？\n该操作不可恢复。`)) return;
    // Delete via the first selected id's endpoint; the API accepts a batch.
    const firstId = [...selected][0];
    const rest = [...selected].slice(1);
    const result = await deleteProductsApi(firstId, rest.length ? rest : undefined);
    if (!result.ok) {
      show("批量删除失败，请稍后重试", "error");
      return;
    }
    show(`已删除 ${selected.size} 个产品`, "success");
    clearSelection();
    load();
  }

  async function bulkChangeCategory() {
    if (selected.size === 0) return;
    if (!bulkCat) {
      show("请选择一级类目", "error");
      return;
    }
    setBulkSaving(true);
    const result = await bulkUpdateProductsApi([...selected], {
      category_id: bulkCat,
      subcategory_id: bulkSub || null,
    });
    setBulkSaving(false);
    if (!result.ok) {
      show("批量修改类目失败，请稍后重试", "error");
      return;
    }
    show(`已修改 ${selected.size} 个产品的类目`, "success");
    setBulkCatOpen(false);
    setBulkCat("");
    setBulkSub("");
    clearSelection();
    load();
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
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[200px] flex-1">
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
          <select
            value={filterSub}
            onChange={(e) => setFilterSub(e.target.value)}
            disabled={!filterCat}
            className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm outline-none focus:border-steel disabled:bg-gray-50"
          >
            <option value="">全部二级类目</option>
            {subcategories.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name_cn}
              </option>
            ))}
          </select>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm outline-none focus:border-steel"
          >
            <option value="default">默认排序</option>
            <option value="updated">最近更新</option>
            <option value="name">名称</option>
          </select>
          <select
            value={String(pageSize)}
            onChange={(e) => setPageSize(Number(e.target.value) as 20 | 50)}
            className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm outline-none focus:border-steel"
          >
            <option value="20">每页 20</option>
            <option value="50">每页 50</option>
          </select>
          <div className="flex rounded-lg border border-gray-200 bg-white p-0.5">
            {(["all", "published", "draft", "featured"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setFilterStatus(s)}
                className={`rounded-md px-3 py-1.5 text-xs transition ${
                  filterStatus === s
                    ? "bg-steel text-white"
                    : "text-gray-600 hover:bg-gray-50"
                }`}
              >
                {s === "all" ? "全部" : s === "published" ? "已发布" : s === "draft" ? "草稿" : "主推"}
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
      ) : (
        <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-100">
          {products.length === 0 ? (
            <div className="p-10 text-center text-sm text-gray-400">暂无产品</div>
          ) : (
            <>
              {/* 桌面表格 */}
              <table className="hidden w-full table-fixed md:table">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                    <th className="w-12 px-4 py-3">
                      <button onClick={toggleSelectAll} aria-label="全选当前页">
                        {allOnPageSelected ? (
                          <CheckSquare className="h-4 w-4 text-steel" />
                        ) : (
                          <Square className="h-4 w-4 text-gray-400" />
                        )}
                      </button>
                    </th>
                    <th className="w-20 px-4 py-3">封面</th>
                    <th className="w-64 px-4 py-3">名称</th>
                    <th className="w-32 px-4 py-3">类目</th>
                    <th className="w-20 px-4 py-3">防火</th>
                    <th className="w-20 px-4 py-3">环保</th>
                    <th className="w-20 px-4 py-3">排序</th>
                    <th className="w-28 px-4 py-3">状态</th>
                    <th className="w-48 px-4 py-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {products.map((p) => {
                    const cat = p.category_id ? categories[p.category_id] : null;
                    return (
                      <tr
                        key={p.id}
                        className={`text-sm hover:bg-gray-50 ${
                          selected.has(p.id) ? "bg-steel/5" : ""
                        }`}
                      >
                        <td className="px-4 py-3">
                          <button onClick={() => toggleSelect(p.id)} aria-label="选择">
                            {selected.has(p.id) ? (
                              <CheckSquare className="h-4 w-4 text-steel" />
                            ) : (
                              <Square className="h-4 w-4 text-gray-400" />
                            )}
                          </button>
                        </td>
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
                              onClick={() => handleCopy(p)}
                              className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
                              aria-label="复制"
                              title="复制产品"
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </button>
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
                    <div
                      key={p.id}
                      className={`p-4 ${selected.has(p.id) ? "bg-steel/5" : ""}`}
                    >
                      <div className="flex gap-3">
                        <button
                          onClick={() => toggleSelect(p.id)}
                          aria-label="选择"
                          className="mt-1 shrink-0"
                        >
                          {selected.has(p.id) ? (
                            <CheckSquare className="h-5 w-5 text-steel" />
                          ) : (
                            <Square className="h-5 w-5 text-gray-400" />
                          )}
                        </button>
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
                          onClick={() => handleCopy(p)}
                          className="rounded-md border border-gray-200 px-3 py-1.5 text-xs text-graphite"
                          aria-label="复制"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
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

              {/* 分页 */}
              <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3 text-xs text-gray-500">
                <span>
                  共 {total} 个 · 第 {page}/{totalPages} 页
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="rounded-md border border-gray-200 px-3 py-1 hover:bg-gray-50 disabled:opacity-40"
                  >
                    上一页
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    className="rounded-md border border-gray-200 px-3 py-1 hover:bg-gray-50 disabled:opacity-40"
                  >
                    下一页
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* 批量操作条 */}
      {selected.size > 0 && (
        <div className="fixed bottom-4 left-1/2 z-30 flex max-w-[95vw] flex-wrap items-center justify-center gap-2 -translate-x-1/2 rounded-2xl bg-graphite/95 px-4 py-3 text-white shadow-lg backdrop-blur">
          <span className="text-sm">已选 {selected.size} 项</span>
          <Button size="sm" variant="secondary" onClick={() => bulkUpdate("is_published", true)}>
            批量上架
          </Button>
          <Button size="sm" variant="secondary" onClick={() => bulkUpdate("is_published", false)}>
            批量下架
          </Button>
          <Button size="sm" variant="gold" onClick={() => bulkUpdate("is_featured", true)}>
            批量设主推
          </Button>
          <Button size="sm" variant="secondary" onClick={() => bulkUpdate("is_featured", false)}>
            取消主推
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setBulkCatOpen(true)}>
            批量改类目
          </Button>
          <Button size="sm" variant="danger" onClick={bulkDelete}>
            批量删除
          </Button>
          <button
            onClick={clearSelection}
            className="ml-1 text-gray-300 hover:text-white"
            aria-label="取消选择"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* 批量改类目 Modal */}
      {bulkCatOpen && (
        <Modal title="批量修改类目" onClose={() => setBulkCatOpen(false)}>
          <div className="space-y-4">
            <p className="text-xs text-gray-500">
              将为选中的 {selected.size} 个产品修改归属类目。二级类目可不填。
            </p>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700">
                一级类目<span className="ml-0.5 text-red-500">*</span>
              </label>
              <select
                value={bulkCat}
                onChange={(e) => {
                  setBulkCat(e.target.value);
                  setBulkSub("");
                }}
                className="h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-graphite outline-none focus:border-steel focus:ring-2 focus:ring-steel/20"
              >
                <option value="">请选择</option>
                {Object.values(categories).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name_cn}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700">二级类目（可选）</label>
              <select
                value={bulkSub}
                onChange={(e) => setBulkSub(e.target.value)}
                disabled={!bulkCat}
                className="h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-graphite outline-none focus:border-steel focus:ring-2 focus:ring-steel/20 disabled:bg-gray-50"
              >
                <option value="">不指定</option>
                {bulkSubs.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name_cn}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-100 pt-4">
              <Button
                variant="secondary"
                onClick={() => setBulkCatOpen(false)}
                disabled={bulkSaving}
              >
                取消
              </Button>
              <Button onClick={bulkChangeCategory} loading={bulkSaving} disabled={bulkSaving}>
                确认修改
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
