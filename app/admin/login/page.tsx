import { Suspense } from "react";
import { LoginForm } from "./LoginForm";

// Server Component 入口，用 Suspense 包裹使用 useSearchParams 的客户端组件
// 避免 Next.js 生产构建报 "useSearchParams() should be wrapped in a suspense boundary"
export default function AdminLoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginFallback() {
  return (
    <div className="bg-hero-gradient relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      <div className="bg-grid pointer-events-none absolute inset-0 opacity-40" />
      <div className="relative w-full max-w-sm">
        <div className="mb-8 text-center text-white">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-white/10 text-xl font-bold text-gradient-gold">
            KZQ
          </div>
          <h1 className="mt-4 text-xl font-bold">管理后台登录</h1>
          <p className="mt-1 text-xs text-gray-400">加载中…</p>
        </div>
        <div className="rounded-2xl bg-white p-6 shadow-2xl">
          <div className="h-11 animate-pulse rounded-lg bg-gray-100" />
          <div className="mt-4 h-11 animate-pulse rounded-lg bg-gray-100" />
          <div className="mt-4 h-12 animate-pulse rounded-lg bg-gray-100" />
        </div>
      </div>
    </div>
  );
}
