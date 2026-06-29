import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-graphite px-6 text-center text-white">
      <div className="bg-grid pointer-events-none absolute inset-0 opacity-30" />
      <p className="text-gradient-gold relative text-7xl font-bold">404</p>
      <h1 className="relative mt-4 text-xl font-semibold">页面未找到</h1>
      <p className="relative mt-2 text-sm text-gray-400">
        您访问的页面不存在或已下架。
      </p>
      <Link
        href="/"
        className="relative mt-8 rounded-lg bg-steel px-6 py-3 text-sm font-medium text-white transition hover:bg-steel-dark"
      >
        返回首页
      </Link>
    </div>
  );
}
