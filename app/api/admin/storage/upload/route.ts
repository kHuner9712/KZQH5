/**
 * Trusted purpose-driven Storage upload route.
 */

import { NextRequest, NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo";
import {
  adminWriteError,
  requireAdminWrite,
} from "@/lib/services/admin-write-boundary";
import type { AdminWriteErrorCode } from "@/lib/services/admin-write-boundary";
import { getStorageUploadRateLimiter } from "@/lib/services/rate-limit";
import { uploadByPurpose } from "@/lib/services/storage-upload";
import { resolvePurposeConfig } from "@/lib/services/storage-purpose";

export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = Math.floor(4.5 * 1024 * 1024);
const MAX_HOMEPAGE_IMAGE_BYTES = 700 * 1024;

function statusForCode(code: AdminWriteErrorCode): number {
  switch (code) {
    case "ADMIN_WRITE_BAD_REQUEST":
      return 400;
    case "ADMIN_WRITE_PAYLOAD_TOO_LARGE":
      return 413;
    case "ADMIN_WRITE_UNSUPPORTED_MEDIA":
      return 415;
    case "ADMIN_WRITE_FORBIDDEN_ORIGIN":
    case "ADMIN_WRITE_FORBIDDEN_ROLE":
    case "ADMIN_WRITE_DEMO":
      return 403;
    case "ADMIN_WRITE_UNAUTHORIZED":
      return 401;
    case "ADMIN_WRITE_CONFLICT":
      return 409;
    default:
      return 500;
  }
}

function validateHomepageImageContract(file: File): AdminWriteErrorCode | null {
  if (file.type !== "image/webp") return "ADMIN_WRITE_UNSUPPORTED_MEDIA";
  if (file.size <= 0) return "ADMIN_WRITE_BAD_REQUEST";
  if (file.size > MAX_HOMEPAGE_IMAGE_BYTES) {
    return "ADMIN_WRITE_PAYLOAD_TOO_LARGE";
  }
  return null;
}

export async function POST(request: NextRequest) {
  const guard = await requireAdminWrite<unknown>(request, {
    maxBytes: MAX_REQUEST_BYTES,
    minimumRole: "admin",
    body: "skip",
  });
  if (!guard.ok) return guard.response;

  const rateKey = `admin-upload:${guard.user.id}`;
  const rate = await getStorageUploadRateLimiter().check(rateKey);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "ADMIN_WRITE_RATE_LIMITED" },
      {
        status: 429,
        headers: {
          "Retry-After": String(rate.retryAfterSeconds),
          "Cache-Control": "private, no-store",
        },
      },
    );
  }

  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "multipart/form-data") {
    return adminWriteError("ADMIN_WRITE_UNSUPPORTED_MEDIA", 415);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  const purpose = form.get("purpose");
  const file = form.get("file");
  const allowedFields = new Set(["purpose", "file"]);
  for (const key of form.keys()) {
    if (!allowedFields.has(key)) {
      return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
    }
  }

  if (!(file instanceof File)) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }
  if (typeof purpose !== "string" || purpose.length === 0) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  const config = resolvePurposeConfig(purpose);
  if (!config) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  if (purpose === "homepage-image") {
    const contractError = validateHomepageImageContract(file);
    if (contractError) {
      return adminWriteError(contractError, statusForCode(contractError));
    }
  }

  if (isDemoMode()) {
    const demoPath = `demo/${config.category}/${Date.now()}`;
    return NextResponse.json({
      success: true,
      demo: true,
      path: demoPath,
      bucket: config.bucket,
      mimeType: file.type,
      size: file.size,
      ...(config.isPublicUrlAllowed
        ? {
            publicUrl: `${(process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "")}/storage/v1/object/public/${config.bucket}/${demoPath}`,
          }
        : {}),
    });
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  if (bytes.length > MAX_FILE_BYTES) {
    return adminWriteError("ADMIN_WRITE_PAYLOAD_TOO_LARGE", 413);
  }
  if (purpose === "homepage-image" && bytes.length > MAX_HOMEPAGE_IMAGE_BYTES) {
    return adminWriteError("ADMIN_WRITE_PAYLOAD_TOO_LARGE", 413);
  }

  const result = await uploadByPurpose(
    purpose,
    {
      bytes,
      mimeType: file.type,
      size: bytes.length,
      filename: file.name,
    },
    {
      actorId: guard.user.id,
      actorRole: guard.profile.role ?? null,
    },
  );
  if (!result.ok) {
    return adminWriteError(result.code, statusForCode(result.code), {
      logCode: result.code,
    });
  }

  return NextResponse.json(
    {
      success: true,
      path: result.ref.path,
      bucket: result.ref.bucket,
      mimeType: result.ref.mimeType,
      size: result.ref.size,
      publicUrl: result.ref.publicUrl,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
