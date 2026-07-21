// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useViewerDownload,
  type DownloadResult,
} from "@/components/public/product-asset-viewer/hooks/useViewerDownload";

// jsdom doesn't implement URL.createObjectURL / revokeObjectURL.
beforeAll(() => {
  if (!URL.createObjectURL) URL.createObjectURL = vi.fn(() => "blob:mock");
  if (!URL.revokeObjectURL) URL.revokeObjectURL = vi.fn();
});

async function runDownload(
  url: string,
  filename: string,
  preferredExt: string,
): Promise<DownloadResult> {
  const { result } = renderHook(() => useViewerDownload());
  let ret: DownloadResult | undefined;
  await act(async () => {
    ret = await result.current(url, filename, preferredExt);
  });
  if (!ret) throw new Error("download did not return a result");
  return ret;
}

describe("useViewerDownload", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns invalid for unsafe URLs", async () => {
    const ret = await runDownload("javascript:alert(1)", "file", ".pdf");
    expect(ret).toMatchObject({ status: "invalid" });
  });

  it("returns invalid for blob: URLs", async () => {
    const ret = await runDownload("blob:https://example.com/x", "file", ".pdf");
    expect(ret).toMatchObject({ status: "invalid" });
  });

  it("returns downloaded (blob) when fetch succeeds", async () => {
    const blob = new Blob(["data"], { type: "application/pdf" });
    // Build a Response-like object manually — jsdom's Response constructor
    // does not accept a Blob body reliably.
    const fakeResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/pdf" }),
      blob: async () => blob,
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(fakeResponse as unknown as Response);
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    const ret = await runDownload("/demo/catalogs/test-sample.pdf", "catalog", ".pdf");

    expect(fetchMock).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(ret).toMatchObject({ status: "downloaded", method: "blob" });
  });

  it("returns opened (window) when fetch fails and window.open succeeds for cross-origin", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("CORS"));
    // Anchor click must NOT happen for cross-origin (would navigate current tab).
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    const openMock = vi.spyOn(window, "open").mockReturnValue({} as Window);

    const ret = await runDownload("https://example.com/file.pdf", "catalog", ".pdf");

    expect(clickSpy).not.toHaveBeenCalled();
    expect(openMock).toHaveBeenCalledWith(
      "https://example.com/file.pdf",
      "_blank",
      "noopener,noreferrer",
    );
    expect(ret).toMatchObject({ status: "opened", method: "window" });
  });

  it("returns blocked when window.open returns null", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("CORS"));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.spyOn(window, "open").mockReturnValue(null);

    const ret = await runDownload("https://example.com/file.pdf", "catalog", ".pdf");

    expect(ret).toMatchObject({ status: "blocked" });
    expect(ret.status === "blocked" && ret.reason).toBeTruthy();
  });

  it("returns downloaded (anchor) for same-origin relative path when fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    // For relative path /file.pdf, same-origin → anchor click is treated as downloaded
    const ret = await runDownload("/local-file.pdf", "doc", ".pdf");
    expect(ret).toMatchObject({ status: "downloaded", method: "anchor" });
  });
});
