import Link from "next/link";

export default function RootNotFound() {
  return <main className="flex min-h-screen items-center justify-center bg-canvas px-6 text-center"><div><p className="text-6xl font-bold text-gold-dark">404</p><h1 className="mt-4 text-xl font-semibold text-ink">页面不存在 / Page not found</h1><p className="mt-2 text-sm leading-6 text-ink-mute">链接可能已失效，请返回首页或产品中心。<br />The link may be outdated. Return home or browse products.</p><div className="mt-6 flex justify-center gap-3"><Link href="/" className="btn-primary h-11 px-5">首页 / Home</Link><Link href="/products" className="btn-outline h-11 px-5">产品 / Products</Link></div></div></main>;
}
