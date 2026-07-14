"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useToast } from "@/components/admin/Toast";
import { Button } from "@/components/ui/Button";
import { copyText } from "@/lib/client/copy-text";
import { formatDate } from "@/lib/utils";
import type { Inquiry, InquiryStatus } from "@/types/database";
import { useDialogFocusTrap } from "@/lib/client/use-dialog-focus-trap";
import {
  CalendarDays,
  Check,
  Download,
  ExternalLink,
  Globe,
  Inbox,
  Loader2,
  Mail,
  MessageCircle,
  Package,
  Phone,
  Search,
  UserRound,
  X,
} from "lucide-react";

const PAGE_SIZE = 20;
const statusOptions: Array<{ value: InquiryStatus; label: string; className: string }> = [
  { value: "new", label: "新询盘", className: "bg-blue-50 text-blue-700" },
  { value: "contacted", label: "已联系", className: "bg-amber-50 text-amber-700" },
  { value: "closed", label: "已关闭", className: "bg-gray-100 text-gray-600" },
];
const statusMap = Object.fromEntries(statusOptions.map((item) => [item.value, item]));
const sources = ["direct", "wechat-menu", "wechat-qr", "whatsapp", "email", "h5"];

interface Filters {
  search: string;
  status: "all" | InquiryStatus;
  language: "all" | "zh" | "en";
  source: string;
  dateFrom: string;
  dateTo: string;
  unread: boolean;
}

const initialFilters: Filters = {
  search: "",
  status: "all",
  language: "all",
  source: "",
  dateFrom: "",
  dateTo: "",
  unread: false,
};

function buildParams(filters: Filters, page?: number): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.search.trim()) params.set("search", filters.search.trim());
  if (filters.status !== "all") params.set("status", filters.status);
  if (filters.language !== "all") params.set("language", filters.language);
  if (filters.source) params.set("source", filters.source);
  if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) params.set("dateTo", filters.dateTo);
  if (filters.unread) params.set("unread", "true");
  if (page) params.set("page", String(page));
  params.set("pageSize", String(PAGE_SIZE));
  return params;
}

