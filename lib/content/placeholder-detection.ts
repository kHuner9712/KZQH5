// ============================================================
// Placeholder contact-data detection
//
// Production `company_profile` may still contain placeholder contact
// details (example phone numbers, demo emails, "XX Road" addresses).
// These must never be rendered to public visitors as if they were real
// business contacts — they would mislead buyers and pollute search
// results / JSON-LD structured data.
//
// This module centralises detection so every public surface (Footer,
// Contact page, mobile quick actions, product detail CTA, Organization
// JSON-LD, About page) applies the SAME guard. Never replace a detected
// placeholder with new fake content — either hide the entry or show the
// neutral "contacts being configured" message.
//
// Pure functions only — safe to import from server and client components.
// ============================================================

import type { Locale } from "@/lib/i18n/config";

/** Neutral message shown when contact details are placeholders. */
export const placeholderContactNotice: Record<Locale, string> = {
  zh: "商务联系方式正在配置中，请通过询盘表单联系我们。",
  en: "Business contact details are being configured. Please use the inquiry form.",
};

function isEmpty(value: string | null | undefined): boolean {
  return !value || value.trim().length === 0;
}

/**
 * Detects placeholder markers commonly used in mock/demo/seed data.
 * Matches: placeholder, mock, demo, sample, test, todo, tbd, xxx, fixme.
 * Case-insensitive, but only matches whole-ish tokens to avoid false
 * positives on legitimate words containing these substrings.
 */
function hasPlaceholderMarker(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    /\bplaceholder\b/.test(lower) ||
    /\bmock\b/.test(lower) ||
    /\bdemo\b/.test(lower) ||
    /\bsample\b/.test(lower) ||
    /\btodo\b/.test(lower) ||
    /\btbd\b/.test(lower) ||
    /\bfixme\b/.test(lower) ||
    /\bxxx\b/.test(lower)
  );
}

/**
 * Detects obvious consecutive-zero phone/whatsapp numbers.
 * Flags 4+ consecutive digits that are all zeros (after stripping
 * non-digits). A real number like "+86 138 0001 1234" is NOT flagged
 * because it only has 3 consecutive zeros.
 */
function hasConsecutiveZeros(value: string): boolean {
  const digits = value.replace(/[^\d]/g, "");
  // 4+ consecutive zeros in the digit stream is a placeholder signal.
  return /0{4,}/.test(digits);
}

/**
 * Phone number placeholder detection.
 *
 * Flagged patterns:
 *   - empty / whitespace
 *   - "0000-0000" or "0000 0000" style sequences
 *   - 4+ consecutive zero digits (e.g. "400-888-0000", "138 0000 0000")
 *   - placeholder markers (mock/demo/test/etc.)
 */
export function isPlaceholderPhone(value: string | null | undefined): boolean {
  if (isEmpty(value)) return true;
  const v = value as string;
  if (hasConsecutiveZeros(v)) return true;
  // Explicit "0000-0000" / "0000 0000" pair (redundant with consecutive
  // check but documents intent).
  if (/0000[-\s]0000/.test(v)) return true;
  if (hasPlaceholderMarker(v)) return true;
  return false;
}

/**
 * Email placeholder detection.
 *
 * Flagged patterns:
 *   - empty / whitespace
 *   - domains: example.com, example.org, kzq-demo.com, kzq-example.com,
 *     test.com, localhost
 *   - placeholder markers
 */
export function isPlaceholderEmail(value: string | null | undefined): boolean {
  if (isEmpty(value)) return true;
  const v = value as string;
  const lower = v.toLowerCase();
  // Placeholder email domains.
  if (
    /@(example\.(com|org|net)|kzq-demo\.com|kzq-example\.com|test\.com|localhost)/i.test(
      lower,
    )
  ) {
    return true;
  }
  if (hasPlaceholderMarker(v)) return true;
  // Must look roughly like an email; otherwise treat as placeholder.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return true;
  return false;
}

/**
 * WhatsApp number placeholder detection.
 * Same rules as phone — WhatsApp shares the same numbering space.
 */
export function isPlaceholderWhatsApp(
  value: string | null | undefined,
): boolean {
  return isPlaceholderPhone(value);
}

/**
 * Address placeholder detection (works for both CN and EN addresses).
 *
 * Flagged patterns:
 *   - empty / whitespace
 *   - "XX 区" / "XX区" / "XX 路" / "XX路" / "XX 号" / "XX号"
 *   - "No. XX" / "XX Road" / "XX District" / "XX Street"
 *   - placeholder markers
 */
export function isPlaceholderAddress(
  value: string | null | undefined,
): boolean {
  if (isEmpty(value)) return true;
  const v = value as string;
  // Chinese placeholder tokens.
  if (/XX\s*[区路号街道]/.test(v)) return true;
  if (/XX\s*号/.test(v)) return true;
  // English placeholder tokens.
  if (/No\.\s*XX/i.test(v)) return true;
  if (/XX\s+(Road|District|Street|Avenue|Blvd)/i.test(v)) return true;
  if (hasPlaceholderMarker(v)) return true;
  return false;
}

/**
 * Returns the phone if it is safe to render, otherwise null.
 * Convenience wrapper for component JSX.
 */
export function safePhone(value: string | null | undefined): string | null {
  return isPlaceholderPhone(value) ? null : (value as string);
}

/**
 * Returns the email if it is safe to render, otherwise null.
 */
export function safeEmail(value: string | null | undefined): string | null {
  return isPlaceholderEmail(value) ? null : (value as string);
}

/**
 * Returns the WhatsApp number if it is safe to render, otherwise null.
 */
export function safeWhatsApp(value: string | null | undefined): string | null {
  return isPlaceholderWhatsApp(value) ? null : (value as string);
}

/**
 * Returns the address if it is safe to render, otherwise null.
 */
export function safeAddress(value: string | null | undefined): string | null {
  return isPlaceholderAddress(value) ? null : (value as string);
}
