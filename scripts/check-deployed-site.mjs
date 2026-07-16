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
  "/en/certificates",
  "/projects",
  "/en/projects",
  "/contact",
  "/en/contact",
  "/more",
  "/en/more",
  "/privacy",
  "/en/privacy",
  "/admin/login",
  "/products?q=a",
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

if (baseUrl.protocol === "https:") {
  for (const path of [
    "/",
    "/products?source=regression-gate&utm_medium=probe",
  ]) {
    const insecureUrl = new URL(path, baseUrl);
    insecureUrl.protocol = "http:";
    try {
      const { response, redirects, finalUrl } =
        await requestWithoutLoop(insecureUrl);
      const final = new URL(finalUrl);
      console.log(
        `HTTP redirect ${path} status=${response.status} redirects=${redirects} final=${finalUrl}`,
      );
      if (redirects === 0)
        failures.push(`HTTP origin ${path}: did not redirect to HTTPS`);
      if (final.protocol !== "https:" || final.host !== baseUrl.host) {
        failures.push(
          `HTTP origin ${path}: redirect target is not the stable HTTPS host`,
        );
      }
      if (
        final.pathname !== insecureUrl.pathname ||
        final.search !== insecureUrl.search
      ) {
        failures.push(`HTTP origin ${path}: redirect did not preserve path/query`);
      }
      if (!response.ok)
        failures.push(`HTTP origin ${path}: final HTTP ${response.status}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`HTTP origin ${path}: ${message}`);
    }
  }
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
    const previewParameterPattern = new RegExp(
      `(?:eo_${"token"}|eo_${"time"})(?:=|%3D)`,
      "i",
    );
    const previewToken = previewParameterPattern.test(
      `${body}\n${finalUrl}`,
    );
    const final = new URL(finalUrl);
    const previewAuthPage = isHtml && /Tencent Edgeone/i.test(title);

    console.log(
      `${path} status=${response.status} time=${elapsedMs}ms type=${contentType} lang=${htmlLang} title=${JSON.stringify(title)} redirects=${redirects} final=${finalUrl}`,
    );

    if (!response.ok) failures.push(`${path}: HTTP ${response.status}`);
    if (final.host !== baseUrl.host)
      failures.push(`${path}: redirected away from stable host`);
    if (isHtml && title === "(missing)" && path !== "/admin/login")
      failures.push(`${path}: missing title`);
    if (platformError) failures.push(`${path}: platform error page detected`);
    if (previewAuthPage)
      failures.push(`${path}: EdgeOne preview authentication page detected`);
    if (!expectDemo && demoContent)
      failures.push(`${path}: Demo content detected`);
    if (previewToken)
      failures.push(`${path}: EdgeOne preview token leaked into content or URL`);

    if (isHtml && response.ok && path !== "/admin/login") {
      const canonical = body.match(
        /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
      )?.[1];
      const openGraphUrl = body.match(
        /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i,
      )?.[1];
      if (!canonical) failures.push(`${path}: missing canonical`);
      if (!openGraphUrl) failures.push(`${path}: missing Open Graph URL`);
      if (canonical && new URL(canonical, baseUrl).origin !== baseUrl.origin)
        failures.push(`${path}: canonical does not use stable origin`);
      if (
        openGraphUrl &&
        new URL(openGraphUrl, baseUrl).origin !== baseUrl.origin
      )
        failures.push(`${path}: Open Graph URL does not use stable origin`);
      if (canonical && previewParameterPattern.test(canonical))
        failures.push(`${path}: preview token in canonical`);
      if (openGraphUrl && previewParameterPattern.test(openGraphUrl))
        failures.push(`${path}: preview token in Open Graph URL`);
    }

    if (path === "/sitemap.xml" && response.ok) {
      if (!body.includes(`${baseUrl.origin}/`))
        failures.push(`${path}: stable origin is missing`);
      if (
        baseUrl.hostname !== "edgeone.dev" &&
        !baseUrl.hostname.endsWith(".edgeone.dev") &&
        /https?:\/\/[^<]*edgeone\.dev/i.test(body)
      )
        failures.push(`${path}: EdgeOne project domain leaked into sitemap`);
    }

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
        if (!expectDemo && health.dataProvider !== "supabase")
          failures.push(`${path}: dataProvider is not supabase`);
        if (health.runtime !== "nodejs")
          failures.push(`${path}: runtime is not nodejs`);
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
