const baseUrlValue = process.env.BASE_URL;
const expectDemo = process.env.EXPECT_DEMO_MODE === "true";
if (!baseUrlValue) throw new Error("BASE_URL is required");

const baseUrl = new URL(baseUrlValue);
if (!/^https?:$/.test(baseUrl.protocol)) {
  throw new Error("BASE_URL must use HTTP or HTTPS");
}

const paths = [
  "/",
  "/en",
  "/products",
  "/en/products",
  "/certificates",
  "/projects",
  "/privacy",
  "/sitemap.xml",
  "/robots.txt",
  "/api/health",
];
const failures = [];

async function requestWithoutLoop(initialUrl) {
  const visited = new Set();
  let current = initialUrl;
  for (let redirectCount = 0; redirectCount <= 8; redirectCount += 1) {
    if (visited.has(current.href)) throw new Error("redirect loop detected");
    visited.add(current.href);
    const response = await fetch(current, {
      redirect: "manual",
      headers: { "User-Agent": "KZQ-Deployment-Probe/1.0" },
      signal: AbortSignal.timeout(20_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, redirects: redirectCount, finalUrl: current.href };
    }
    const location = response.headers.get("location");
    if (!location)
      throw new Error(`redirect ${response.status} missing Location`);
    current = new URL(location, current);
  }
  throw new Error("more than 8 redirects");
}

for (const path of paths) {
  const startedAt = performance.now();
  try {
    const { response, redirects, finalUrl } = await requestWithoutLoop(
      new URL(path, baseUrl),
    );
    const elapsedMs = Math.round(performance.now() - startedAt);
    const contentType = response.headers.get("content-type") || "(missing)";
    const body = await response.text();
    const isHtml = contentType.toLowerCase().includes("text/html");
    const htmlLang = isHtml
      ? body.match(/<html[^>]*\blang=["']([^"']+)["']/i)?.[1] || "(missing)"
      : "-";
    const title = isHtml
      ? body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ||
        "(missing)"
      : "-";
    const platformError =
      /VERCEL_(?:FUNCTION_)?INVOCATION|Vercel Runtime Error|EDGEONE[^<\n]{0,40}(?:FUNCTION|INTERNAL)[^<\n]{0,40}ERROR/i.test(
        body,
      );
    const demoContent = /kzq-demo\.com|\bmock-[a-z0-9-]+\b/i.test(body);

    console.log(
      `${path} status=${response.status} time=${elapsedMs}ms type=${contentType} lang=${htmlLang} title=${JSON.stringify(title)} redirects=${redirects} final=${finalUrl}`,
    );

    if (!response.ok) failures.push(`${path}: HTTP ${response.status}`);
    if (isHtml && title === "(missing)")
      failures.push(`${path}: missing title`);
    if (platformError) failures.push(`${path}: platform error page detected`);
    if (!expectDemo && demoContent)
      failures.push(`${path}: Demo content detected`);

    if (path === "/api/health" && response.ok) {
      try {
        const health = JSON.parse(body);
        if (health.success !== true)
          failures.push(`${path}: success is not true`);
        if (Boolean(health.demo) !== expectDemo) {
          failures.push(
            `${path}: demo=${String(health.demo)} but EXPECT_DEMO_MODE=${String(expectDemo)}`,
          );
        }
      } catch {
        failures.push(`${path}: invalid JSON`);
      }
    }
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`${path} ERROR time=${elapsedMs}ms ${message}`);
    failures.push(`${path}: ${message}`);
  }
}

if (failures.length) {
  console.error("Deployment probe failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Deployment probe passed.");
