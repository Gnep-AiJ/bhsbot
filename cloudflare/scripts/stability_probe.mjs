const base = process.env.BHS_URL || "https://bhsbot.pages.dev";
const username = process.env.BOSS_USERNAME || "Dongli";
const password = process.env.BOSS_INITIAL_PASSWORD;
if (!password) throw new Error("BOSS_INITIAL_PASSWORD is required");

let cookie = "";
const call = async (path, options = {}) => {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  if (options.body && typeof options.body !== "string") {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  if (!['GET', 'HEAD'].includes(options.method || 'GET')) headers.Origin = base;
  const started = performance.now();
  try {
    const response = await fetch(`${base}${path}`, { ...options, headers, cache: "no-store" });
    const elapsed = performance.now() - started;
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const text = await response.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}
    return { ok: response.ok, status: response.status, elapsed, error: response.ok ? "" : (data.error || text.slice(0, 120) || "empty response"), ray: response.headers.get("cf-ray") || "" , data };
  } catch (error) {
    return { ok: false, status: 0, elapsed: performance.now() - started, error: `network: ${error.message}`, ray: "", data: {} };
  }
};

const login = await call("/api/login", { method: "POST", body: { username, password } });
if (!login.ok) throw new Error(`login failed: ${login.status} ${login.error}`);
const firstPage = await call("/api/products?status=active&page=1");
if (!firstPage.ok) throw new Error(`product list failed: ${firstPage.status} ${firstPage.error}`);
const total = firstPage.data.total;
const pages = firstPage.data.pages;
const ids = [...firstPage.data.products.map((item) => item.id)];
for (let page = 2; page <= pages; page += 1) {
  const result = await call(`/api/products?status=active&page=${page}`);
  if (result.ok) ids.push(...result.data.products.map((item) => item.id));
}
console.log(`DATA products=${total} ids=${ids.length} pages=${pages}`);

const percentile = (values, rate) => {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * rate))] || 0;
};

const runStage = async (name, requests, concurrency) => {
  let cursor = 0;
  const results = [];
  const worker = async () => {
    while (cursor < requests) {
      const index = cursor++;
      const selector = index % 3;
      const path = selector === 0
        ? `/api/dashboard?probe=${name}-${Date.now()}-${index}`
        : selector === 1
          ? `/api/products?status=active&page=${index % pages + 1}&probe=${name}-${Date.now()}-${index}`
          : `/api/products/${ids[index % ids.length]}?probe=${name}-${Date.now()}-${index}`;
      results.push({ path, ...(await call(path)) });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const successes = results.filter((item) => item.ok);
  const times = successes.map((item) => item.elapsed);
  const errors = {};
  for (const item of results.filter((entry) => !entry.ok)) {
    const key = `${item.status}:${item.error}`;
    errors[key] = (errors[key] || 0) + 1;
  }
  const summary = {
    name, requests, concurrency, success: successes.length, failed: requests - successes.length,
    p50_ms: Math.round(percentile(times, .5)), p95_ms: Math.round(percentile(times, .95)), max_ms: Math.round(Math.max(...times, 0)), errors,
  };
  console.log(`STAGE ${JSON.stringify(summary)}`);
  return summary;
};

const stages = [];
stages.push(await runStage("normal", 60, 5));
await new Promise((resolve) => setTimeout(resolve, 1500));
stages.push(await runStage("busy", 90, 12));
await new Promise((resolve) => setTimeout(resolve, 1500));
stages.push(await runStage("burst", 120, 24));
console.log(`COMPLETE ${JSON.stringify(stages)}`);
