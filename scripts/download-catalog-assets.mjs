#!/usr/bin/env node
// scripts/download-catalog-assets.mjs
//
// Downloads publicly accessible BAIJAX catalog PDFs and official cover images,
// verifies each file (HTTP status, MIME, size, SHA-256, PDF integrity, page
// count) and renders the first page of every PDF to a JPEG cover.
//
// Default mode is DRY-RUN: it lists the plan and probes URLs without writing
// any file. Pass --apply to actually download.
//
// Safety rules baked in:
//   - Never attempts password-protected or login-walled sources.
//   - Never tries to crack/bypass access controls.
//   - Continues on a single URL failure; records the reason.
//   - Skips already-downloaded valid files (resume) unless --force.
//   - SHA-256 dedup: a second URL whose body matches an existing hash is skipped.
//
// Output:
//   data/catalog-source-files/pdfs/      downloaded PDFs
//   data/catalog-source-files/covers/    downloaded official covers
//   data/catalog-source-files/rendered/  first-page JPEG renders of each PDF
//   data/catalog-assets.json             verified-asset manifest + stats

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, stat, access, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import process from "node:process";

const execFileAsync = promisify(execFile);

const ROOT = process.cwd();
const PDF_DIR = path.join(ROOT, "data/catalog-source-files/pdfs");
const COVER_DIR = path.join(ROOT, "data/catalog-source-files/covers");
const RENDER_DIR = path.join(ROOT, "data/catalog-source-files/rendered");
const ASSETS_JSON = path.join(ROOT, "data/catalog-assets.json");

// 100 MB hard cap for a single download (well above the 20 MB Supabase upload
// limit, but still protects against runaway transfers).
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
// 10 min per file — slow international links can take several minutes for the
// larger color-card PDFs (~60 MB).
const HTTP_TIMEOUT_MS = 600_000;
// Chunked-download tuning. The BAIJAX Saint Petersburg host throttles each
// TCP connection to a small burst (~27 KB) before stalling to a crawl, but
// fresh connections get the burst again. Downloading in small fixed-size
// range requests with a pool of parallel workers works around this: each
// 16 KB chunk completes inside the burst window, and parallelism multiplies
// throughput. Measured: ~71 KB/s with 8 workers.
const CHUNK_SIZE = 16 * 1024; // 16 KB — under the per-connection burst window
const CHUNK_CONCURRENCY = 10; // parallel range workers per file
const SMALL_FILE_THRESHOLD = 256 * 1024; // below this, download in one shot
const PER_FILE_BUDGET_MS = 540_000; // ~9 min cap per file
const USER_AGENT =
  "KZQ-Catalog-Downloader/1.0 (+public catalog asset verification; contact: repo maintainer)";

// Sources that must NOT be downloaded: platform-read-only or password-walled.
// These are recorded as "excluded" with a reason, never fetched.
const EXCLUDED_SOURCES = [
  {
    match: (url) => /^https?:\/\/([^/]+\.)?scribd\.com\//i.test(url),
    reason: "platform_read_only_scribd",
  },
  {
    match: (url) => /baijiaxiang\.(net|ru)\/.*PRODUCTDOCUMENT/i.test(url),
    reason: "password_protected_listing_page",
  },
];

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const getParam = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  return {
    apply: flags.has("--apply"),
    force: flags.has("--force"),
    skipRender: flags.has("--skip-render"),
    only: getParam("only"), // limit to "pdfs" or "covers"
    help: flags.has("--help") || flags.has("-h"),
  };
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function slugFromUrl(url) {
  try {
    const u = new URL(url);
    const base = path
      .basename(u.pathname)
      .replace(/\.(pdf|webp|jpg|jpeg|png)$/i, "")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "");
    return base || "catalog";
  } catch {
    return "catalog-" + sha256(Buffer.from(url)).slice(0, 8);
  }
}

function extFromUrl(url, fallback) {
  try {
    const u = new URL(url);
    const ext = path.extname(u.pathname).toLowerCase();
    return ext || fallback;
  } catch {
    return fallback;
  }
}

async function loadJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function excludeReason(url) {
  for (const rule of EXCLUDED_SOURCES) {
    if (rule.match(url)) return rule.reason;
  }
  return null;
}

