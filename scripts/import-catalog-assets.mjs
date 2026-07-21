import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const updateExisting = args.has("--update-existing");
const manifestFlag = process.argv.indexOf("--manifest");
const manifestPath = path.resolve(
  process.cwd(),
  manifestFlag >= 0 && process.argv[manifestFlag + 1]
    ? process.argv[manifestFlag + 1]
    : "data/catalog-assets.json",
);
const ledgerPath = path.resolve(process.cwd(), "data/catalog-source-ledger.json");
const bucket = "public-assets";
const maxBytes = 20 * 1024 * 1024;
const allowedAssetTypes = new Set(["catalog", "datasheet", "installation", "certificate", "packaging", "other"]);
const mimeByExtension = new Map([
  [".pdf", "application/pdf"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);
const imageMimes = new Set(["image/jpeg", "image/png", "image/webp"]);

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function mimeFor(filePath) {
  return mimeByExtension.get(path.extname(filePath).toLowerCase()) || null;
}

async function loadJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readValidatedFile(filePath, { imageOnly = false } = {}) {
  const absolutePath = path.resolve(process.cwd(), filePath);
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error(`Not a file: ${filePath}`);
  if (info.size > maxBytes) throw new Error(`File exceeds 20MB: ${filePath}`);
  const mimeType = mimeFor(absolutePath);
  if (!mimeType || (imageOnly && !imageMimes.has(mimeType))) {
    throw new Error(`Unsupported file type: ${filePath}`);
  }
  const buffer = await readFile(absolutePath);
  return {
    absolutePath,
    buffer,
    hash: sha256(buffer),
    mimeType,
    extension: path.extname(absolutePath).toLowerCase(),
    size: info.size,
  };
}

function validateRow(row, index, topicIds) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Row ${index + 1} must be an object`);
  if (!topicIds.has(row.catalog_topic_id)) throw new Error(`Row ${index + 1} has invalid catalog_topic_id: ${row.catalog_topic_id}`);
  if (!allowedAssetTypes.has(row.asset_type)) throw new Error(`Row ${index + 1} has invalid asset_type: ${row.asset_type}`);
  if (!String(row.title_cn || "").trim()) throw new Error(`Row ${index + 1} is missing title_cn`);
  if (!String(row.source_file || "").trim()) throw new Error(`Row ${index + 1} is missing source_file`);
  if (row.published_at && !/^\d{4}-\d{2}-\d{2}$/.test(row.published_at)) throw new Error(`Row ${index + 1} has invalid published_at`);
}

async function uploadPublicObject(client, objectPath, file) {
  const { error } = await client.storage.from(bucket).upload(objectPath, file.buffer, {
    cacheControl: "31536000",
    contentType: file.mimeType,
    upsert: false,
  });
  if (error && !/duplicate|already exists/i.test(error.message)) throw error;
  return client.storage.from(bucket).getPublicUrl(objectPath).data.publicUrl;
}

// Maps the download manifest (object form produced by
// scripts/download-catalog-assets.mjs) into import rows. PDFs larger than the
// 20 MB upload cap are skipped here (they remain recorded in the manifest for
// reference, but cannot be uploaded to Supabase Storage as-is).
function manifestToRows(manifest, ledger) {
  const topicIds = new Set(ledger.map((item) => item.catalog_topic_id));
  const rows = [];
  for (const pdf of manifest.pdfs || []) {
    if (!pdf.pdf_valid) continue;
    if (!pdf.primary_catalog_topic_id) continue;
    if (!topicIds.has(pdf.primary_catalog_topic_id)) continue;
    if (pdf.size_bytes && pdf.size_bytes > maxBytes) continue;
    rows.push({
      catalog_topic_id: pdf.primary_catalog_topic_id,
      title_cn: pdf.title || pdf.primary_catalog_topic_id,
      title_en: pdf.title || "",
      description_cn: "",
      description_en: "",
      asset_type: "catalog",
      source_file: "./" + pdf.local_file,
      cover_file: pdf.rendered_cover ? "./" + pdf.rendered_cover : undefined,
      published_at: pdf.downloaded_at || "",
      sort_order: 10,
      is_published: false,
    });
  }
  return rows;
}

async function main() {
  const [rawManifest, ledger] = await Promise.all([
    loadJson(manifestPath),
    loadJson(ledgerPath),
  ]);
  if (!Array.isArray(ledger)) throw new Error("Catalog source ledger must be an array");
  // Accept both the legacy array manifest and the object manifest produced by
  // scripts/download-catalog-assets.mjs ({ pdfs, covers, stats, ... }).
  const manifest = Array.isArray(rawManifest)
    ? rawManifest
    : Array.isArray(rawManifest && rawManifest.pdfs)
      ? manifestToRows(rawManifest, ledger)
      : [];
  const topicIds = new Set(ledger.map((item) => item.catalog_topic_id));
  const duplicateTopics = ledger
    .map((item) => item.catalog_topic_id)
    .filter((id, index, values) => values.indexOf(id) !== index);
  if (duplicateTopics.length)
    throw new Error(`Duplicate topic IDs in source ledger: ${duplicateTopics.join(", ")}`);

  manifest.forEach((row, index) => validateRow(row, index, topicIds));

  let client = null;
  if (apply) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceRole) throw new Error("--apply requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    client = createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  const result = { created: 0, updated: 0, skipped: 0, failed: 0 };
  console.log(`[catalog-import] mode=${apply ? "apply" : "dry-run"} manifest=${path.relative(process.cwd(), manifestPath)} rows=${manifest.length}`);

  for (const [index, row] of manifest.entries()) {
    try {
      const source = await readValidatedFile(row.source_file);
      const cover = row.cover_file ? await readValidatedFile(row.cover_file, { imageOnly: true }) : null;
      const sourceName = `${source.hash}${source.extension}`;
      const coverName = cover ? `${cover.hash}${cover.extension}` : null;
      const sourceObjectPath = `documents/catalogs/${row.catalog_topic_id}/${sourceName}`;
      const coverObjectPath = coverName ? `document-covers/${row.catalog_topic_id}/${coverName}` : null;

      if (!apply) {
        console.log(`[dry-run] ${index + 1}/${manifest.length} ${row.catalog_topic_id} ${path.basename(row.source_file)} sha256=${source.hash}`);
        result.skipped += 1;
        continue;
      }

      const { data: existing, error: lookupError } = await client
        .from("product_assets")
        .select("id")
        .eq("content_hash", source.hash)
        .limit(1)
        .maybeSingle();
      if (lookupError) throw lookupError;
      if (existing && !updateExisting) {
        console.log(`[skip] ${row.catalog_topic_id} already imported with the same hash`);
        result.skipped += 1;
        continue;
      }

      const fileUrl = await uploadPublicObject(client, sourceObjectPath, source);
      const coverUrl = cover && coverObjectPath ? await uploadPublicObject(client, coverObjectPath, cover) : null;
      const payload = {
        product_id: row.product_id || null,
        asset_type: row.asset_type,
        catalog_topic_id: row.catalog_topic_id,
        title_cn: String(row.title_cn).trim(),
        title_en: String(row.title_en || "").trim() || null,
        description_cn: String(row.description_cn || "").trim() || null,
        description_en: String(row.description_en || "").trim() || null,
        file_url: fileUrl,
        cover_image_url: coverUrl,
        file_size: source.size,
        mime_type: source.mimeType,
        published_at: row.published_at || null,
        content_hash: source.hash,
        sort_order: Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : 0,
        is_published: row.is_published === true,
      };

      if (existing) {
        const { error } = await client.from("product_assets").update(payload).eq("id", existing.id);
        if (error) throw error;
        result.updated += 1;
        console.log(`[updated] ${row.catalog_topic_id}`);
      } else {
        const { error } = await client.from("product_assets").insert(payload);
        if (error) throw error;
        result.created += 1;
        console.log(`[created] ${row.catalog_topic_id}`);
      }
    } catch (error) {
      result.failed += 1;
      console.error(`[failed] row ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`[catalog-import] created=${result.created} updated=${result.updated} skipped=${result.skipped} failed=${result.failed}`);
  if (result.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[catalog-import] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
