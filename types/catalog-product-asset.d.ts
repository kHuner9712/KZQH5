import "@/types/database";

declare module "@/types/database" {
  interface ProductAsset {
    catalog_topic_id: string | null;
    cover_image_url: string | null;
    published_at: string | null;
    content_hash: string | null;
    // Phase 12: authorization metadata
    access_level: ProductAssetAccessLevel;
    source_type: ProductAssetSourceType | null;
    authorization_status: ProductAssetAuthorizationStatus;
  }
}

export {};
