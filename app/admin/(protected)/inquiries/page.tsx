"use client";

import { useEffect, useState, useCallback } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { useToast } from "@/components/admin/Toast";
import { Button } from "@/components/ui/Button";
import { formatDate } from "@/lib/utils";
import type { Inquiry, InquiryStatus } from "@/types/database";
import {
  Loader2,
  Search,
  Mail,
  Phone,
  MessageCircle,
  Globe,
  Package,
  X,
  Inbox,
} from "lucide-react";

const statusOptions: { value: InquiryStatus; label: string; className: string }[] = [
  { value: "new", label: "新询盘", className: "bg-blue-50 text-blue-700" },
  { value: "contacted", label: "已联系", className: "bg-amber-50 text-amber-700" },
  { value: "closed", label: "已关闭", className: "bg-gray-100 text-gray-600" },
];

const statusMap = Object.fromEntries(statusOptions.map((s) => [s.value, s]));

export default function InquiriesPage() {
  const supabase = createBrowserSupabaseClient();
  const { show } = useToast();

  const [list, setList] = useState<Inquiry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | InquiryStatus>("all");
  const [detail, setDetail] = useState<Inquiry | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from("inquiries")
      .select("*")
      .order("created_at", { ascending: false });

    if (filterStatus !== "all") query = query.eq("status", filterStatus);
    if (search.trim()) {
      query = query.or(
        `name.ilike.%${search}%,email.ilike.%${search}%,whatsapp.ilike.%${search}%,interested_product.ilike.%${search}%`
      );
    }

    const { data } = await query;
    setList((data as Inquiry[] | null) || []);
    setLoading(false);
  }, [supabase, search, filterStatus]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  async function updateStatus(inquiry: Inquiry, status: InquiryStatus) {
    const { error } = await supabase
      .from("inquiries")
      .update({ status })
      .eq("id", inquiry.id);
    if (error) {
      show(error.message, "error");
      return;
    }
    show("状态已更新", "success");
    setList((prev) =>
      prev.map((it) => (it.id === inquiry.id ? { ...it, status } : it))
    );
    if (detail?.id === inquiry.id) {
      setDetail({ ...detail, status });
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-graphite">询盘管理</h1>
        <p className="mt-1 text-sm text-gray-500">查看海外询盘，标记处理状态</p>
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
              placeholder="搜索姓名、邮箱、WhatsApp、产品"
              className="h-10 w-full rounded-lg border border-gray-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-steel focus:ring-2 focus:ring-steel/20"
            />
          </div>
          <div className="flex rounded-lg border border-gray-200 bg-white p-0.5">
            <button
              onClick={() => setFilterStatus("all")}
              className={`rounded-md px-3 py-1.5 text-xs transition ${
                filterStatus === "all" ? "bg-steel text-white" : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              全部
            </button>
            {statusOptions.map((s) => (
              <button
                key={s.value}
                onClick={() => setFilterStatus(s.value)}
                className={`rounded-md px-3 py-1.5 text-xs transition ${
                  filterStatus === s.value
                    ? "bg-steel text-white"
                    : "text-gray-600 hover:bg-gray-50"
                }`}
              >
                {s.label}
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
      ) : list.length === 0 ? (
        <div className="rounded-2xl bg-white p-10 text-center ring-1 ring-gray-100">
          <Inbox className="mx-auto h-10 w-10 text-gray-300" />
          <p className="mt-3 text-sm text-gray-400">暂无询盘</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-100">
          <div className="divide-y divide-gray-50">
            {list.map((inq) => {
              const st = statusMap[inq.status];
              return (
                <button
                  key={inq.id}
                  onClick={() => setDetail(inq)}
                  className="flex w-full items-start gap-3 px-4 py-3.5 text-left transition hover:bg-gray-50"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-steel/10 text-sm font-semibold text-steel">
                    {inq.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-graphite">{inq.name}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${st.className}`}>
                        {st.label}
                      </span>
                      {inq.country && (
                        <span className="text-[11px] text-gray-400">{inq.country}</span>
                      )}
                    </div>
                    <p className="mt-0.5 line-clamp-1 text-xs text-gray-500">
                      {inq.interested_product || inq.message || "—"}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-gray-400">
                      {inq.email && <span>{inq.email}</span>}
                      {inq.whatsapp && <span>WA: {inq.whatsapp}</span>}
                      <span>{formatDate(inq.created_at)}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 详情抽屉 */}
      {detail && (
        <InquiryDetail
          inquiry={detail}
          onClose={() => setDetail(null)}
          onStatusChange={(s) => updateStatus(detail, s)}
        />
      )}
    </div>
  );
}

