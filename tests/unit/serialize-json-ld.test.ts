import { describe, expect, it } from "vitest";
import { serializeJsonLd } from "@/lib/utils";

// ============================================================
// serializeJsonLd — JSON-LD 安全序列化测试 (KZQ-P1-004-c)
//
// 验证：
//   1. 基本序列化正确性
//   2. XSS 注入防御（</script> 标签闭合攻击）
//   3. 防御深度转义（>, &, U+2028, U+2029）
//   4. 嵌套对象和数组中的恶意字符串
//   5. CMS 数据场景（产品名、FAQ、公司信息）
//   6. 边界值（null, undefined, 数字, 布尔）
//   7. 转义后 JSON 仍可被 JSON.parse 正确解析
// ============================================================

describe("serializeJsonLd — 基本序列化", () => {
  it("序列化简单对象", () => {
    const result = serializeJsonLd({ "@type": "Product", name: "Test" });
    expect(result).toBe('{"@type":"Product","name":"Test"}');
  });

  it("序列化字符串", () => {
    expect(serializeJsonLd("hello")).toBe('"hello"');
  });

  it("序列化数字", () => {
    expect(serializeJsonLd(42)).toBe("42");
  });

  it("序列化布尔值", () => {
    expect(serializeJsonLd(true)).toBe("true");
  });

  it("序列化 null", () => {
    expect(serializeJsonLd(null)).toBe("null");
  });

  it("序列化数组", () => {
    expect(serializeJsonLd([1, "two", false])).toBe('[1,"two",false]');
  });
});

describe("serializeJsonLd — XSS 注入防御", () => {
  it("转义 < 阻止 </script> 闭合标签注入", () => {
    const malicious = '</script><script>alert("xss")</script>';
    const result = serializeJsonLd(malicious);
    expect(result).not.toContain("</script>");
    expect(result).not.toContain("<script>");
    expect(result).toContain("\\u003c");
    expect(result).toContain("\\u003e");
  });

  it("转义字符串值中的 < ", () => {
    const result = serializeJsonLd({ name: "<script>alert(1)</script>" });
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("</script>");
    expect(result).toContain("\\u003cscript\\u003e");
  });

  it("转义嵌套对象中的 </script>", () => {
    const data = {
      outer: { inner: "</script><img src=x onerror=alert(1)>" },
    };
    const result = serializeJsonLd(data);
    expect(result).not.toContain("</script>");
    expect(result).not.toContain("<img");
    expect(result).toContain("\\u003c");
  });

  it("转义数组元素中的 </script>", () => {
    const data = { items: ["safe", "</script><script>alert(1)</script>"] };
    const result = serializeJsonLd(data);
    expect(result).not.toContain("</script>");
    expect(result).toContain("\\u003c/script\\u003e");
  });
});

describe("serializeJsonLd — 防御深度转义", () => {
  it("转义 > 为 \\u003e", () => {
    const result = serializeJsonLd("a>b");
    expect(result).not.toContain(">");
    expect(result).toContain("\\u003e");
  });

  it("转义 & 为 \\u0026", () => {
    const result = serializeJsonLd("a&b");
    expect(result).not.toContain("&");
    expect(result).toContain("\\u0026");
  });

  it("转义 U+2028 (行分隔符)", () => {
    const result = serializeJsonLd("line1\u2028line2");
    // U+2028 should be replaced with the literal escape sequence \u2028
    expect(result).not.toContain("\u2028");
    expect(result).toContain("\\u2028");
  });

  it("转义 U+2029 (段落分隔符)", () => {
    const result = serializeJsonLd("para1\u2029para2");
    expect(result).not.toContain("\u2029");
    expect(result).toContain("\\u2029");
  });

  it("同时转义所有危险字符", () => {
    const malicious = '</script>&\u2028\u2029>';
    const result = serializeJsonLd(malicious);
    expect(result).not.toContain("<");
    expect(result).not.toContain(">");
    expect(result).not.toContain("&");
    expect(result).not.toContain("\u2028");
    expect(result).not.toContain("\u2029");
  });
});

