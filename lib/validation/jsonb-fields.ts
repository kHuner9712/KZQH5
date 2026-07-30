/**
 * jsonb-fields.ts — Structural validators for jsonb array fields.
 *
 * These validators ensure that jsonb fields (features, sections, advantages,
 * navigation_json) submitted by admin clients have the expected shape before
 * being persisted. Without them, arbitrary structures could be stored and
 * later rendered on the public site.
 *
 * Each validator returns either a sanitized array or null (for missing
 * values). Invalid items produce a descriptive error code.
 */

export type JsonbValidationResult =
  | { ok: true; value: unknown[] | null }
  | { ok: false; error: string };

function optionalStr(field: string, v: unknown, max: number): string | null {
  if (v == null) return null;
  if (typeof v !== "string") throw new Error(`${field}:not-string`);
  const t = v.trim();
  if (t.length === 0) return null;
  if (t.length > max) throw new Error(`${field}:too-long`);
  return t;
}

export function validateNavItemArray(
  field: string,
  value: unknown,
  maxItems: number,
): JsonbValidationResult {
  if (value == null) return { ok: true, value: null };
  if (!Array.isArray(value)) return { ok: false, error: `${field}:not-array` };
  if (value.length > maxItems) return { ok: false, error: `${field}:too-many-items` };
  const out: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: `${field}:item-${i}-not-object` };
    }
    const obj = item as Record<string, unknown>;
    let labelCn: string | null = null;
    let labelEn: string | null = null;
    let href: string | null = null;
    try {
      labelCn = optionalStr(`${field}.item-${i}.label_cn`, obj.label_cn, 100);
      labelEn = optionalStr(`${field}.item-${i}.label_en`, obj.label_en, 100);
      href = optionalStr(`${field}.item-${i}.href`, obj.href, 500);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    if (labelCn === null && labelEn === null) {
      return { ok: false, error: `${field}:item-${i}-missing-label` };
    }
    if (href === null) {
      return { ok: false, error: `${field}:item-${i}-missing-href` };
    }
    const result: Record<string, unknown> = { label_cn: labelCn ?? "", label_en: labelEn ?? "", href };
    if (typeof obj.sort_order === "number" && Number.isFinite(obj.sort_order)) {
      result.sort_order = Math.floor(obj.sort_order);
    }
    out.push(result);
  }
  return { ok: true, value: out };
}

export function validateHomeFeatureArray(
  field: string,
  value: unknown,
  maxItems: number,
): JsonbValidationResult {
  if (value == null) return { ok: true, value: null };
  if (!Array.isArray(value)) return { ok: false, error: `${field}:not-array` };
  if (value.length > maxItems) return { ok: false, error: `${field}:too-many-items` };
  const out: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: `${field}:item-${i}-not-object` };
    }
    const obj = item as Record<string, unknown>;
    try {
      out.push({
        icon: optionalStr(`${field}.item-${i}.icon`, obj.icon, 100) ?? "",
        title: optionalStr(`${field}.item-${i}.title`, obj.title, 200) ?? "",
        description: optionalStr(`${field}.item-${i}.description`, obj.description, 1000) ?? "",
      });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  return { ok: true, value: out };
}

export function validatePageSectionArray(
  field: string,
  value: unknown,
  maxItems: number,
): JsonbValidationResult {
  if (value == null) return { ok: true, value: null };
  if (!Array.isArray(value)) return { ok: false, error: `${field}:not-array` };
  if (value.length > maxItems) return { ok: false, error: `${field}:too-many-items` };
  const out: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: `${field}:item-${i}-not-object` };
    }
    const obj = item as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    try {
      const title = optionalStr(`${field}.item-${i}.title`, obj.title, 200);
      if (title !== null) result.title = title;
      const subtitle = optionalStr(`${field}.item-${i}.subtitle`, obj.subtitle, 200);
      if (subtitle !== null) result.subtitle = subtitle;
      const body = optionalStr(`${field}.item-${i}.body`, obj.body, 4000);
      if (body !== null) result.body = body;
      const icon = optionalStr(`${field}.item-${i}.icon`, obj.icon, 100);
      if (icon !== null) result.icon = icon;
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    if (Array.isArray(obj.items)) {
      if (obj.items.length > 50) return { ok: false, error: `${field}:item-${i}-too-many-items` };
      const items: string[] = [];
      for (let j = 0; j < obj.items.length; j++) {
        if (typeof obj.items[j] !== "string") {
          return { ok: false, error: `${field}:item-${i}-items-${j}-not-string` };
        }
        const trimmed = (obj.items[j] as string).trim();
        if (trimmed.length > 200) return { ok: false, error: `${field}:item-${i}-items-${j}-too-long` };
        items.push(trimmed);
      }
      result.items = items;
    }
    out.push(result);
  }
  return { ok: true, value: out };
}

export function validateAdvantageArray(
  field: string,
  value: unknown,
  maxItems: number,
): JsonbValidationResult {
  if (value == null) return { ok: true, value: null };
  if (!Array.isArray(value)) return { ok: false, error: `${field}:not-array` };
  if (value.length > maxItems) return { ok: false, error: `${field}:too-many-items` };
  const out: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: `${field}:item-${i}-not-object` };
    }
    const obj = item as Record<string, unknown>;
    try {
      out.push({
        icon: optionalStr(`${field}.item-${i}.icon`, obj.icon, 100) ?? "",
        title_cn: optionalStr(`${field}.item-${i}.title_cn`, obj.title_cn, 200) ?? "",
        title_en: optionalStr(`${field}.item-${i}.title_en`, obj.title_en, 200) ?? "",
        desc_cn: optionalStr(`${field}.item-${i}.desc_cn`, obj.desc_cn, 1000) ?? "",
        desc_en: optionalStr(`${field}.item-${i}.desc_en`, obj.desc_en, 1000) ?? "",
      });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  return { ok: true, value: out };
}
