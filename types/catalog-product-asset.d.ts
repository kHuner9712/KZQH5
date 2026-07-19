import "@/types/database";

declare module "@/types/database" {
  interface ProductAsset {
    catalog_topic_id: string | null;
    cover_image_url: string | null;
    published_at: string | null;
    content_hash: string | null;
  }
}

export {};
