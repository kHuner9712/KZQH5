import { describe, expect, it } from "vitest";
import { isPostgresUuid } from "@/lib/validation/postgres-uuid";

describe("PostgreSQL UUID validation", () => {
  it("accepts ordinary RFC UUIDs", () => {
    expect(isPostgresUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
  });

  it("accepts deterministic UUID values already stored by PostgreSQL", () => {
    expect(isPostgresUuid("77777777-7777-7777-7777-777777777701")).toBe(true);
    expect(isPostgresUuid("33333333-3333-3333-3333-333333333307")).toBe(true);
  });

  it("rejects malformed or non-canonical values", () => {
    expect(isPostgresUuid("not-a-uuid")).toBe(false);
    expect(isPostgresUuid("77777777777777777777777777777777")).toBe(false);
    expect(isPostgresUuid("77777777-7777-7777-7777-77777777770g")).toBe(false);
    expect(isPostgresUuid(null)).toBe(false);
  });
});
