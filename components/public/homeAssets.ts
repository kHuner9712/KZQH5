const HOME_ASSET_ROOT = "/kzq-home";

export const HOME_HERO_ARTWORK = `${HOME_ASSET_ROOT}/hero-interior.jpg`;

const categoryArtwork = {
  fireproof: `${HOME_ASSET_ROOT}/category-fireproof.jpg`,
  decorative: `${HOME_ASSET_ROOT}/category-decorative.jpg`,
  engineering: `${HOME_ASSET_ROOT}/category-engineering.jpg`,
} as const;

const productArtwork: Record<string, string> = {
  "kzq-magnesium-fire-board-1220x2440x9": `${HOME_ASSET_ROOT}/product-magnesium-fire-board.jpg`,
  "kzq-fire-retardant-core-1220x2440x12": `${HOME_ASSET_ROOT}/product-fire-retardant-core.jpg`,
  "kzq-melamine-faced-panel-wood-grain": `${HOME_ASSET_ROOT}/product-melamine-wood-grain.jpg`,
  "kzq-uv-coated-panel-high-gloss": `${HOME_ASSET_ROOT}/product-uv-coated-panel.jpg`,
};

export function getHomepageCategoryArtwork(slug: string): string | null {
  const normalized = slug.toLowerCase();

  if (normalized.includes("fire") || normalized.includes("magnesium")) {
    return categoryArtwork.fireproof;
  }
  if (
    normalized.includes("decor") ||
    normalized.includes("melamine") ||
    normalized.includes("uv")
  ) {
    return categoryArtwork.decorative;
  }
  if (
    normalized.includes("engineer") ||
    normalized.includes("density") ||
    normalized.includes("ply")
  ) {
    return categoryArtwork.engineering;
  }

  return null;
}

export function getHomepageProductArtwork(slug: string): string | null {
  return productArtwork[slug] ?? null;
}