// Build the download plan from the curated JSON manifests.
async function buildPlan() {
  const russia = await loadJson(path.join(ROOT, "data/catalog-public-library-russia.json"));
  const pdfLinks = await loadJson(path.join(ROOT, "data/catalog-public-pdf-links.json"));
  const covers = await loadJson(path.join(ROOT, "data/catalog-official-current-covers.json"));
  const newCovers = await loadJson(
    path.join(ROOT, "data/catalog-official-new-product-covers.json"),
  );

  const pdfs = [];
  const seenUrls = new Set();

  // Tier 1 — Russia official representative public direct PDFs (highest confidence)
  if (russia && Array.isArray(russia.documents)) {
    for (const doc of russia.documents) {
      if (doc.access !== "public_direct_pdf") continue;
      if (seenUrls.has(doc.url)) continue;
      seenUrls.add(doc.url);
      pdfs.push({
        url: doc.url,
        title: doc.title,
        topic_ids: Array.isArray(doc.topic_ids) ? doc.topic_ids : [],
        source_origin: "russia_official_representative",
        access: doc.access,
        tier: 1,
        note: doc.status || "",
      });
    }
  }

  // Tier 2 — Candidate public PDF links (search-indexed; may fail)
  if (Array.isArray(pdfLinks)) {
    for (const doc of pdfLinks) {
      if (seenUrls.has(doc.url)) continue;
      seenUrls.add(doc.url);
      pdfs.push({
        url: doc.url,
        title: doc.title,
        topic_ids: doc.catalog_topic_id ? [doc.catalog_topic_id] : [],
        source_origin: doc.source || "candidate",
        access: doc.access || "candidate",
        tier: 2,
        note: `version=${doc.version || "unknown"}`,
      });
    }
  }

  const coverList = [];
  if (covers && Array.isArray(covers.covers)) {
    for (const c of covers.covers) {
      coverList.push({
        url: c.cover_url,
        title: c.title,
        catalog_topic_id: c.catalog_topic_id,
        source_origin: "official_current_cover",
      });
    }
  }
  // Bonus: official new-product covers (not tied to a single topic)
  if (newCovers && Array.isArray(newCovers.covers)) {
    for (const c of newCovers.covers) {
      coverList.push({
        url: c.cover_url,
        title: c.title,
        catalog_topic_id: null,
        source_origin: "official_new_product_cover",
      });
    }
  }

  return { pdfs, covers: coverList };
}

// Probe a URL with HEAD (fallback to GET-range) to learn status/size/type.
async function probeUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT },
    });
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get("content-type") || "",
      contentLength: Number(res.headers.get("content-length") || 0),
    };
  } catch (e) {
    // Some servers reject HEAD; fall back to a tiny range GET.
    try {
      const res2 = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT, range: "bytes=0-0" },
      });
      return {
        ok: res2.ok || res2.status === 206,
        status: res2.status,
        contentType: res2.headers.get("content-type") || "",
        contentLength: Number(
          (res2.headers.get("content-range") || "").split("/")[1] ||
            res2.headers.get("content-length") ||
            0,
        ),
      };
    } catch (e2) {
      return { ok: false, status: 0, reason: e2.message };
    }
  } finally {
    clearTimeout(timer);
  }
}

// Fetch a single fixed-size byte range via curl (curl handles the TLS stack
// to baijiaxiang.spb.ru reliably; Node's undici fetch stalls on this host).
// Returns the chunk body as a Buffer, or throws on failure.
async function fetchRange(url, start, end) {
  const { stdout } = await execFileAsync(
    "curl",
    ["-sL", "--http1.1", "--max-time", "20", "-r", `${start}-${end}`, url],
    { encoding: "buffer", maxBuffer: 2 * CHUNK_SIZE, timeout: 25_000 },
  );
  return stdout;
}

