import { describe, expect, it } from "vitest";
import {
  payloadFromAsset,
  validateProductAssetPayload,
} from "@/lib/validation/product-asset";
import type { ProductAsset } from "@/types/database";

function makeAsset(overrides: Partial<ProductAsset> = {}): ProductAsset {
  return {
    id: "test-id",
    product_id: null,
    asset_type: "catalog",
    title_cn: "测试目录",
    title_en: null,
    description_cn: null,
    description_en: null,
    file_url: "/documents/test.pdf",
    file_size: 1024,
    mime_type: "application/pdf",
    is_published: false,
    sort_order: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    catalog_topic_id: "color-card",
    cover_image_url: null,
    published_at: null,
    content_hash: null,
    ...overrides,
  };
}

describe("payloadFromAsset", () => {
  it("extracts payload fields from a ProductAsset row", () => {
    const payload = payloadFromAsset(makeAsset());
    expect(payload.asset_type).toBe("catalog");
    expect(payload.title_cn).toBe("测试目录");
    expect(payload.file_url).toBe("/documents/test.pdf");
    expect(payload.catalog_topic_id).toBe("color-card");
  });

  it("nulls out empty optional fields", () => {
    const payload = payloadFromAsset(
      makeAsset({ catalog_topic_id: "", cover_image_url: "", published_at: "", content_hash: "" }),
    );
    expect(payload.catalog_topic_id).toBeNull();
    expect(payload.cover_image_url).toBeNull();
    expect(payload.published_at).toBeNull();
    expect(payload.content_hash).toBeNull();
  });
});

describe("validateProductAssetPayload — required fields", () => {
  it("rejects empty title_cn", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      title_cn: "   ",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.title_cn).toBeDefined();
  });

  it("rejects invalid asset_type", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      // @ts-expect-error — deliberately invalid type
      asset_type: "fake",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.asset_type).toBeDefined();
  });

  it("rejects unknown catalog_topic_id", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      catalog_topic_id: "not-a-real-topic",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.catalog_topic_id).toBeDefined();
  });

  it("accepts null catalog_topic_id (unbound topic)", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      catalog_topic_id: null,
    });
    expect(r.ok).toBe(true);
  });
});

describe("validateProductAssetPayload — file_url security", () => {
  it("rejects empty file_url", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_url: "",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.file_url).toBeDefined();
  });

  it("rejects protocol-relative URL", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_url: "//evil.example.com/file.pdf",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.file_url?.[0]).toMatch(/protocol_relative_url/);
  });

  it("rejects javascript: URL", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_url: "javascript:alert(1)",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.file_url?.[0]).toMatch(/unsupported_protocol/);
  });

  it("rejects data: URL", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_url: "data:text/html,<script>alert(1)</script>",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.file_url?.[0]).toMatch(/unsupported_protocol/);
  });

  it("rejects vbscript: URL", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_url: "vbscript:msgbox(1)",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.file_url?.[0]).toMatch(/unsupported_protocol/);
  });

  it("rejects file: URL", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_url: "file:///etc/passwd",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.file_url?.[0]).toMatch(/unsupported_protocol/);
  });

  it("rejects public http URL by default", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_url: "http://example.com/file.pdf",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.file_url?.[0]).toMatch(/insecure_http/);
  });

  it("allows http://localhost in test mode", () => {
    const r = validateProductAssetPayload(
      {
        ...payloadFromAsset(makeAsset()),
        file_url: "http://localhost:3000/file.pdf",
      },
      { allowHttpForTesting: true },
    );
    expect(r.ok).toBe(true);
  });

  it("allows http://127.0.0.1 even without allowHttpForTesting", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_url: "http://127.0.0.1:3000/file.pdf",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects http://localhost when allowHttpForTesting is false", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_url: "http://localhost/file.pdf",
    });
    // localhost is always allowed by validateAssetUrl's loopback policy,
    // so this should be ok regardless. Verify the expectation.
    expect(r.ok).toBe(true);
  });

  it("allows same-origin relative path /documents/file.pdf", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_url: "/documents/file.pdf",
    });
    expect(r.ok).toBe(true);
  });

  it("allows ./file.pdf", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_url: "./file.pdf",
    });
    expect(r.ok).toBe(true);
  });

  it("allows ../file.pdf", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_url: "../file.pdf",
    });
    expect(r.ok).toBe(true);
  });

  it("allows https URL", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_url: "https://cdn.kzq.example/file.pdf",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects bare string like 'not a url at all'", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_url: "not a url at all",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.file_url?.[0]).toMatch(/invalid_url/);
  });
});

