import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("public brand logo contract", () => {
  it("ships a tight black-gold official vector asset", () => {
    const logo = source("public/brand/kzq-logo-black-gold.svg");
    expect(logo).toContain('viewBox="-8 -8 1447 450"');
    expect(logo).toContain('fill="#090B0C"');
    expect(logo).toContain('stroke="#C9A24C"');
    expect(logo).not.toContain("WALL PANEL");
  });

  it("uses the official asset as a reliable fallback and preserves CMS overrides", () => {
    const component = source("components/public/BrandLogo.tsx");
    expect(component).toContain('OFFICIAL_KZQ_LOGO = "/brand/kzq-logo-black-gold.svg"');
    expect(component).toContain("customSource && !customFailed");
    expect(component).toContain("object-contain");
  });

  it("renders a readable logo size in both public headers", () => {
    const desktop = source("components/public/DesktopHeader.tsx");
    const mobile = source("components/public/MobileHeader.tsx");
    expect(desktop).toContain("size={104}");
    expect(mobile).toContain("size={86}");
  });
});