// Download a file fully to destPath. Small files are fetched in one shot;
// larger files use parallel fixed-size range requests to work around the
// per-connection throttling on the BAIJAX Saint Petersburg host. Returns
// { ok, status, buffer, contentType, size } with the buffer on success.
async function downloadFile(url, destPath, { contentLength = 0, contentType = "" } = {}) {
  // Resolve size/type via a probe if the caller didn't supply them.
  if (!contentLength || !contentType) {
    const probe = await probeUrl(url);
    contentLength = probe.contentLength || 0;
    contentType = probe.contentType || "";
    if (!probe.ok) return { ok: false, status: probe.status, reason: probe.reason || `HTTP ${probe.status}` };
  }
  if (contentLength && contentLength > MAX_DOWNLOAD_BYTES) {
    return { ok: false, status: 200, reason: `file exceeds ${MAX_DOWNLOAD_BYTES} bytes (declared ${contentLength})` };
  }
  await mkdir(path.dirname(destPath), { recursive: true });

  const startedAt = Date.now();
  const budgetExceeded = () => Date.now() - startedAt > PER_FILE_BUDGET_MS;

  // Small files (or hosts that don't throttle): single curl, resume-friendly.
  if (!contentLength || contentLength <= SMALL_FILE_THRESHOLD) {
    try {
      const { stdout } = await execFileAsync(
        "curl",
        ["-sL", "--http1.1", "--max-time", "120", url],
        { encoding: "buffer", maxBuffer: 4 * 1024 * 1024, timeout: 130_000 },
      );
      if (!stdout.length) return { ok: false, status: 200, reason: "empty response body" };
      await writeFile(destPath, stdout);
      return { ok: true, status: 200, buffer: stdout, contentType, size: stdout.length };
    } catch (e) {
      return { ok: false, status: 0, reason: e.message };
    }
  }

  // Chunked parallel download.
  const totalChunks = Math.ceil(contentLength / CHUNK_SIZE);
  const results = new Array(totalChunks);
  let nextChunk = 0;
  let failedChunk = null;

  async function worker() {
    while (nextChunk < totalChunks && !failedChunk) {
      if (budgetExceeded()) {
        failedChunk = new Error(`per-file budget exceeded (${PER_FILE_BUDGET_MS}ms) at chunk ${nextChunk}/${totalChunks}`);
        return;
      }
      const i = nextChunk++;
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE - 1, contentLength - 1);
      try {
        results[i] = await fetchRange(url, start, end);
      } catch (e) {
        // One retry per chunk.
        try {
          results[i] = await fetchRange(url, start, end);
        } catch (e2) {
          failedChunk = new Error(`chunk ${i} (${start}-${end}) failed: ${e2.message}`);
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CHUNK_CONCURRENCY, totalChunks) }, () => worker()),
  );

  if (failedChunk) {
    return { ok: false, status: 200, reason: failedChunk.message };
  }

  const buf = Buffer.concat(results);
  if (buf.length === 0) return { ok: false, status: 200, reason: "assembled buffer is empty" };
  if (buf.length !== contentLength) {
    return { ok: false, status: 200, reason: `size mismatch: expected ${contentLength}, got ${buf.length}` };
  }
  await writeFile(destPath, buf);
  return { ok: true, status: 200, buffer: buf, contentType, size: buf.length };
}

// Validate a PDF buffer with MuPDF and return page count + first-page render.
async function analyzePdf(buf, renderPath, { render = true } = {}) {
  const mupdf = (await import("mupdf")).default;
  let doc;
  try {
    doc = mupdf.Document.openDocument(buf, "application/pdf");
  } catch (e) {
    return { valid: false, reason: `PDF parse failed: ${e.message}` };
  }
  // needsPassword check — refuse encrypted PDFs per task rules
  if (typeof doc.needsPassword === "function" && doc.needsPassword()) {
    return { valid: false, reason: "password-protected PDF (not downloading per policy)" };
  }
  let pageCount = 0;
  try {
    pageCount = doc.countPages();
  } catch (e) {
    return { valid: false, reason: `page count failed: ${e.message}` };
  }
  if (pageCount <= 0) {
    return { valid: false, reason: "PDF reports 0 pages" };
  }
  const rendered = null;
  let renderResult = null;
  if (render && renderPath) {
    renderResult = await renderFirstPage(mupdf, doc, renderPath);
  }
  return { valid: true, pageCount, render: renderResult };
}

