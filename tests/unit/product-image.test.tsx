// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductImage } from "@/components/public/ProductImage";

// next/image relies on the Image Optimization API and canvas APIs that jsdom
// does not implement. Mock it so we can assert on the wrapper markup and the
// onError fallback path. The mock renders a plain <img> and forwards onError.
vi.mock("next/image", () => ({
  default: (props: {
    src: string;
    alt: string;
    onError?: () => void;
    className?: string;
  }) => <img alt={props.alt} src={props.src} onError={props.onError} />,
}));

afterEach(() => {
  cleanup();
});

describe("ProductImage fallback", () => {
  it("renders a placeholder with role=img when src is null", () => {
    const { container } = render(<ProductImage src={null} alt="防火板" />);
    const placeholder = container.querySelector('[role="img"]');
    expect(placeholder).not.toBeNull();
    expect(placeholder).toHaveAttribute("aria-label", "防火板");
  });

  it("renders a placeholder when src is undefined", () => {
    const { container } = render(<ProductImage src={undefined} alt="Fire Board" />);
    const placeholder = container.querySelector('[role="img"]');
    expect(placeholder).not.toBeNull();
    expect(placeholder).toHaveAttribute("aria-label", "Fire Board");
  });

  it("renders the KZQ fallback text by default", () => {
    const { container } = render(<ProductImage src={null} alt="产品" />);
    expect(container.textContent).toContain("KZQ");
  });

  it("renders a custom fallback text when provided", () => {
    const { container } = render(<ProductImage src={null} alt="产品" fallbackText="Custom" />);
    expect(container.textContent).toContain("Custom");
  });

  it("does not render a broken image icon when src is missing", () => {
    const { container } = render(<ProductImage src={null} alt="产品" />);
    // No <img> element should be present — only the placeholder div.
    expect(container.querySelector("img")).toBeNull();
  });

  it("falls back to placeholder after an image load error", () => {
    const { container } = render(<ProductImage src="/missing.jpg" alt="测试产品" />);
    // Initially the <img> is rendered.
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    // Simulate a load error — ProductImage should switch to the placeholder.
    fireEvent(img!, new Event("error"));
    const placeholder = container.querySelector('[role="img"][aria-label="测试产品"]');
    expect(placeholder).not.toBeNull();
    // The broken <img> should no longer be present.
    expect(container.querySelector("img")).toBeNull();
  });

  it("uses a stable gradient for the same alt text", () => {
    const { container: a } = render(<ProductImage src={null} alt="防火板" />);
    const styleA = a.querySelector('[role="img"]')?.getAttribute("style");
    cleanup();
    const { container: b } = render(<ProductImage src={null} alt="防火板" />);
    const styleB = b.querySelector('[role="img"]')?.getAttribute("style");
    expect(styleA).toBe(styleB);
  });
});
