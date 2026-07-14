export function PublicLoading() {
  return <div className="min-h-[65vh] bg-canvas" role="status" aria-live="polite" aria-label="正在加载 / Loading"><div className="h-52 animate-pulse bg-surface md:h-72" /><div className="container-responsive py-8"><div className="h-6 w-40 animate-pulse rounded bg-ink/10" /><div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">{Array.from({ length: 4 }).map((_, index) => <div key={index} className="aspect-[4/3] animate-pulse rounded-lg bg-ink/10" />)}</div><span className="sr-only">正在加载，请稍候。Loading, please wait.</span></div></div>;
}