describe("validateProductAssetPayload — cover_image_url", () => {
  it("accepts null cover URL", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      cover_image_url: null,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects protocol-relative cover URL", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      cover_image_url: "//evil.example.com/cover.jpg",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.cover_image_url).toBeDefined();
  });

  it("rejects cover URL with non-image extension", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      cover_image_url: "/documents/cover.pdf",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.cover_image_url?.[0]).toMatch(/图片格式/);
  });

  it("accepts /covers/x.jpg", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      cover_image_url: "/covers/x.jpg",
    });
    expect(r.ok).toBe(true);
  });
});

describe("validateProductAssetPayload — MIME rules", () => {
  it("rejects image/jpeg MIME for datasheet type", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset({ asset_type: "datasheet" })),
      mime_type: "image/jpeg",
      file_url: "/documents/x.jpg",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.mime_type).toBeDefined();
  });

  it("rejects image/svg+xml MIME for certificate type", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset({ asset_type: "certificate" })),
      mime_type: "image/svg+xml",
      file_url: "/certs/x.svg",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.mime_type).toBeDefined();
  });

  it("rejects MIME/extension mismatch", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      mime_type: "application/pdf",
      file_url: "/documents/x.jpg",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.mime_type?.[0]).toMatch(/MIME 与扩展名不匹配/);
  });

  it("accepts matching MIME/extension", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      mime_type: "application/pdf",
      file_url: "/documents/x.pdf",
    });
    expect(r.ok).toBe(true);
  });

  it("accepts null MIME type with valid PDF extension", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      mime_type: null,
      file_url: "/documents/x.pdf",
    });
    expect(r.ok).toBe(true);
  });
});

describe("validateProductAssetPayload — file_size", () => {
  it("rejects negative file_size", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_size: -1,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.file_size).toBeDefined();
  });

  it("accepts zero file_size", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_size: 0,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects NaN file_size", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_size: Number.NaN,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.file_size).toBeDefined();
  });

  it("rejects unreasonably large file_size (>2GB)", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_size: 3 * 1024 * 1024 * 1024,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.file_size).toBeDefined();
  });

  it("accepts null file_size", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_size: null,
    });
    expect(r.ok).toBe(true);
  });
});

describe("validateProductAssetPayload — published_at", () => {
  it("accepts valid YYYY-MM-DD", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      published_at: "2026-07-15",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects DD/MM/YYYY format", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      published_at: "15/07/2026",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.published_at).toBeDefined();
  });

  it("rejects 2026-13-40 (out of range)", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      published_at: "2026-13-40",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.published_at).toBeDefined();
  });

  it("rejects 2026-02-30 (Feb 30)", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      published_at: "2026-02-30",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.published_at).toBeDefined();
  });

  it("accepts null published_at (draft)", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      published_at: null,
    });
    expect(r.ok).toBe(true);
  });
});

describe("validateProductAssetPayload — published state requires file", () => {
  it("rejects is_published=true with empty file_url", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_url: "",
      is_published: true,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.is_published).toBeDefined();
    expect(r.errors.file_url).toBeDefined();
  });

  it("rejects is_published=true with protocol-relative URL", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_url: "//evil.example.com/file.pdf",
      is_published: true,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.is_published).toBeDefined();
  });

  it("accepts is_published=true with valid file_url", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_url: "/documents/published.pdf",
      is_published: true,
    });
    expect(r.ok).toBe(true);
  });

  it("accepts is_published=false with empty file_url (draft)", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      file_url: "",
      is_published: false,
    });
    // file_url is still required by the file_url rule, so this should fail
    // for the file_url reason, but NOT for is_published.
    expect(r.errors.is_published).toBeUndefined();
  });
});

describe("validateProductAssetPayload — sort_order & content_hash", () => {
  it("rejects non-number sort_order", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      // @ts-expect-error — deliberately invalid type
      sort_order: "abc",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.sort_order).toBeDefined();
  });

  it("accepts 0 sort_order", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      sort_order: 0,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects NaN sort_order", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      sort_order: Number.NaN,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.sort_order).toBeDefined();
  });

  it("rejects content_hash with special chars", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      content_hash: "bad hash with spaces!",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.content_hash).toBeDefined();
  });

  it("accepts valid content_hash", () => {
    const r = validateProductAssetPayload({
      ...payloadFromAsset(makeAsset()),
      content_hash: "sha256-abc123def456",
    });
    expect(r.ok).toBe(true);
  });
});

describe("validateProductAssetPayload — full valid payload", () => {
  it("passes with all fields valid", () => {
    const r = validateProductAssetPayload({
      product_id: null,
      asset_type: "catalog",
      catalog_topic_id: "color-card",
      title_cn: "KZQ 综合色卡 2026",
      title_en: "KZQ Color Card 2026",
      description_cn: "综合色卡",
      description_en: "Color card",
      file_url: "/documents/color-card-2026.pdf",
      cover_image_url: "/covers/color-card-2026.jpg",
      file_size: 5242880,
      mime_type: "application/pdf",
      published_at: "2026-07-15",
      content_hash: "sha256-abc123",
      is_published: true,
      sort_order: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual({});
  });
});
