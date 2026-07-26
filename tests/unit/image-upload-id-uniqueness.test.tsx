// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { ImageUpload } from "@/components/admin/ImageUpload";

// Mock the storage fetch helpers — we never hit the network in this test.
vi.mock("@/lib/services/admin-storage-fetch", () => ({
  uploadViaServerApi: vi.fn(),
  deleteViaServerApi: vi.fn(),
  enqueueCleanupViaServerApi: vi.fn(),
  fetchPrivatePreviewUrl: vi.fn().mockResolvedValue({ ok: false }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  // jsdom doesn't implement URL.createObjectURL; the upload path doesn't
  // run in these tests, but keep the mock in place for safety.
  if (!("createObjectURL" in URL)) {
    Object.defineProperty(URL, "createObjectURL", {
      value: () => "blob:mock",
      configurable: true,
    });
  }
});

describe("ImageUpload — unique input id (Section 12)", () => {
  it("renders distinct input ids when two uploaders share the same purpose", () => {
    const { container: c1 } = render(
      <ImageUpload
        value=""
        onChange={() => {}}
        purpose="product-image"
        label="封面图"
      />,
    );
    const { container: c2 } = render(
      <ImageUpload
        value=""
        onChange={() => {}}
        purpose="product-image"
        label="详情图 1"
      />,
    );
    const input1 = c1.querySelector<HTMLInputElement>('input[type="file"]');
    const input2 = c2.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input1).not.toBeNull();
    expect(input2).not.toBeNull();
    expect(input1!.id).not.toBe(input2!.id);
    // Both ids must still start with the purpose prefix for debuggability.
    expect(input1!.id.startsWith("upload-product-image-")).toBe(true);
    expect(input2!.id.startsWith("upload-product-image-")).toBe(true);
  });

  it("binds each label to its own input via htmlFor (click does not leak)", async () => {
    const user = userEvent.setup();
    const { container: c1 } = render(
      <ImageUpload
        value=""
        onChange={() => {}}
        purpose="company-logo"
        label="Logo"
      />,
    );
    const { container: c2 } = render(
      <ImageUpload
        value=""
        onChange={() => {}}
        purpose="company-logo"
        label="微信二维码"
      />,
    );

    const input1 = c1.querySelector<HTMLInputElement>('input[type="file"]')!;
    const input2 = c2.querySelector<HTMLInputElement>('input[type="file"]')!;
    // The upload button label wraps the "上传图片" text (value is empty).
    const label1 = c1.querySelector<HTMLLabelElement>(
      'label:has(> svg.lucide-upload)',
    )!;
    const label2 = c2.querySelector<HTMLLabelElement>(
      'label:has(> svg.lucide-upload)',
    )!;

    expect(label1.htmlFor).toBe(input1.id);
    expect(label2.htmlFor).toBe(input2.id);
    expect(label1.htmlFor).not.toBe(label2.htmlFor);

    // Clicking the first label should only focus the first input.
    await user.click(label1);
    // jsdom doesn't fire the OS-level file picker, but document.activeElement
    // should reflect the label→input association. We assert it is the first
    // input, NOT the second.
    expect(document.activeElement).toBe(input1);
    expect(document.activeElement).not.toBe(input2);
  });

  it("renders distinct ids across different purpose types on the same page", () => {
    const { container } = render(
      <div>
        <ImageUpload
          value=""
          onChange={() => {}}
          purpose="catalog-draft"
          label="Catalog 1"
        />
        <ImageUpload
          value=""
          onChange={() => {}}
          purpose="catalog-draft"
          label="Catalog 2"
        />
        <ImageUpload
          value=""
          onChange={() => {}}
          purpose="certificate-draft"
          label="Certificate 1"
        />
      </div>,
    );
    const inputs = container.querySelectorAll<HTMLInputElement>(
      'input[type="file"]',
    );
    expect(inputs.length).toBe(3);
    const ids = new Set<string>();
    inputs.forEach((input) => ids.add(input.id));
    expect(ids.size).toBe(3);
  });
});
