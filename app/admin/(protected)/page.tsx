import Link from "next/link";
import { unstable_noStore as noStore } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminDashboardQueries } from "@/lib/repositories/admin-dashboard";
import { loadAdminDashboard } from "@/lib/services/admin-dashboard";
import { formatDate } from "@/lib/utils";
import {
  Package,
  CheckCircle2,
  Award,
  Inbox,
  ArrowRight,
  Clock,
} from "lucide-react";
import type { Inquiry } from "@/types/database";

export const dynamic = "force-dynamic";

export default async function AdminDashboard() {
  noStore();
  const supabase = await createServerSupabaseClient();
  const result = await loadAdminDashboard(
    createAdminDashboardQueries(supabase),
  );

  if (!result.ok) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-bold text-graphite">Dashboard</h1>
          <p className="mt-1 text-sm text-gray-500">KZQ 产品展示站数据概览</p>
        </div>
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-5 py-8 text-center"
        >
          <p className="font-medium text-red-800">数据读取失败</p>
          <p className="mt-1 text-sm text-red-700">
            请稍后刷新页面；如问题持续，请联系管理员检查服务端日志。
          </p>
        </div>
      </div>
    );
  }

  const {
    productCount,
    publishedCount,
    certificateCount: certCount,
    inquiryCount,
    unreadCount,
    recentInquiries,
  } = result.data;

  const stats = [
    {
      label: "产品总数",
      value: productCount,
      icon: Package,
      color: "text-steel",
      bg: "bg-steel/10",
    },
    {
      label: "已发布产品",
      value: publishedCount,
      icon: CheckCircle2,
      color: "text-emerald-600",
      bg: "bg-emerald-50",
    },
    {
      label: "证书数量",
      value: certCount,
      icon: Award,
      color: "text-gold-dark",
      bg: "bg-gold/15",
    },
    {
      label: `询盘数量 · 未读 ${unreadCount}`,
      value: inquiryCount,
      icon: Inbox,
      color: "text-purple-600",
      bg: "bg-purple-50",
    },
  ];

  const inquiries = recentInquiries;

  const statusMap: Record<string, { label: string; className: string }> = {
    new: { label: "新询盘", className: "bg-blue-50 text-blue-700" },
    contacted: { label: "已联系", className: "bg-amber-50 text-amber-700" },
    closed: { label: "已关闭", className: "bg-gray-100 text-gray-600" },
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-graphite">Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">KZQ 产品展示站数据概览</p>
      </div>

      {/* 统计卡 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <div
              key={s.label}
              className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-100"
            >
              <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${s.bg}`}>
                <Icon className={`h-5 w-5 ${s.color}`} />
              </div>
              <p className="mt-3 text-2xl font-bold text-graphite">{s.value}</p>
              <p className="text-xs text-gray-500">{s.label}</p>
            </div>
          );
        })}
      </div>

      {/* 最近询盘 */}
      <div className="rounded-2xl bg-white shadow-sm ring-1 ring-gray-100">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <h2 className="text-sm font-semibold text-graphite">最近询盘</h2>
          <Link
            href="/admin/inquiries"
            className="inline-flex items-center gap-1 text-xs text-steel hover:underline"
          >
            查看全部 <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
        {inquiries.length > 0 ? (
          <div className="divide-y divide-gray-50">
            {inquiries.map((inq) => {
              const st = statusMap[inq.status] || statusMap.new;
              return (
                <Link
                  key={inq.id}
                  href="/admin/inquiries"
                  className="flex items-start gap-3 px-5 py-3.5 transition hover:bg-gray-50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-graphite">
                        {inq.name}
                      </span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${st.className}`}>
                        {st.label}
                      </span>
                      {!inq.is_read && (
                        <span className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] text-red-700">未读</span>
                      )}
                    </div>
                    <p className="mt-0.5 line-clamp-1 text-xs text-gray-500">
                      {inq.interested_product || inq.message || "—"}
                    </p>
                    <p className="mt-1 flex items-center gap-1 text-[11px] text-gray-400">
                      <Clock className="h-3 w-3" /> {formatDate(inq.created_at)}
                      {inq.country && <span>· {inq.country}</span>}
                    </p>
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="px-5 py-10 text-center text-sm text-gray-400">
            暂无询盘
          </div>
        )}
      </div>

      {/* 快捷入口 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <QuickLink href="/admin/products/new" label="新增产品" desc="创建产品并上传图片" />
        <QuickLink href="/admin/certificates" label="上传证书" desc="管理资质展示" />
        <QuickLink href="/admin/company" label="编辑公司信息" desc="更新联系方式与介绍" />
      </div>
    </div>
  );
}

function QuickLink({ href, label, desc }: { href: string; label: string; desc: string }) {
  return (
    <Link
      href={href}
      className="group rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-100 transition hover:shadow-md"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-graphite">{label}</span>
        <ArrowRight className="h-4 w-4 text-gray-400 transition group-hover:translate-x-0.5 group-hover:text-steel" />
      </div>
      <p className="mt-1 text-xs text-gray-500">{desc}</p>
    </Link>
  );
}
