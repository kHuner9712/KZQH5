import { describe, expect, it } from "vitest";
import { mergeInquiryAttribution } from "@/lib/client/inquiry-attribution";

describe("inquiry attribution", () => {
  it("captures source, channel and UTM fields", () => {
    const result = mergeInquiryAttribution({
      existing: {},
      search:
        "?source=qr&channel=wechat&utm_source=campaign&utm_medium=social&utm_campaign=launch",
      origin: "https://kzq.test",
    });
    expect(result).toMatchObject({
      source: "qr",
      channel: "wechat",
      utm_source: "campaign",
      utm_medium: "social",
      utm_campaign: "launch",
    });
  });

  it("retains a valid session source and does not let direct overwrite it", () => {
    const result = mergeInquiryAttribution({
      existing: { source: "google", channel: "organic" },
      search: "?source=direct",
      origin: "https://kzq.test",
    });
    expect(result.source).toBe("google");
    expect(result.channel).toBe("organic");
  });

  it("derives source from an external referrer", () => {
    const result = mergeInquiryAttribution({
      existing: { source: "direct" },
      search: "",
      referrer: "https://buyer.example/path?q=private",
      origin: "https://kzq.test",
    });
    expect(result.source).toBe("buyer.example");
  });
});
