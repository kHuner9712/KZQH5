import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const freshUrl = process.env.DATABASE_TEST_URL;
const upgradeUrl = process.env.DATABASE_UPGRADE_TEST_URL;
const dockerContainer = process.env.DATABASE_TEST_DOCKER_CONTAINER;
const legacyCommit = process.env.LEGACY_BASELINE_COMMIT || "d5c5822";

function requireDisposableLocalUrl(value, name) {
  if (!value) throw new Error(`${name} is required`);
  const parsed = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error(
      `${name} must point to localhost; remote and production databases are refused`,
    );
  }
  if (!/_test$/.test(parsed.pathname.slice(1))) {
    throw new Error(`${name} database name must end with _test`);
  }
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.input ? ["pipe", "inherit", "inherit"] : "inherit",
    input: options.input,
    env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited with ${result.status}`);
}

function psql(url, sql) {
  if (dockerContainer) {
    run(
      "docker",
      [
        "exec",
        "-i",
        dockerContainer,
        "psql",
        "-U",
        "postgres",
        "-d",
        url,
        "--no-psqlrc",
        "--set",
        "ON_ERROR_STOP=1",
      ],
      { input: sql },
    );
    return;
  }
  run("psql", [url, "--no-psqlrc", "--set", "ON_ERROR_STOP=1"], { input: sql });
}

function requireDisposableDatabaseName(value, name) {
  if (!value || !/^[a-z][a-z0-9_]*_test$/.test(value)) {
    throw new Error(`${name} must be a simple database name ending in _test`);
  }
  return value;
}

function prepareDockerDatabase(name) {
  if (!dockerContainer?.startsWith("kzq-")) {
    throw new Error("DATABASE_TEST_DOCKER_CONTAINER must start with kzq-");
  }
  run("docker", [
    "exec",
    dockerContainer,
    "dropdb",
    "-U",
    "postgres",
    "--if-exists",
    name,
  ]);
  run("docker", ["exec", dockerContainer, "createdb", "-U", "postgres", name]);
}

function currentFile(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function gitFile(commit, path) {
  const result = spawnSync("git", ["show", `${commit}:${path}`], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(`Unable to read ${path} from ${commit}`);
  return result.stdout;
}

function migrations() {
  return readdirSync(resolve(root, "supabase/migrations"))
    .filter((name) => /^\d{14}_.+\.sql$/.test(name))
    .sort()
    .map((name) => `supabase/migrations/${name}`);
}

function reset(url) {
  psql(url, currentFile("supabase/tests/reset.sql"));
  psql(url, currentFile("supabase/tests/bootstrap.sql"));
}

function freshInstall(url) {
  reset(url);
  for (const path of [
    "supabase/schema.sql",
    "supabase/policies.sql",
    "supabase/seed.sql",
    "supabase/cms_seed.sql",
    ...migrations(),
  ]) {
    psql(url, currentFile(path));
  }
  psql(url, currentFile("supabase/tests/permission_matrix.sql"));
  psql(url, currentFile("supabase/tests/atomic_inquiry.sql"));
  psql(url, currentFile("supabase/tests/dashboard_snapshot.sql"));
}

function incrementalUpgrade(url) {
  reset(url);
  for (const path of [
    "supabase/schema.sql",
    "supabase/policies.sql",
    "supabase/seed.sql",
    "supabase/cms_seed.sql",
  ]) {
    psql(url, gitFile(legacyCommit, path));
  }
  psql(url, currentFile("supabase/tests/legacy_sentinels.sql"));
  for (const path of migrations()) psql(url, currentFile(path));
  psql(url, currentFile("supabase/tests/assert_legacy_sentinels.sql"));
  psql(url, currentFile("supabase/tests/permission_matrix.sql"));
  psql(url, currentFile("supabase/tests/atomic_inquiry.sql"));
  psql(url, currentFile("supabase/tests/dashboard_snapshot.sql"));
}

try {
  let freshTarget;
  let upgradeTarget;
  if (dockerContainer) {
    freshTarget = requireDisposableDatabaseName(
      process.env.DATABASE_TEST_NAME || "kzq_fresh_test",
      "DATABASE_TEST_NAME",
    );
    upgradeTarget = requireDisposableDatabaseName(
      process.env.DATABASE_UPGRADE_TEST_NAME || "kzq_upgrade_test",
      "DATABASE_UPGRADE_TEST_NAME",
    );
    prepareDockerDatabase(freshTarget);
    prepareDockerDatabase(upgradeTarget);
  } else {
    run("psql", ["--version"]);
    freshTarget = requireDisposableLocalUrl(freshUrl, "DATABASE_TEST_URL");
    upgradeTarget = requireDisposableLocalUrl(
      upgradeUrl,
      "DATABASE_UPGRADE_TEST_URL",
    );
  }
  freshInstall(freshTarget);
  incrementalUpgrade(upgradeTarget);
  console.log(
    "Database verification completed for fresh install and incremental upgrade.",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