describe("serializeJsonLd — CMS 数据场景", () => {
  it("安全序列化产品 JSON-LD（含 CMS 管理的产品名和描述）", () => {
    const productJsonLd = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "防火板 <test>",
      description: "高品质产品 & 耐用",
      image: ["https://example.com/img.jpg"],
      sku: "product-001",
    };
    const result = serializeJsonLd(productJsonLd);
    expect(result).not.toContain("<test>");
    expect(result).not.toContain("&");
    expect(result).toContain("\\u003ctest\\u003e");
    expect(result).toContain("\\u0026");
    // JSON 结构保持完整
    expect(result).toContain('"@type":"Product"');
    expect(result).toContain('"sku":"product-001"');
  });

  it("安全序列化 FAQ JSON-LD（含 CMS 管理的问答）", () => {
    const faqJsonLd = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "什么是 </script> 攻击？",
          acceptedAnswer: {
            "@type": "Answer",
            text: "一种 XSS 注入方式 > &",
          },
        },
      ],
    };
    const result = serializeJsonLd(faqJsonLd);
    expect(result).not.toContain("</script>");
    expect(result).not.toContain(">");
    expect(result).not.toContain("&");
    expect(result).toContain("\\u003c/script\\u003e");
  });

  it("安全序列化 Organization JSON-LD（含公司地址和电话）", () => {
    const organization = {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "KZQ",
      address: { "@type": "PostalAddress", streetAddress: "某路 & 某街" },
      contactPoint: { "@type": "ContactPoint", telephone: "+86-123" },
    };
    const result = serializeJsonLd(organization);
    expect(result).not.toContain("&");
    expect(result).toContain("\\u0026");
  });

  it("安全序列化 CollectionPage JSON-LD（含分类名称）", () => {
    const collectionJsonLd = {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      mainEntity: {
        "@type": "ItemList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "目录 <1>" },
          { "@type": "ListItem", position: 2, name: "目录 & 2" },
        ],
      },
    };
    const result = serializeJsonLd(collectionJsonLd);
    expect(result).not.toContain("<1>");
    expect(result).not.toContain("& 2");
    expect(result).toContain("\\u003c1\\u003e");
    expect(result).toContain("\\u0026 2");
  });
});

describe("serializeJsonLd — JSON 可解析性", () => {
  it("转义后的 JSON 仍可被 JSON.parse 正确解析", () => {
    const data = {
      name: "</script>&\u2028\u2029>",
      nested: { value: "<img src=x>" },
    };
    const serialized = serializeJsonLd(data);
    // JSON.parse should recover the original data (the \uXXXX escapes are
    // standard JSON string escapes)
    const parsed = JSON.parse(serialized);
    expect(parsed.name).toBe(data.name);
    expect(parsed.nested.value).toBe(data.nested.value);
  });

  it("转义后的 JSON-LD 可被 JSON.parse 恢复为原始对象结构", () => {
    const productJsonLd = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "产品 </script>",
      description: "描述 & 介绍",
    };
    const serialized = serializeJsonLd(productJsonLd);
    const parsed = JSON.parse(serialized);
    expect(parsed).toEqual(productJsonLd);
    expect(parsed.name).toBe("产品 </script>");
    expect(parsed.description).toBe("描述 & 介绍");
  });
});

describe("serializeJsonLd — 边界值", () => {
  it("undefined 值在对象中被 JSON.stringify 忽略", () => {
    const result = serializeJsonLd({ a: 1, b: undefined });
    expect(result).toBe('{"a":1}');
  });

  it("空对象序列化为 {}", () => {
    expect(serializeJsonLd({})).toBe("{}");
  });

  it("空数组序列化为 []", () => {
    expect(serializeJsonLd([])).toBe("[]");
  });

  it("空字符串序列化为空 JSON 字符串", () => {
    expect(serializeJsonLd("")).toBe('""');
  });

  it("含引号的字符串正确转义", () => {
    const result = serializeJsonLd('say "hello"');
    expect(result).toBe('"say \\"hello\\""');
  });

  it("含反斜杠的字符串正确转义", () => {
    const result = serializeJsonLd("path\\to\\file");
    expect(result).toBe('"path\\\\to\\\\file"');
  });
});
