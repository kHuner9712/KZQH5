export default function Loading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-steel border-t-transparent" />
        <p className="text-sm text-gray-500">加载中…</p>
      </div>
    </div>
  );
}
