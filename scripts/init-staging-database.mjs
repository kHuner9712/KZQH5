import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const confirmation = process.env.KZQ_STAGING_CONFIRMATION;
const databaseUrl = process.env.DATABASE_STAGING_URL;
const expectedRef = process.env.KZQ_STAGING_PROJECT_REF;

if (confirmation !== "KZQ-STAGING-ONLY") {
  throw new Error(
    "Remote initialization refused: set KZQ_STAGING_CONFIRMATION=KZQ-STAGING-ONLY",
  );
}
if (!databaseUrl || !expectedRef) {
  throw new Error(
    "DATABASE_STAGING_URL and KZQ_STAGING_PROJECT_REF are required",
  );
}

const parsed = new URL(databaseUrl);
if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
  throw new Error("DATABASE_STAGING_URL must be a PostgreSQL connection URL");
}
if (!parsed.username || !parsed.password) {
  throw new Error(
    "DATABASE_STAGING_URL must include a database user and password",
  );
}
if (!/^[a-z0-9-]{6,64}$/i.test(expectedRef)) {
  throw new Error("KZQ_STAGING_PROJECT_REF has an invalid format");
}
if (
  !parsed.hostname.includes(expectedRef) &&
  !decodeURIComponent(parsed.username).includes(expectedRef)
) {
  throw new Error(
    "KZQ_STAGING_PROJECT_REF does not match the database host or pooler user",
  );
}
if (
  !parsed.hostname.endsWith(".supabase.co") &&
  !parsed.hostname.endsWith(".supabase.com")
) {
  throw new Error("Only a Supabase Staging host is accepted");
}

const psqlArgs = [
  "--host",
  parsed.hostname,
  "--port",
  parsed.port || "5432",
  "--username",
  decodeURIComponent(parsed.username),
  "--dbname",
  parsed.pathname.slice(1) || "postgres",
  "--no-psqlrc",
  "--set",
  "ON_ERROR_STOP=1",
];
const psqlEnv = {
  ...process.env,
  PGPASSWORD: decodeURIComponent(parsed.password),
  PGSSLMODE: "require",
  PGOPTIONS: "-c client_min_messages=warning",
};

function psql(extraArgs, input, capture = false) {
  const result = spawnSync("psql", [...psqlArgs, ...extraArgs], {
    cwd: root,
    env: psqlEnv,
    encoding: "utf8",
    input,
    stdio: capture
      ? ["pipe", "pipe", "inherit"]
      : ["pipe", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`psql exited with ${result.status}`);
  return capture ? result.stdout.trim() : "";
}

const publicTableCount = psql(
  [
    "--tuples-only",
    "--no-align",
    "--command",
    "select count(*) from pg_tables where schemaname = 'public';",
  ],
  undefined,
  true,
);
if (publicTableCount !== "0") {
  throw new Error(
    `Remote initialization refused: public schema is not empty (${publicTableCount} tables). This script never resets an existing project.`,
  );
}

const installFiles = [
  "supabase/schema.sql",
  "supabase/policies.sql",
  "supabase/seed.sql",
  "supabase/cms_seed.sql",
  "supabase/migrations/20260713181111_upgrade_inquiries.sql",
  "supabase/migrations/20260714032351_b2b_product_search_and_inquiry_items.sql",
  "supabase/migrations/20260714084116_procurement_assets_and_projects.sql",
  "supabase/migrations/20260714125149_production_stability_analytics_wechat.sql",
  "supabase/migrations/20260714201851_enforce_inquiry_product_integrity.sql",
  "supabase/migrations/20260715090000_security_hardening_explicit_grants.sql",
];

const transaction = [
  ...installFiles.flatMap((path) => [
    `\\echo Applying ${path}`,
    readFileSync(resolve(root, path), "utf8"),
  ]),
].join("\n");

psql(["--single-transaction"], transaction);
console.log("Staging database initialization completed without reset.");
console.log(`Applied ${installFiles.length} reviewed SQL files.`);