export default function InquiriesPage() {
  const router = useRouter();
  const { show } = useToast();
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [list, setList] = useState<Inquiry[]>([]);
  const [detail, setDetail] = useState<Inquiry | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const exportHref = useMemo(
    () => `/api/admin/inquiries/export?${buildParams(filters).toString()}`,
    [filters]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/admin/inquiries?${buildParams(filters, page)}`, {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取询盘失败");
      setList(data.items || []);
      setTotal(data.total || 0);
    } catch (error) {
      show(error instanceof Error ? error.message : "读取询盘失败", "error");
    } finally {
      setLoading(false);
    }
  }, [filters, page, show]);

  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [load]);

  function updateFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  }

  async function patchInquiry(
    inquiry: Inquiry,
    patch: Partial<Pick<Inquiry, "status" | "is_read" | "notes" | "assignee">>
  ) {
    const response = await fetch("/api/admin/inquiries", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: inquiry.id, ...patch }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "更新失败");
    const updated = { ...inquiry, ...(data.inquiry || patch) } as Inquiry;
    setList((current) => current.map((item) => item.id === updated.id ? updated : item));
    setDetail((current) => current?.id === updated.id ? updated : current);
    router.refresh();
    return updated;
  }

  async function openDetail(inquiry: Inquiry) {
    setDetail(inquiry);
    if (!inquiry.is_read) {
      try {
        await patchInquiry(inquiry, { is_read: true });
      } catch (error) {
        show(error instanceof Error ? error.message : "标记已读失败", "error");
      }
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-graphite">询盘管理</h1>
          <p className="mt-1 text-sm text-gray-500">管理国内 H5 与海外 B2B 询盘</p>
        </div>
        <a href={exportHref} className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-5 text-sm font-medium text-graphite transition hover:bg-gray-50">
          <Download className="h-4 w-4" />导出当前筛选 CSV
        </a>
      </div>

      <div className="space-y-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-gray-100">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="relative xl:col-span-2">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input value={filters.search} onChange={(event) => updateFilter("search", event.target.value)} placeholder="搜索姓名、联系方式、公司或产品" className="h-10 w-full rounded-lg border border-gray-200 pl-9 pr-3 text-sm outline-none focus:border-steel focus:ring-2 focus:ring-steel/20" />
          </div>
          <select value={filters.status} onChange={(event) => updateFilter("status", event.target.value as Filters["status"])} className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm outline-none focus:border-steel">
            <option value="all">全部状态</option>{statusOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
          <select value={filters.language} onChange={(event) => updateFilter("language", event.target.value as Filters["language"])} className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm outline-none focus:border-steel">
            <option value="all">全部语言</option><option value="zh">中文</option><option value="en">English</option>
          </select>
          <select value={filters.source} onChange={(event) => updateFilter("source", event.target.value)} className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm outline-none focus:border-steel">
            <option value="">全部来源</option>{sources.map((source) => <option key={source} value={source}>{source}</option>)}
          </select>
          <label className="relative"><CalendarDays className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" /><input type="date" aria-label="开始日期" value={filters.dateFrom} onChange={(event) => updateFilter("dateFrom", event.target.value)} className="h-10 w-full rounded-lg border border-gray-200 pl-9 pr-2 text-sm outline-none focus:border-steel" /></label>
          <label className="relative"><CalendarDays className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" /><input type="date" aria-label="结束日期" value={filters.dateTo} onChange={(event) => updateFilter("dateTo", event.target.value)} className="h-10 w-full rounded-lg border border-gray-200 pl-9 pr-2 text-sm outline-none focus:border-steel" /></label>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => updateFilter("unread", !filters.unread)} className={`h-10 rounded-lg border px-3 text-xs ${filters.unread ? "border-red-300 bg-red-50 text-red-700" : "border-gray-200 text-gray-600"}`}>仅看未读</button>
            <button type="button" onClick={() => { setFilters(initialFilters); setPage(1); }} className="h-10 px-2 text-xs text-gray-500 hover:text-graphite">清除</button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex h-40 items-center justify-center text-gray-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : list.length === 0 ? (
        <div className="rounded-2xl bg-white p-10 text-center ring-1 ring-gray-100"><Inbox className="mx-auto h-10 w-10 text-gray-300" /><p className="mt-3 text-sm text-gray-400">暂无匹配询盘</p></div>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-100">
          <div className="divide-y divide-gray-50">
            {list.map((inquiry) => {
              const status = statusMap[inquiry.status] || statusMap.new;
              return (
                <button key={inquiry.id} onClick={() => openDetail(inquiry)} className={`flex w-full items-start gap-3 px-4 py-3.5 text-left transition hover:bg-gray-50 ${!inquiry.is_read ? "bg-blue-50/40" : ""}`}>
                  <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-steel/10 text-sm font-semibold text-steel">{inquiry.name.slice(0, 1).toUpperCase()}{!inquiry.is_read && <span className="absolute right-0 top-0 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white" />}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium text-graphite">{inquiry.name}</span><span className={`rounded px-1.5 py-0.5 text-[10px] ${status.className}`}>{status.label}</span><span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">{inquiry.language === "en" ? "EN" : "中文"}</span>{inquiry.source && <span className="text-[11px] text-gray-400">{inquiry.source}</span>}</div>
                    <p className="mt-0.5 line-clamp-1 text-xs text-gray-500">{inquiry.inquiry_items?.length ? `${inquiry.inquiry_items.length} 个产品 · ${inquiry.inquiry_items.map((item) => item.product_name_cn || item.product_name_en || item.product_slug).filter(Boolean).join("、")}` : inquiry.interested_product || inquiry.message || "—"}</p>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-gray-400"><span>{inquiry.phone || inquiry.wechat || inquiry.email || inquiry.whatsapp || "—"}</span><span>{formatDate(inquiry.created_at)}</span>{inquiry.assignee && <span>负责人：{inquiry.assignee}</span>}</div>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3 text-xs text-gray-500"><span>共 {total} 条 · 第 {page}/{totalPages} 页</span><div className="flex gap-2"><button onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1} className="rounded-md border border-gray-200 px-3 py-1.5 disabled:opacity-40">上一页</button><button onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page >= totalPages} className="rounded-md border border-gray-200 px-3 py-1.5 disabled:opacity-40">下一页</button></div></div>
        </div>
      )}

      {detail && <InquiryDetail key={detail.id} inquiry={detail} onClose={() => setDetail(null)} onPatch={async (patch) => { const updated = await patchInquiry(detail, patch); show("询盘已更新", "success"); return updated; }} />}
    </div>
  );
}

function InquiryDetail({ inquiry, onClose, onPatch }: { inquiry: Inquiry; onClose: () => void; onPatch: (patch: Partial<Pick<Inquiry, "status" | "is_read" | "notes" | "assignee">>) => Promise<Inquiry> }) {
  const { show } = useToast();
  const [notes, setNotes] = useState(inquiry.notes || "");
  const [assignee, setAssignee] = useState(inquiry.assignee || "");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap({ active: true, containerRef: dialogRef, onClose });
  const inquiryItems = [...(inquiry.inquiry_items || [])].sort((a, b) => a.sort_order - b.sort_order);
  const fields = [
    { icon: Phone, label: "手机", value: inquiry.phone },
    { icon: MessageCircle, label: "微信", value: inquiry.wechat },
    { icon: Mail, label: "邮箱", value: inquiry.email },
    { icon: MessageCircle, label: "WhatsApp", value: inquiry.whatsapp },
    { icon: Globe, label: "国家 / 地区", value: inquiry.country },
    { icon: Package, label: "感兴趣产品", value: inquiry.interested_product },
  ].filter((field) => field.value);

  async function copy(label: string, value: string) {
    const success = await copyText(value);
    setCopied(success ? label : "");
    show(success ? `${label}已复制` : "复制失败，请长按选择复制", success ? "success" : "error");
    if (success) window.setTimeout(() => setCopied(""), 1800);
  }

  async function saveNotes() {
    setSaving(true);
    try { await onPatch({ notes, assignee }); } catch (error) { show(error instanceof Error ? error.message : "保存失败", "error"); }
    finally { setSaving(false); }
  }

  async function runPatch(patch: Partial<Pick<Inquiry, "status" | "is_read">>) {
    try {
      await onPatch(patch);
    } catch (error) {
      show(error instanceof Error ? error.message : "更新失败", "error");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="询盘详情">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div ref={dialogRef} tabIndex={-1} className="relative h-full w-full max-w-lg overflow-y-auto bg-white shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-100 bg-white px-5 py-4"><div><h2 className="text-sm font-semibold text-graphite">询盘详情</h2><p className="text-xs text-gray-400">{formatDate(inquiry.created_at)}</p></div><button onClick={onClose} aria-label="关闭"><X className="h-5 w-5 text-gray-400" /></button></div>
        <div className="space-y-5 p-5">
          <div className="rounded-xl bg-gray-50 p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold text-graphite">{inquiry.name}</p>{inquiry.company && <p className="text-xs text-gray-500">{inquiry.company}</p>}</div><button onClick={() => runPatch({ is_read: !inquiry.is_read })} className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-600">{inquiry.is_read ? "标记未读" : "标记已读"}</button></div><div className="mt-4 space-y-2">{fields.map((field) => { const Icon = field.icon; return <div key={field.label} className="flex items-start gap-2 text-xs"><Icon className="mt-0.5 h-3.5 w-3.5 text-gray-400" /><span className="w-20 shrink-0 text-gray-400">{field.label}</span><span className="min-w-0 flex-1 break-all text-gray-700">{field.value}</span>{(field.label === "微信" || field.label === "手机") && <button onClick={() => copy(field.label, field.value as string)} className="text-steel">{copied === field.label ? <Check className="h-3.5 w-3.5" /> : "复制"}</button>}</div>; })}{inquiry.quantity && <p className="text-xs text-gray-700">数量：{inquiry.quantity}</p>}</div></div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{inquiry.phone && <a href={`tel:${inquiry.phone.replace(/[^+\d]/g, "")}`} className="inline-flex h-10 items-center justify-center gap-1 rounded-lg border border-gray-200 text-xs text-gray-700"><Phone className="h-3.5 w-3.5" />拨号</a>}{inquiry.email && <a href={`mailto:${inquiry.email}`} className="inline-flex h-10 items-center justify-center gap-1 rounded-lg border border-gray-200 text-xs text-gray-700"><Mail className="h-3.5 w-3.5" />邮件</a>}{inquiry.whatsapp && <a href={`https://wa.me/${inquiry.whatsapp.replace(/\D/g, "")}`} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center justify-center gap-1 rounded-lg border border-gray-200 text-xs text-gray-700"><MessageCircle className="h-3.5 w-3.5" />WhatsApp</a>}</div>
          {inquiryItems.length > 0 && <section><h3 className="mb-2 text-xs font-medium text-gray-500">产品清单（{inquiryItems.length}）</h3><div className="divide-y divide-gray-100 rounded-xl border border-gray-200">{inquiryItems.map((item) => { const name = item.product_name_cn || item.product_name_en || item.product_slug || "已删除产品"; return <div key={item.id} className="p-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-sm font-medium text-graphite">{name}</p><p className="mt-0.5 break-all text-[11px] text-gray-400">{item.product_slug || "无产品型号快照"}</p></div>{item.product_slug && <Link href={`/products/${encodeURIComponent(item.product_slug)}`} target="_blank" className="inline-flex shrink-0 items-center gap-1 text-xs text-steel hover:underline">详情<ExternalLink className="h-3 w-3" /></Link>}</div><p className="mt-2 text-xs text-gray-600">需求数量：{item.quantity || "未填写"}</p>{!item.product_id && <p className="mt-1 text-[11px] text-amber-600">产品已删除，当前显示提交时名称快照</p>}</div>; })}</div></section>}
          {inquiry.message && <section><h3 className="mb-2 text-xs font-medium text-gray-500">留言</h3><div className="whitespace-pre-wrap rounded-xl border border-gray-200 p-4 text-sm text-graphite">{inquiry.message}</div></section>}
          <section><h3 className="mb-2 text-xs font-medium text-gray-500">处理状态</h3><div className="grid grid-cols-3 gap-2">{statusOptions.map((item) => <button key={item.value} onClick={() => runPatch({ status: item.value })} className={`rounded-lg border px-2 py-2 text-xs ${inquiry.status === item.value ? "border-steel bg-steel text-white" : "border-gray-200 text-gray-600"}`}>{item.label}</button>)}</div></section>
          <section className="space-y-3"><h3 className="text-xs font-medium text-gray-500">跟进信息</h3><label className="block text-xs text-gray-500"><span className="mb-1 block">负责人</span><div className="relative"><UserRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" /><input value={assignee} onChange={(event) => setAssignee(event.target.value)} className="h-10 w-full rounded-lg border border-gray-200 pl-9 pr-3 text-sm outline-none focus:border-steel" /></div></label><label className="block text-xs text-gray-500"><span className="mb-1 block">备注</span><textarea rows={4} value={notes} onChange={(event) => setNotes(event.target.value)} className="w-full rounded-lg border border-gray-200 p-3 text-sm outline-none focus:border-steel" /></label><Button onClick={saveNotes} loading={saving} className="w-full">保存负责人和备注</Button></section>
          <section className="space-y-1 text-[11px] text-gray-400"><p>语言：{inquiry.language} · 来源：{inquiry.source || "-"} · 渠道：{inquiry.channel || "-"}</p><p>产品 ID：{inquiry.product_id || "-"} · Slug：{inquiry.product_slug || "-"}</p><p>UTM：{[inquiry.utm_source, inquiry.utm_medium, inquiry.utm_campaign, inquiry.utm_content, inquiry.utm_term].filter(Boolean).join(" / ") || "-"}</p>{inquiry.page_url && <a href={inquiry.page_url} target="_blank" rel="noreferrer" className="block break-all text-steel underline">{inquiry.page_url}</a>}</section>
        </div>
      </div>
    </div>
  );
}
