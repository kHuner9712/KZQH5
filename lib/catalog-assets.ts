import type { CatalogTopic } from "@/lib/catalog-topics";
import type { ProductAsset } from "@/types/database";

function normalizeCatalogText(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function assetTimestamp(asset: ProductAsset): number {
  const value = asset.published_at || asset.created_at;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function sortCatalogAssets(assets: ProductAsset[]): ProductAsset[] {
  return [...assets].sort((a, b) => {
    const dateDifference = assetTimestamp(b) - assetTimestamp(a);
    if (dateDifference !== 0) return dateDifference;
    const sortDifference = a.sort_order - b.sort_order;
    if (sortDifference !== 0) return sortDifference;
    return Date.parse(b.created_at) - Date.parse(a.created_at);
  });
}

export function findCatalogTopicAssets(
  topic: CatalogTopic,
  assets: ProductAsset[],
): ProductAsset[] {
  const exactMatches = assets.filter(
    (asset) => asset.catalog_topic_id === topic.id,
  );
  if (exactMatches.length) return sortCatalogAssets(exactMatches);

  const aliases = [topic.titleCn, topic.titleEn, ...topic.aliases]
    .map(normalizeCatalogText)
    .filter((value) => value.length >= 4);

  const legacyMatches = assets.filter((asset) => {
    if (asset.catalog_topic_id) return false;
    const titles = [asset.title_cn, asset.title_en || ""]
      .map(normalizeCatalogText)
      .filter(Boolean);
    return titles.some((title) =>
      aliases.some(
        (alias) =>
          title === alias ||
          (alias.length >= 6 && title.includes(alias)) ||
          (title.length >= 6 && alias.includes(title)),
      ),
    );
  });

  return sortCatalogAssets(legacyMatches);
}

export function findCatalogTopicAsset(
  topic: CatalogTopic,
  assets: ProductAsset[],
): ProductAsset | null {
  return findCatalogTopicAssets(topic, assets)[0] || null;
}