function InquiryDetail({
  inquiry,
  onClose,
  onStatusChange,
}: {
  inquiry: Inquiry;
  onClose: () => void;
  onStatusChange: (s: InquiryStatus) => void;
}) {
  const fields = [
    { icon: Mail, label: "邮箱", value: inquiry.email },
    { icon: Phone, label: "电话/WhatsApp", value: inquiry.whatsapp },
    { icon: Globe, label: "国家/地区", value: inquiry.country },
    { icon: Package, label: "感兴趣产品", value: inquiry.interested_product },
  ].filter((f) => f.value);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative h-full w-full max-w-md overflow-y-auto bg-white shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-100 bg-white px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-graphite">询盘详情</h2>
            <p className="text-xs text-gray-400">{formatDate(inquiry.created_at)}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="关闭">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 p-5">
          {/* 客户信息 */}
          <div>
            <h3 className="mb-3 text-xs font-medium text-gray-500">客户信息</h3>
            <div className="rounded-xl bg-gray-50 p-4">
              <div className="text-base font-semibold text-graphite">{inquiry.name}</div>
              {inquiry.company && (
                <div className="mt-0.5 text-xs text-gray-500">{inquiry.company}</div>
              )}
              <div className="mt-3 space-y-2">
                {fields.map((f) => {
                  const Icon = f.icon;
                  return (
                    <div key={f.label} className="flex items-start gap-2 text-xs">
                      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
                      <div>
                        <span className="text-gray-400">{f.label}: </span>
                        <span className="text-gray-700">{f.value}</span>
                      </div>
                    </div>
                  );
                })}
                {inquiry.quantity && (
                  <div className="flex items-start gap-2 text-xs">
                    <Package className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
                    <div>
                      <span className="text-gray-400">数量: </span>
                      <span className="text-gray-700">{inquiry.quantity}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 留言 */}
          {inquiry.message && (
            <div>
              <h3 className="mb-2 text-xs font-medium text-gray-500">留言内容</h3>
              <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-graphite whitespace-pre-wrap">
                {inquiry.message}
              </div>
            </div>
          )}

          {/* 状态切换 */}
          <div>
            <h3 className="mb-2 text-xs font-medium text-gray-500">处理状态</h3>
            <div className="grid grid-cols-3 gap-2">
              {statusOptions.map((s) => {
                const active = inquiry.status === s.value;
                return (
                  <button
                    key={s.value}
                    onClick={() => onStatusChange(s.value)}
                    className={`rounded-lg border px-2 py-2 text-xs transition ${
                      active
                        ? "border-steel bg-steel text-white"
                        : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 联系快捷 */}
          {inquiry.email && (
            <a href={`mailto:${inquiry.email}`}>
              <Button variant="secondary" className="w-full">
                <Mail className="h-4 w-4" /> 通过邮箱回复
              </Button>
            </a>
          )}
          {inquiry.whatsapp && (
            <a
              href={`https://wa.me/${inquiry.whatsapp.replace(/[^0-9]/g, "")}`}
              target="_blank"
              rel="noreferrer"
            >
              <Button className="w-full">
                <MessageCircle className="h-4 w-4" /> 通过 WhatsApp 回复
              </Button>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
