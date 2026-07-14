import Link from "next/link";
import { ArrowUpRight, FolderKanban } from "lucide-react";
import type { Metadata } from "next";
import { EmptyState } from "@/components/public/EmptyState";
import { ProductImage } from "@/components/public/ProductImage";
import { ResponsiveContainer } from "@/components/public/ResponsiveContainer";
import { localizeProject } from "@/lib/i18n/content";
import { localePath, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { buildLocalizedMetadata } from "@/lib/i18n/metadata";
import { getPublishedProjects } from "@/lib/repositories/projects";

export async function getProjectsMetadata(locale: Locale): Promise<Metadata> {
  const copy = getDictionary(locale).projects;
  return buildLocalizedMetadata({ locale, path: "/projects", title: copy.title, description: copy.subtitle });
}

export async function ProjectsPageContent(locale: Locale) {
  const projects = await getPublishedProjects();
  const copy = getDictionary(locale).projects;
  return (
    <div className="animate-fade-in bg-canvas">
      <section className="bg-canvas-warm texture-paper"><ResponsiveContainer className="pb-7 pt-10 md:pb-11 md:pt-16"><p className="text-[10px] uppercase tracking-[0.22em] text-brass">Projects</p><h1 className="mt-2 text-2xl font-bold text-ink md:text-4xl">{copy.title}</h1><p className="mt-2 text-sm text-ink-soft">{copy.subtitle}</p></ResponsiveContainer></section>
      <ResponsiveContainer className="py-6 md:py-10">
        {projects.length ? <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{projects.map((project) => { const content = localizeProject(project, locale); return <article key={project.id} className="card-base group overflow-hidden"><Link href={localePath(locale, `/projects/${project.slug}`)}><div className="relative aspect-[16/10] overflow-hidden"><ProductImage src={project.cover_image_url} alt={content.title} sizes="(max-width: 768px) 100vw, 33vw" />{project.is_featured && <span className="absolute left-3 top-3 rounded bg-page/85 px-2 py-1 text-[10px] text-gold-light">{copy.featured}</span>}</div><div className="p-4"><div className="flex items-start justify-between gap-3"><div><h2 className="text-base font-semibold text-ink">{content.title}</h2><p className="mt-1 text-[11px] text-ink-mute">{[content.projectType, content.country].filter(Boolean).join(" · ")}</p></div><ArrowUpRight className="h-4 w-4 shrink-0 text-brass" /></div>{content.summary && <p className="mt-3 line-clamp-3 text-sm leading-6 text-ink-soft">{content.summary}</p>}</div></Link></article>; })}</div> : <EmptyState icon={FolderKanban} title={copy.empty} description={copy.emptyHint} />}
      </ResponsiveContainer>
    </div>
  );
}
