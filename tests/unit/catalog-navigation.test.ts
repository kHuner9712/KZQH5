import { describe, expect, it } from "vitest";
import { navigationWithProjects } from "@/lib/i18n/content";
import type { NavItem } from "@/types/database";

const baseNavigation: NavItem[] = [
  { href: "/", label_cn: "首页", label_en: "Home", sort_order: 0 },
  { href: "/products", label_cn: "产品", label_en: "Products", sort_order: 1 },
  { href: "/contact", label_cn: "联系", label_en: "Contact", sort_order: 5 },
];

describe("catalog navigation", () => {
  it("inserts documents and projects once", () => {
    const result = navigationWithProjects(baseNavigation);
    expect(result.filter((item) => item.href === "/documents")).toHaveLength(1);
    expect(result.filter((item) => item.href === "/projects")).toHaveLength(1);
  });

  it("does not duplicate CMS configured entries", () => {
    const result = navigationWithProjects([
      ...baseNavigation,
      { href: "/documents", label_cn: "目录", label_en: "Catalogs", sort_order: 2 },
      { href: "/projects", label_cn: "案例", label_en: "Projects", sort_order: 3 },
    ]);
    expect(result.filter((item) => item.href === "/documents")).toHaveLength(1);
    expect(result.filter((item) => item.href === "/projects")).toHaveLength(1);
  });

  it("does not mutate the source array", () => {
    const original = structuredClone(baseNavigation);
    navigationWithProjects(baseNavigation);
    expect(baseNavigation).toEqual(original);
  });
});
