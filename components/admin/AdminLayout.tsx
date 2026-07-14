"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { useDialogFocusTrap } from "@/lib/client/use-dialog-focus-trap";
import {
  LayoutDashboard,
  FolderTree,
  Package,
  Award,
  Building2,
  Inbox,
  LogOut,
  Menu,
  X,
  ExternalLink,
  Settings,
  LayoutTemplate,
  FileText,
  FileArchive,
  FolderKanban,
  BarChart3,
} from "lucide-react";

const navItems = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/admin/site-settings", label: "站点设置", icon: Settings },
  { href: "/admin/homepage", label: "首页内容", icon: LayoutTemplate },
  { href: "/admin/pages", label: "页面内容", icon: FileText },
  { href: "/admin/categories", label: "类目管理", icon: FolderTree },
  { href: "/admin/products", label: "产品管理", icon: Package },
  { href: "/admin/product-assets", label: "采购资料", icon: FileArchive },
  { href: "/admin/projects", label: "案例管理", icon: FolderKanban },
  { href: "/admin/certificates", label: "证书管理", icon: Award },
  { href: "/admin/company", label: "公司信息", icon: Building2 },
  { href: "/admin/inquiries", label: "询盘管理", icon: Inbox },
  { href: "/admin/analytics", label: "访问统计", icon: BarChart3 },
];

export function AdminShell({ children, email, unreadCount = 0 }: { children: React.ReactNode; email?: string; unreadCount?: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const mobileNavRef = useRef<HTMLElement>(null);
  useDialogFocusTrap({ active: sidebarOpen, containerRef: mobileNavRef, onClose: () => setSidebarOpen(false) });

  const supabase = createBrowserSupabaseClient();

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  async function handleLogout() {
    setLoggingOut(true);
    await supabase.auth.signOut();
    router.push("/admin/login");
  }

  const isActive = (href: string, exact?: boolean) =>
    exact ? pathname === href : pathname === href || pathname.startsWith(href + "/");

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 顶部栏 */}
      <header className="sticky top-0 z-40 border-b border-gray-200 bg-white">
        <div className="flex h-14 items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen((v) => !v)}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 lg:hidden"
              aria-label="菜单"
              aria-expanded={sidebarOpen}
              aria-controls="admin-mobile-navigation"
            >
              {sidebarOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-graphite text-xs font-bold text-gradient-gold">
                K
              </div>
              <span className="text-sm font-semibold text-graphite">KZQ 管理后台</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/"
              target="_blank"
              className="hidden items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-gray-500 hover:bg-gray-100 sm:flex"
            >
              <ExternalLink className="h-3.5 w-3.5" /> 查看前台
            </Link>
            <div className="hidden text-xs text-gray-500 sm:block">
              {email || "管理员"}
            </div>
            <button
              onClick={handleLogout}
              disabled={loggingOut}
              className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-gray-500 hover:bg-gray-100"
            >
              <LogOut className="h-3.5 w-3.5" /> 退出
            </button>
          </div>
        </div>
      </header>

      <div className="flex">
        {/* 侧栏 - 桌面 */}
        <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-56 shrink-0 border-r border-gray-200 bg-white lg:block">
          <SidebarNav isActive={isActive} unreadCount={unreadCount} />
        </aside>

        {/* 侧栏 - 移动端抽屉 */}
        {sidebarOpen && (
          <div className="fixed inset-0 z-30 lg:hidden">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setSidebarOpen(false)}
            />
            <aside ref={mobileNavRef} id="admin-mobile-navigation" role="dialog" aria-modal="true" aria-label="后台导航" tabIndex={-1} className="absolute left-0 top-0 h-full w-64 bg-white shadow-xl">
              <div className="flex h-14 items-center justify-between border-b border-gray-200 px-4">
                <span className="text-sm font-semibold">导航</span>
                <button onClick={() => setSidebarOpen(false)} aria-label="关闭">
                  <X className="h-5 w-5 text-gray-500" />
                </button>
              </div>
              <SidebarNav isActive={isActive} unreadCount={unreadCount} />
            </aside>
          </div>
        )}

        {/* 主内容 */}
        <main className="min-h-[calc(100vh-3.5rem)] flex-1 p-4 sm:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}

function SidebarNav({
  isActive,
  unreadCount,
}: {
  isActive: (href: string, exact?: boolean) => boolean;
  unreadCount: number;
}) {
  return (
    <nav className="space-y-1 p-3">
      {navItems.map((item) => {
        const Icon = item.icon;
        const active = isActive(item.href, item.exact);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition",
              active
                ? "bg-steel/10 font-medium text-steel"
                : "text-gray-600 hover:bg-gray-100"
            )}
          >
            <Icon className="h-4 w-4" strokeWidth={active ? 2.4 : 2} />
            <span className="flex-1">{item.label}</span>
            {item.href === "/admin/inquiries" && unreadCount > 0 && (
              <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