async function renderFirstPage(mupdf, doc, destPath) {
  try {
    const page = doc.loadPage(0);
    const bounds = page.getBounds(); // [x0, y0, x1, y1]
    const pageWidth = bounds[2] - bounds[0];
    const pageHeight = bounds[3] - bounds[1];
    // Target ~900px wide cover, clamped to a sane DPI range.
    const targetWidth = 900;
    let scale = pageWidth > 0 ? targetWidth / pageWidth : 1.5;
    scale = Math.max(0.5, Math.min(3.0, scale));
    const matrix = mupdf.Matrix.scale(scale, scale);
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);
    const jpgBuf = Buffer.from(pixmap.asJPEG(82));
    await mkdir(path.dirname(destPath), { recursive: true });
    await writeFile(destPath, jpgBuf);
    return {
      ok: true,
      sha256: sha256(jpgBuf),
      size_bytes: jpgBuf.length,
      width: pixmap.getWidth(),
      height: pixmap.getHeight(),
      page_width: pageWidth,
      page_height: pageHeight,
    };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readExistingFile(p) {
  try {
    const info = await stat(p);
    if (!info.isFile()) return null;
    const buf = await readFile(p);
    return { buf, size: info.size, mtime: info.mtime };
  } catch {
    return null;
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node scripts/download-catalog-assets.mjs [options]

Options:
  --apply          Actually download files (default: dry-run)
  --force          Re-download even if a valid file already exists
  --skip-render    Skip rendering PDF first-page covers
  --only pdfs|covers  Process only one category
  -h, --help       Show this help

Sources:
  data/catalog-public-library-russia.json   (tier 1: public direct PDFs)
  data/catalog-public-pdf-links.json        (tier 2: candidate PDF links)
  data/catalog-official-current-covers.json (official cover images)
  data/catalog-official-new-product-covers.json (official new-product covers)

Output:
  data/catalog-source-files/pdfs/      downloaded PDFs
  data/catalog-source-files/covers/    downloaded official covers
  data/catalog-source-files/rendered/  first-page JPEG renders
  data/catalog-assets.json             verified-asset manifest + stats
`);
    return;
  }

  const plan = await buildPlan();
  const todayStr = today();

  const result = {
    generated_at: todayStr,
    tool: "scripts/download-catalog-assets.mjs",
    mode: args.apply ? "apply" : "dry-run",
    pdfs: [],
    covers: [],
    excluded: [],
    failures: [],
    stats: {
      pdfs_total: 0,
      pdfs_success: 0,
      pdfs_failed: 0,
      pdfs_skipped: 0,
      pdfs_excluded: 0,
      covers_total: 0,
      covers_success: 0,
      covers_failed: 0,
      covers_skipped: 0,
    },
  };

  // Global SHA-256 dedup map (hash -> first local file that produced it).
  const hashIndex = new Map();

  // ----- PDFs -----
  if (!args.only || args.only === "pdfs") {
    // In apply mode, probe sizes first and process smallest files first so the
    // most files succeed before any per-file time budget is hit on the larger
    // color-card PDFs over the throttled international link.
    if (args.apply) {
      console.log("[catalog-download] probing PDF sizes...");
      for (const entry of plan.pdfs) {
        if (excludeReason(entry.url)) continue;
        try {
          entry.__probe = await probeUrl(entry.url);
        } catch {
          entry.__probe = { ok: false, status: 0, contentLength: 0, contentType: "" };
        }
      }
      plan.pdfs.sort((a, b) => {
        const sa = (a.__probe && a.__probe.contentLength) || Number.MAX_SAFE_INTEGER;
        const sb = (b.__probe && b.__probe.contentLength) || Number.MAX_SAFE_INTEGER;
        return sa - sb;
      });
    }

    result.stats.pdfs_total = plan.pdfs.length;
    console.log(
      `\n[catalog-download] mode=${args.apply ? "apply" : "dry-run"} pdfs=${plan.pdfs.length}`,
    );

    for (const [i, entry] of plan.pdfs.entries()) {
      const slug = slugFromUrl(entry.url);
      const ext = extFromUrl(entry.url, ".pdf") || ".pdf";
      const fileName = `${slug}${ext}`;
      const destPath = path.join(PDF_DIR, fileName);
      const renderPath = path.join(RENDER_DIR, `${slug}-page1.jpg`);
      const label = `[${i + 1}/${plan.pdfs.length}] ${slug}`;

      // Exclusion check (platform/password) — never fetch.
      const excl = excludeReason(entry.url);
      if (excl) {
        result.stats.pdfs_excluded += 1;
        result.excluded.push({
          kind: "pdf",
          url: entry.url,
          title: entry.title,
          reason: excl,
        });
        console.log(`${label} excluded: ${excl}`);
        continue;
      }

      try {
        if (!args.apply) {
          // Dry-run: probe only.
          const probe = await probeUrl(entry.url);
          console.log(
            `${label} dry-run url=${entry.url} status=${probe.status} ` +
              `type=${probe.contentType || "?"} len=${probe.contentLength || "?"}`,
          );
          result.pdfs.push({
            url: entry.url,
            title: entry.title,
            topic_ids: entry.topic_ids,
            source_origin: entry.source_origin,
            access: entry.access,
            tier: entry.tier,
            local_file: `data/catalog-source-files/pdfs/${fileName}`,
            probe_status: probe.status,
            probe_content_type: probe.contentType,
            probe_content_length: probe.contentLength,
          });
          result.stats.pdfs_skipped += 1;
          continue;
        }

        // --apply path
        let buffer = null;
        let httpStatus = 0;
        let contentType = "";
        let size = 0;
        let reusedExisting = false;

        // Resume: reuse an existing valid file unless --force.
        if (!args.force) {
          const existing = await readExistingFile(destPath);
          if (existing && existing.buf.length > 0) {
            // Verify it looks like a PDF before reusing.
            if (/^%PDF-/.test(existing.buf.slice(0, 5).toString("latin1"))) {
              buffer = existing.buf;
              size = existing.size;
              httpStatus = 200; // previously downloaded OK
              contentType = "application/pdf";
              reusedExisting = true;
              console.log(`${label} reuse existing (${size} bytes)`);
            }
          }
        }

        if (!buffer) {
          const probe = entry.__probe || {};
          const sizeMb = probe.contentLength ? (probe.contentLength / 1048576).toFixed(1) : "?";
          console.log(`${label} downloading ${entry.url} (${sizeMb} MB)`);
          const dl = await downloadFile(entry.url, destPath, {
            contentLength: probe.contentLength,
            contentType: probe.contentType,
          });
          if (!dl.ok) {
            throw new Error(dl.reason || `download failed (status ${dl.status})`);
          }
          buffer = dl.buffer;
          httpStatus = dl.status;
          contentType = dl.contentType;
          size = dl.size;
        }

        const hash = sha256(buffer);

        // SHA-256 dedup across the whole run.
        if (hashIndex.has(hash)) {
          result.stats.pdfs_skipped += 1;
          console.log(`${label} skip (duplicate hash of ${hashIndex.get(hash)})`);
          result.pdfs.push({
            url: entry.url,
            title: entry.title,
            topic_ids: entry.topic_ids,
            source_origin: entry.source_origin,
            access: entry.access,
            tier: entry.tier,
            local_file: `data/catalog-source-files/pdfs/${fileName}`,
            sha256: hash,
            size_bytes: size,
            mime_type: contentType || "application/pdf",
            http_status: httpStatus,
            duplicate_of: hashIndex.get(hash),
            downloaded_at: todayStr,
          });
          continue;
        }
        hashIndex.set(hash, `data/catalog-source-files/pdfs/${fileName}`);

        // Validate PDF + page count + render first page.
        const analysis = await analyzePdf(buffer, renderPath, {
          render: !args.skipRender,
        });
        if (!analysis.valid) {
          throw new Error(`PDF verification failed: ${analysis.reason}`);
        }

        const record = {
          url: entry.url,
          title: entry.title,
          topic_ids: entry.topic_ids,
          primary_catalog_topic_id: entry.topic_ids[0] || null,
          source_origin: entry.source_origin,
          access: entry.access,
          tier: entry.tier,
          local_file: `data/catalog-source-files/pdfs/${fileName}`,
          sha256: hash,
          size_bytes: size,
          mime_type: contentType || "application/pdf",
          http_status: httpStatus,
          page_count: analysis.pageCount,
          pdf_valid: true,
          reused_existing: reusedExisting,
          downloaded_at: todayStr,
        };
        if (analysis.render && analysis.render.ok) {
          record.rendered_cover = `data/catalog-source-files/rendered/${slug}-page1.jpg`;
          record.rendered_cover_sha256 = analysis.render.sha256;
          record.rendered_cover_size_bytes = analysis.render.size_bytes;
          record.rendered_cover_width = analysis.render.width;
          record.rendered_cover_height = analysis.render.height;
        } else if (analysis.render && !analysis.render.ok) {
          record.rendered_cover_error = analysis.render.reason;
        }
        result.pdfs.push(record);
        result.stats.pdfs_success += 1;
        console.log(
          `${label} ok pages=${analysis.pageCount} size=${size} sha=${hash.slice(0, 12)}` +
            (analysis.render && analysis.render.ok ? " +cover" : ""),
        );
      } catch (e) {
        result.stats.pdfs_failed += 1;
        const reason = e instanceof Error ? e.message : String(e);
        result.failures.push({ kind: "pdf", url: entry.url, title: entry.title, reason });
        console.error(`${label} FAILED: ${reason}`);
      }
    }
  }

  // ----- Covers -----
  if (!args.only || args.only === "covers") {
    result.stats.covers_total = plan.covers.length;
    console.log(`\n[catalog-download] covers=${plan.covers.length}`);

    for (const [i, entry] of plan.covers.entries()) {
      const slug =
        (entry.catalog_topic_id ? entry.catalog_topic_id + "-" : "") +
        slugFromUrl(entry.url);
      const ext = extFromUrl(entry.url, ".webp") || ".webp";
      const fileName = `official-${slug}${ext}`;
      const destPath = path.join(COVER_DIR, fileName);
      const label = `[${i + 1}/${plan.covers.length}] ${slug}`;

      try {
        if (!args.apply) {
          const probe = await probeUrl(entry.url);
          console.log(
            `${label} dry-run url=${entry.url} status=${probe.status} ` +
              `type=${probe.contentType || "?"} len=${probe.contentLength || "?"}`,
          );
          result.covers.push({
            kind: "cover",
            url: entry.url,
            title: entry.title,
            catalog_topic_id: entry.catalog_topic_id,
            source_origin: entry.source_origin,
            local_file: `data/catalog-source-files/covers/${fileName}`,
            probe_status: probe.status,
            probe_content_type: probe.contentType,
            probe_content_length: probe.contentLength,
          });
          result.stats.covers_skipped += 1;
          continue;
        }

        let buffer = null;
        let httpStatus = 0;
        let contentType = "";
        let size = 0;
        let reusedExisting = false;

        if (!args.force) {
          const existing = await readExistingFile(destPath);
          if (existing && existing.buf.length > 0) {
            buffer = existing.buf;
            size = existing.size;
            httpStatus = 200;
            contentType = "image/webp";
            reusedExisting = true;
            console.log(`${label} reuse existing (${size} bytes)`);
          }
        }

        if (!buffer) {
          console.log(`${label} downloading ${entry.url}`);
          const dl = await downloadFile(entry.url, destPath);
          if (!dl.ok) {
            throw new Error(dl.reason || `download failed (status ${dl.status})`);
          }
          buffer = dl.buffer;
          httpStatus = dl.status;
          contentType = dl.contentType;
          size = dl.size;
        }

        const hash = sha256(buffer);
        if (hashIndex.has(hash)) {
          result.stats.covers_skipped += 1;
          console.log(`${label} skip (duplicate hash of ${hashIndex.get(hash)})`);
          result.covers.push({
            kind: "cover",
            url: entry.url,
            title: entry.title,
            catalog_topic_id: entry.catalog_topic_id,
            source_origin: entry.source_origin,
            local_file: `data/catalog-source-files/covers/${fileName}`,
            sha256: hash,
            size_bytes: size,
            mime_type: contentType,
            http_status: httpStatus,
            duplicate_of: hashIndex.get(hash),
            downloaded_at: todayStr,
          });
          continue;
        }
        hashIndex.set(hash, `data/catalog-source-files/covers/${fileName}`);

        result.covers.push({
          kind: "cover",
          url: entry.url,
          title: entry.title,
          catalog_topic_id: entry.catalog_topic_id,
          source_origin: entry.source_origin,
          local_file: `data/catalog-source-files/covers/${fileName}`,
          sha256: hash,
          size_bytes: size,
          mime_type: contentType,
          http_status: httpStatus,
          reused_existing: reusedExisting,
          downloaded_at: todayStr,
        });
        result.stats.covers_success += 1;
        console.log(`${label} ok size=${size} sha=${hash.slice(0, 12)}`);
      } catch (e) {
        result.stats.covers_failed += 1;
        const reason = e instanceof Error ? e.message : String(e);
        result.failures.push({ kind: "cover", url: entry.url, title: entry.title, reason });
        console.error(`${label} FAILED: ${reason}`);
      }
    }
  }

  // Write manifest (only in apply mode; dry-run just prints the plan).
  if (args.apply) {
    await mkdir(path.dirname(ASSETS_JSON), { recursive: true });
    await writeFile(ASSETS_JSON, JSON.stringify(result, null, 2) + "\n", "utf8");
    console.log(`\n[catalog-download] wrote ${path.relative(ROOT, ASSETS_JSON)}`);
  }

  const s = result.stats;
  console.log(
    `\n[catalog-download] done.` +
      `\n  pdfs:    success=${s.pdfs_success} failed=${s.pdfs_failed} skipped=${s.pdfs_skipped} excluded=${s.pdfs_excluded} (total=${s.pdfs_total})` +
      `\n  covers:  success=${s.covers_success} failed=${s.covers_failed} skipped=${s.covers_skipped} (total=${s.covers_total})` +
      `\n  failures recorded: ${result.failures.length}`,
  );

  if (s.pdfs_failed + s.covers_failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`[catalog-download] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
