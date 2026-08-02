import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

it("reports the new homepage migration sha256 for manifest registration", () => {
  const file = readFileSync(
    join(
      process.cwd(),
      "supabase",
      "migrations",
      "20260802193000_homepage_hero_carousel_and_copy.sql",
    ),
  );
  const hash = createHash("sha256").update(file).digest("hex");
  expect(hash, `MIGRATION_SHA256=${hash}`).toBe("PENDING_MANIFEST_REGISTRATION");
});
