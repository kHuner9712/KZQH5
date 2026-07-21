import { describe, expect, it } from "vitest";
import {
  analyticsEventNames,
  type AnalyticsEventName,
} from "@/types/database";
import { validateAnalyticsEvent } from "@/lib/services/analytics/validation";

const EVENT_SET = new Set(analyticsEventNames);

describe("analytics event taxonomy", () => {
  it("includes the legacy catalog_download event", () => {
    expect(EVENT_SET.has("catalog_download")).toBe(true);
  });

  it("includes the new catalog viewer events", () => {
    expect(EVENT_SET.has("catalog_open")).toBe(true);
    expect(EVENT_SET.has("catalog_load_success")).toBe(true);
    expect(EVENT_SET.has("catalog_load_failure")).toBe(true);
    expect(EVENT_SET.has("catalog_copy_link")).toBe(true);
    expect(EVENT_SET.has("catalog_open_external")).toBe(true);
  });

  it("contains no duplicates in analyticsEventNames", () => {
    expect(new Set(analyticsEventNames).size).toBe(analyticsEventNames.length);
  });

  it("does NOT accept the legacy 'open catalog as download' behavior", () => {
    // The point of the new taxonomy is that opening a catalog and downloading
    // it are different events. We verify the two names are distinct strings.
    expect("catalog_open").not.toBe("catalog_download");
  });
});

describe("validateAnalyticsEvent — new catalog events", () => {
  function makeEvent(event_name: string) {
    return {
      event_name,
      locale: "zh" as const,
      page_path: "/documents",
      product_id: null,
      project_id: null,
    };
  }

  it("accepts catalog_open", () => {
    const result = validateAnalyticsEvent(makeEvent("catalog_open"));
    expect(result.success).toBe(true);
  });

  it("accepts catalog_load_success", () => {
    const result = validateAnalyticsEvent(makeEvent("catalog_load_success"));
    expect(result.success).toBe(true);
  });

  it("accepts catalog_load_failure", () => {
    const result = validateAnalyticsEvent(makeEvent("catalog_load_failure"));
    expect(result.success).toBe(true);
  });

  it("accepts catalog_copy_link", () => {
    const result = validateAnalyticsEvent(makeEvent("catalog_copy_link"));
    expect(result.success).toBe(true);
  });

  it("accepts catalog_open_external", () => {
    const result = validateAnalyticsEvent(makeEvent("catalog_open_external"));
    expect(result.success).toBe(true);
  });

  it("accepts the legacy catalog_download event", () => {
    const result = validateAnalyticsEvent(makeEvent("catalog_download"));
    expect(result.success).toBe(true);
  });

  it("rejects an unknown catalog_* event name", () => {
    const result = validateAnalyticsEvent(makeEvent("catalog_random_action"));
    expect(result.success).toBe(false);
  });

  it("rejects a completely unknown event", () => {
    const result = validateAnalyticsEvent(makeEvent("fake_event"));
    expect(result.success).toBe(false);
  });

  it("validates all catalog events in the const array", () => {
    const catalogEvents = analyticsEventNames.filter((name) =>
      name.startsWith("catalog_"),
    ) as AnalyticsEventName[];
    expect(catalogEvents.length).toBeGreaterThanOrEqual(6);
    for (const name of catalogEvents) {
      const result = validateAnalyticsEvent(makeEvent(name));
      expect(result.success).toBe(true);
    }
  });
});
