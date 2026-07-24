import { describe, expect, it } from "vitest";
import {
  isPlaceholderPhone,
  isPlaceholderEmail,
  safeEmail,
  safePhone,
  safeWhatsApp,
  sanitizeCompany,
} from "@/lib/content/placeholder-detection";

/**
 * Verifies the contact-link generation pattern used across the public site:
 *
 *   const phone = safePhone(company?.phone);
 *   {phone && <a href={`tel:${phone.replace(/[^+\d]/g, "")}`}>...</a>}
 *
 * The goal is to NEVER render an empty `tel:` or `mailto:` link. When the
 * contact detail is a placeholder, the safe* helper returns null and the
 * component renders a fallback link to /contact instead.
 */

function telHref(phone: string | null | undefined): string | null {
  const safe = safePhone(phone);
  return safe ? `tel:${safe.replace(/[^+\d]/g, "")}` : null;
}

function mailtoHref(email: string | null | undefined): string | null {
  const safe = safeEmail(email);
  return safe ? `mailto:${safe}` : null;
}

function whatsappHref(value: string | null | undefined): string | null {
  const safe = safeWhatsApp(value);
  return safe ? `https://wa.me/${safe.replace(/[^\d]/g, "")}` : null;
}

describe("contact link generation — tel:", () => {
  it("generates a sanitized tel: link for a real phone", () => {
    expect(telHref("+86 139 1234 5678")).toBe("tel:+8613912345678");
  });

  it("strips spaces and hyphens but keeps the leading +", () => {
    expect(telHref("+86-139-1234-5678")).toBe("tel:+8613912345678");
  });

  it("returns null for an empty phone (no empty tel: link)", () => {
    expect(telHref("")).toBeNull();
  });

  it("returns null for a placeholder phone (no misleading tel: link)", () => {
    expect(telHref("+86 138-0000-0000")).toBeNull();
  });

  it("returns null for null/undefined input", () => {
    expect(telHref(null)).toBeNull();
    expect(telHref(undefined)).toBeNull();
  });

  it("does not produce tel: with consecutive zeros from placeholder data", () => {
    expect(telHref("400-888-0000")).toBeNull();
  });
});

describe("contact link generation — mailto:", () => {
  it("generates a mailto: link for a real email", () => {
    expect(mailtoHref("sales@kzq-boards.com")).toBe("mailto:sales@kzq-boards.com");
  });

  it("returns null for an example.com placeholder", () => {
    expect(mailtoHref("contact@example.com")).toBeNull();
  });

  it("returns null for empty email", () => {
    expect(mailtoHref("")).toBeNull();
  });

  it("returns null for an invalid email format", () => {
    expect(mailtoHref("not-an-email")).toBeNull();
  });
});

describe("contact link generation — WhatsApp", () => {
  it("generates a wa.me link for a real number", () => {
    expect(whatsappHref("+86 139 1234 5678")).toBe(
      "https://wa.me/8613912345678",
    );
  });

  it("returns null for a placeholder number", () => {
    expect(whatsappHref("+86 138 0000 0000")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(whatsappHref("")).toBeNull();
  });
});

describe("sanitizeCompany — RSC stream safety", () => {
  it("nulls out placeholder contact fields so they cannot leak into RSC stream", () => {
    const sanitized = sanitizeCompany({
      phone: "+86 138-0000-0000",
      email: "demo@example.com",
      whatsapp: "0000-0000",
      address_cn: "XX 区 XX 路 1 号",
      address_en: "XX Road, XX District",
      extra_field: "preserved",
    });
    expect(sanitized.phone).toBeNull();
    expect(sanitized.email).toBeNull();
    expect(sanitized.whatsapp).toBeNull();
    expect(sanitized.address_cn).toBeNull();
    expect(sanitized.address_en).toBeNull();
    // Non-contact fields are preserved.
    expect(sanitized.extra_field).toBe("preserved");
  });

  it("preserves real contact fields", () => {
    const sanitized = sanitizeCompany({
      phone: "+86 139 1234 5678",
      email: "sales@kzq-boards.com",
      whatsapp: "+86 139 1234 5678",
      address_cn: "广东省广州市天河区天河路 100 号",
      address_en: "No. 100 Tianhe Road, Guangzhou",
    });
    expect(sanitized.phone).toBe("+86 139 1234 5678");
    expect(sanitized.email).toBe("sales@kzq-boards.com");
    expect(sanitized.whatsapp).toBe("+86 139 1234 5678");
    expect(sanitized.address_cn).toBe("广东省广州市天河区天河路 100 号");
    expect(sanitized.address_en).toBe("No. 100 Tianhe Road, Guangzhou");
  });

  it("handles null company gracefully", () => {
    expect(sanitizeCompany(null)).toBeNull();
  });
});
