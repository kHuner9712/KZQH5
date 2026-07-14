import Link from "next/link";
import { redirect } from "next/navigation";
import { BarChart3, Eye, MousePointerClick, PackageSearch, Send } from "lucide-react";
import { getAnalyticsSummary } from "@/lib/repositories/analytics";
import { getVerifiedAdmin } from "@/lib/services/admin-auth";

export const dynamic = "force-dynamic";

interface SearchParams { range?: string; from?: string; to?: string }

function validDate(value?: string): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()));
}

function dateRange(params: SearchParams) {
  const end = new Date();
  if (params.range === "custom" && validDate(params.from) && validDate(params.to)) {
    const start = new Date(`${params.from}T00:00:00.000Z`);
    const exclusiveEnd = new Date(`${params.to}T00:00:00.000Z`);
    exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
    if (start < exclusiveEnd) return { start, end: exclusiveEnd, label: `${params.from} 至 ${params.to}` };
  }
  const days = [7, 30, 90].includes(Number(params.range)) ? Number(params.range) : 30;
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { start, end, label: `最近 ${days} 天` };
}

function decodeSearchTerm(value: string) {
  try { return decodeURIComponent(value.replace(/\+/g, " ")); } catch { return value; }
}

export default async function AnalyticsPage({ searchParams }: { searchParams: SearchParams }) {
  const admin = await getVerifiedAdmin();
  if (!admin) redirect("/admin/login?error=no_permission");
  const range = dateRange(searchParams);
  let summary;
  try {
    summary = await getAnalyticsSummary(admin.client, range.start, range.end);
  } catch (error) {
    console.error("Analytics summary failed:", error instanceof Error ? error.message : "unknown error");
    return <div className="rounded-2xl bg-white p-8 text-center ring-1 ring-gray-100" role="alert"><h1 className="text-lg font-semibold text-graphite">统计暂时不可用</h1><p className="mt-2 text-sm text-gray-500">请确认已执行最新 migration，或稍后重试。</p><Link href="/admin/analytics" className="mt-5 inline-flex h-11 items-center rounded-lg bg-steel px-5 text-sm text-white">重试</Link></div>;
  }
  const cards = [
    { label: "页面浏览", value: summary.page_views, icon: Eye },
    { label: "产品浏览", value: summary.product_views, icon: PackageSearch },
    { label: "联系方式点击", value: summary.contact_clicks, icon: MousePointerClick },
    { label: "询盘成功", value: summary.inquiry_successes, icon: Send },
  ];
  return <div className="space-y-6">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><h1 className="flex items-center gap-2 text-xl font-bold text-graphite"><BarChart3 className="h-5 w-5" />访问统计</h1><p className="mt-1 text-sm text-gray-500">第一方匿名事件 · {range.label}</p></div><div className="flex flex-wrap gap-2">{[7, 30, 90].map((days) => <Link key={days} href={`/admin/analytics?range=${days}`} className={`inline-flex h-10 items-center rounded-lg border px-3 text-xs ${searchParams.range === String(days) || (!searchParams.range && days === 30) ? "border-steel bg-steel text-white" : "border-gray-200 bg-white text-gray-600"}`}>{days} 天</Link>)}</div></div>
    <form className="grid gap-3 rounded-2xl bg-white p-4 ring-1 ring-gray-100 sm:grid-cols-[1fr_1fr_auto]"><label className="text-xs text-gray-500">开始日期<input name="from" type="date" defaultValue={searchParams.from} className="mt-1 h-10 w-full rounded-lg border border-gray-200 px-3 text-sm" /></label><label className="text-xs text-gray-500">结束日期<input name="to" type="date" defaultValue={searchParams.to} className="mt-1 h-10 w-full rounded-lg border border-gray-200 px-3 text-sm" /></label><input type="hidden" name="range" value="custom" /><button className="h-10 self-end rounded-lg bg-steel px-5 text-sm text-white">应用范围</button></form>
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{cards.map(({ label, value, icon: Icon }) => <div key={label} className="rounded-2xl bg-white p-5 ring-1 ring-gray-100"><Icon className="h-5 w-5 text-steel" /><p className="mt-3 text-2xl font-bold text-graphite">{value}</p><p className="text-xs text-gray-500">{label}</p></div>)}</div>
    <div className="grid gap-6 xl:grid-cols-2">
      <StatsTable title="热门产品" headers={["产品", "浏览"]} rows={summary.popular_products.map((row) => [row.name, row.count])} />
      <StatsTable title="热门搜索词" headers={["搜索词", "次数"]} rows={summary.popular_searches.map((row) => [decodeSearchTerm(row.term), row.count])} />
      <StatsTable title="来源" headers={["来源", "事件数"]} rows={summary.sources.map((row) => [row.source, row.count])} />
      <StatsTable title="UTM" headers={["来源 / 媒介 / 活动", "事件数"]} rows={summary.utm.map((row) => [`${row.source} / ${row.medium} / ${row.campaign}`, row.count])} />
    </div>
  </div>;
}

function StatsTable({ title, headers, rows }: { title: string; headers: [string, string]; rows: Array<[string, number]> }) {
  return <section className="overflow-hidden rounded-2xl bg-white ring-1 ring-gray-100"><h2 className="border-b border-gray-100 px-5 py-4 text-sm font-semibold text-graphite">{title}</h2>{rows.length ? <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-gray-50 text-xs text-gray-500"><tr><th className="px-5 py-3 font-medium">{headers[0]}</th><th className="px-5 py-3 text-right font-medium">{headers[1]}</th></tr></thead><tbody className="divide-y divide-gray-100">{rows.map(([label, count], index) => <tr key={`${label}-${index}`}><td className="max-w-md break-words px-5 py-3 text-gray-700">{label}</td><td className="px-5 py-3 text-right font-medium text-graphite">{count}</td></tr>)}</tbody></table></div> : <p className="px-5 py-8 text-center text-sm text-gray-400">当前范围暂无数据</p>}</section>;
}
