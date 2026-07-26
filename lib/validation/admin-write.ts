import { UUID_PATTERN } from "@/lib/services/http-security";
import {
  mediaAllowlistFromEnv,
  normalizeOptionalMediaUrl,
  type MediaUrlAllowlist,
} from "@/lib/validation/url";

export { UUID_PATTERN } from "@/lib/services/http-security";

export interface FieldError {
  field: string;
  reason: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: FieldError[] };

export function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(
  errors: FieldError[],
): ValidationResult<T> {
  return { ok: false, errors };
}

export function failField<T = never>(field: string, reason: string): ValidationResult<T> {
  return { ok: false, errors: [{ field, reason }] };
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function validateUuid(field: string, value: unknown): ValidationResult<string> {
  if (!isUuid(value)) return failField(field, "invalid-uuid");
  return ok(value);
}

export function validateOptionalUuid(field: string, value: unknown): ValidationResult<string | null> {
  if (value == null || value === "") return ok(null);
  return validateUuid(field, value);
}

export function validateEnum<T extends string>(
  field: string,
  value: unknown,
  allowed: readonly T[],
): ValidationResult<T> {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    return failField(field, "invalid-enum");
  }
  return ok(value as T);
}

export function validateOptionalEnum<T extends string>(
  field: string,
  value: unknown,
  allowed: readonly T[],
): ValidationResult<T | null> {
  if (value == null || value === "") return ok(null);
  return validateEnum(field, value, allowed);
}

export function validateNonEmptyString(
  field: string,
  value: unknown,
  max: number,
): ValidationResult<string> {
  if (typeof value !== "string") return failField(field, "not-string");
  const trimmed = value.trim();
  if (trimmed.length === 0) return failField(field, "empty");
  if (trimmed.length > max) return failField(field, "too-long");
  return ok(trimmed);
}

export function validateOptionalString(
  field: string,
  value: unknown,
  max: number,
): ValidationResult<string | null> {
  if (value == null) return ok(null);
  if (typeof value !== "string") return failField(field, "not-string");
  const trimmed = value.trim();
  if (trimmed.length === 0) return ok(null);
  if (trimmed.length > max) return failField(field, "too-long");
  return ok(trimmed);
}

export function validateBoolean(
  field: string,
  value: unknown,
): ValidationResult<boolean> {
  if (typeof value !== "boolean") return failField(field, "not-boolean");
  return ok(value);
}

export function validateOptionalBoolean(
  field: string,
  value: unknown,
): ValidationResult<boolean | null> {
  if (value == null) return ok(null);
  return validateBoolean(field, value);
}

export function validateInteger(
  field: string,
  value: unknown,
  min: number,
  max: number,
): ValidationResult<number> {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return failField(field, "not-integer");
  }
  if (value < min || value > max) return failField(field, "out-of-range");
  return ok(value);
}

export function validateOptionalInteger(
  field: string,
  value: unknown,
  min: number,
  max: number,
): ValidationResult<number | null> {
  if (value == null || value === "") return ok(null);
  return validateInteger(field, value, min, max);
}

export function validateSlug(field: string, value: unknown): ValidationResult<string> {
  if (typeof value !== "string") return failField(field, "not-string");
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) {
    return failField(field, "invalid-slug");
  }
  return ok(trimmed);
}

export function validateStringArray(
  field: string,
  value: unknown,
  maxItems: number,
  itemMax: number,
): ValidationResult<string[]> {
  if (!Array.isArray(value)) return failField(field, "not-array");
  if (value.length > maxItems) return failField(field, "too-many-items");
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") return failField(field, `item-${i}-not-string`);
    const trimmed = value[i].trim();
    if (trimmed.length === 0) return failField(field, `item-${i}-empty`);
    if (trimmed.length > itemMax) return failField(field, `item-${i}-too-long`);
    out.push(trimmed);
  }
  return ok(out);
}

export function validateJsonArray(
  field: string,
  value: unknown,
  maxItems: number,
): ValidationResult<unknown[]> {
  if (!Array.isArray(value)) return failField(field, "not-array");
  if (value.length > maxItems) return failField(field, "too-many-items");
  return ok(value);
}

export function validateJsonObject(
  field: string,
  value: unknown,
): ValidationResult<Record<string, unknown>> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return failField(field, "not-object");
  }
  return ok(value as Record<string, unknown>);
}

let cachedAllowlist: MediaUrlAllowlist | null = null;

function allowlist(): MediaUrlAllowlist {
  if (!cachedAllowlist) cachedAllowlist = mediaAllowlistFromEnv(process.env);
  return cachedAllowlist;
}

/** Test-only: reset the cached allowlist between unit tests. */
export function __resetMediaUrlAllowlistCache(): void {
  cachedAllowlist = null;
}

export function validateOptionalMediaUrl(
  field: string,
  value: unknown,
  max: number,
): ValidationResult<string | null> {
  if (value == null) return ok(null);
  if (typeof value !== "string") return failField(field, "not-string");
  const trimmed = value.trim();
  if (trimmed.length === 0) return ok(null);
  if (trimmed.length > max) return failField(field, "too-long");
  const result = normalizeOptionalMediaUrl(trimmed, allowlist());
  if (!result.ok) return failField(field, `url-${result.reason}`);
  return ok(result.value);
}

export function validateRequiredMediaUrl(
  field: string,
  value: unknown,
  max: number,
): ValidationResult<string> {
  if (typeof value !== "string") return failField(field, "not-string");
  const trimmed = value.trim();
  if (trimmed.length === 0) return failField(field, "empty");
  if (trimmed.length > max) return failField(field, "too-long");
  const result = normalizeOptionalMediaUrl(trimmed, allowlist());
  if (!result.ok) return failField(field, `url-${result.reason}`);
  return ok(result.value ?? "");
}

/** Merge multiple validation results, accumulating all field errors. */
export function merge<T extends Record<string, unknown>>(
  results: Record<keyof T, ValidationResult<unknown>>,
): ValidationResult<T> {
  const errors: FieldError[] = [];
  const value: Record<string, unknown> = {};
  for (const [field, result] of Object.entries(results)) {
    if (result.ok) {
      value[field] = result.value;
    } else {
      errors.push(...result.errors.map((e) => ({ field: e.field, reason: e.reason })));
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: value as T };
}
