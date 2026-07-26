import Link from "next/link";
import { ArrowLeft, MapPin, Tag } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ImageCarousel } from "@/components/public/ImageCarousel";
import { ProductCard } from "@/components/public/ProductCard";
import { ResponsiveContainer } from "@/components/public/ResponsiveContainer";
import { localizeProject, localizeProjectImage } from "@/lib/i18n/content";
import { localePath, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { buildLocalizedMetadata } from "@/lib/i18n/metadata";
import { getPublishedProjectBySlug } from "@/lib/repositories/projects";
import { ContextEventTracker } from "@/components/public/AnalyticsTracker";

const fetchProject = cache(getPublishedProjectBySlug);

export async function getProjectMetadata(
  locale: Locale,
  slug: string,
): Promise<Metadata> {
  const copy = getDictionary(locale).projects;
  let project: Awaited<ReturnType<typeof fetchProject>>;
  try {
    project = await fetchProject(slug);
  } catch {
    return buildLocalizedMetadata({
      locale,
      path: `/projects/${slug}`,
      title: copy.title,
      description: copy.subtitle,
    });
  }
  if (!project) {
    return {
      ...buildLocalizedMetadata({
        locale,
        path: `/projects/${slug}`,
        title: copy.empty,
        description: copy.emptyHint,
      }),
      robots: { index: false, follow: false },
    };
  }
  const content = localizeProject(project, locale);
  return buildLocalizedMetadata({
    locale,
    path: `/projects/${slug}`,
    title: content.seoTitle || content.title,
    description: content.seoDescription || content.summary || content.title,
    image: project.cover_image_url,
  });
}

export async function ProjectDetailPageContent(locale: Locale, slug: string) {
  const project = await fetchProject(slug);
  if (!project) notFound();
  const content = localizeProject(project, locale);
  const copy = getDictionary(locale).projects;
  const images = [
    ...(project.cover_image_url
      ? [{ url: project.cover_image_url, alt: content.title }]
      : []),
    ...(project.project_images || []).map((image) => ({
      url: image.image_url,
      alt: localizeProjectImage(image, locale, content.title),
    })),
  ];
  return (
    <article className="animate-fade-in bg-canvas">
      <ContextEventTracker
        eventName="project_view"
        locale={locale}
        projectId={project.id}
      />
      <div className="border-b border-white/10 bg-page">
        <ResponsiveContainer className="py-3">
          <Link
            href={localePath(locale, "/projects")}
            className="inline-flex items-center gap-2 text-xs text-white/55 hover:text-gold-light"
          >
            <ArrowLeft className="h-4 w-4" />
            {copy.title}
          </Link>
        </ResponsiveContainer>
      </div>
      <ResponsiveContainer className="py-8 md:py-16">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)] lg:gap-16">
          <div className="overflow-hidden rounded-lg border border-black/[0.06] bg-white">
            <ImageCarousel images={images} />
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-brass">
              KZQ Project
            </p>
            <h1 className="font-display mt-2 text-[30px] font-semibold leading-tight text-ink md:text-[44px]">
              {content.title}
            </h1>
            <div className="mt-4 flex flex-wrap gap-3 text-xs text-ink-mute">
              {content.projectType && (
                <span className="inline-flex items-center gap-1">
                  <Tag className="h-3.5 w-3.5" />
                  {content.projectType}
                </span>
              )}
              {content.country && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5" />
                  {content.country}
                </span>
              )}
            </div>
            {content.summary && (
              <p className="mt-5 text-base leading-7 text-ink-soft">
                {content.summary}
              </p>
            )}
          </div>
        </div>
        {content.description && (
          <section className="mt-10 max-w-4xl border-t border-ink-line pt-8 md:mt-14 md:pt-10">
            <p className="whitespace-pre-line text-sm leading-8 text-ink-soft">
              {content.description}
            </p>
          </section>
        )}
        {(project.products || []).length > 0 && (
          <section className="mt-10 border-t border-ink-line pt-8 md:mt-14 md:pt-10">
            <h2 className="text-lg font-semibold text-ink">
              {copy.relatedProducts}
            </h2>
            <div className="mt-5 grid grid-cols-2 gap-2.5 md:grid-cols-3 md:gap-5 lg:grid-cols-4">
              {project.products!.map((product) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  locale={locale}
                />
              ))}
            </div>
          </section>
        )}
      </ResponsiveContainer>
    </article>
  );
}
