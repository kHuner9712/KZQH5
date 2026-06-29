import { BottomNav } from "@/components/public/BottomNav";

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto min-h-screen w-full max-w-h5 bg-[#f5f6f8] shadow-xl">
      {/* 内容区，底部留出 Tab 空间 */}
      <main className="min-h-screen pb-20">{children}</main>
      <BottomNav />
    </div>
  );
}
