const base = process.env.BHS_URL || "https://bhsbot.pages.dev";
const username = process.env.BOSS_USERNAME || "Dongli";
const password = process.env.BOSS_INITIAL_PASSWORD;
if (!password) throw new Error("BOSS_INITIAL_PASSWORD is required");

let cookie = "";
const request = async (path, options = {}) => {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  if (options.body && typeof options.body !== "string") {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  if (!['GET', 'HEAD'].includes(options.method || 'GET')) headers.Origin = base;
  const started = performance.now();
  const response = await fetch(`${base}${path}`, { ...options, headers, redirect: "manual", cache: "no-store" });
  const elapsed = performance.now() - started;
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return { response, elapsed };
};

const json = async (path, options = {}) => {
  const result = await request(path, options);
  const data = await result.response.json().catch(() => ({}));
  if (!result.response.ok) throw new Error(`${path}: ${result.response.status} ${data.error || JSON.stringify(data)}`);
  return { data, elapsed: result.elapsed };
};

const percentile = (values, rate) => {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * rate))] || 0;
};

const runPool = async (jobs, concurrency = 10) => {
  const queue = [...jobs];
  const results = [];
  const worker = async () => {
    while (queue.length) {
      const job = queue.shift();
      try { results.push({ ok: true, ...(await job()) }); }
      catch (error) { results.push({ ok: false, error: error.message }); }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
};

await json("/api/login", { method: "POST", body: { username, password } });
const baseline = (await json("/api/products?status=active")).data.total;
console.log(`BASELINE products=${baseline}`);

const target = 50;
const createdIds = [];
let attempts = 0;
while (createdIds.length < target && attempts < 12) {
  attempts += 1;
  const remaining = target - createdIds.length;
  const wanted = Math.min(10, remaining);
  const batch = String(attempts).padStart(2, "0");
  const prompt = `这是经授权的系统稳定性测试。请随机生成并新增 ${wanted} 个不同品类的真实超市测试商品。必须返回正好 ${wanted} 个 create_product 操作，不要返回其他操作。商品名称以“测试·${batch}·”开头且互不重复；barcode 留空；每件填写合理的 category、unit、stock、low_stock、cost、price、supplier，售价必须高于进价，库存 5–200，预警库存 2–20。只需简短说明已准备好这些操作。`;
  const proposed = await json("/api/assistant", { method: "POST", body: { message: prompt } });
  const actions = (proposed.data.actions || []).filter((action) => action.type === "create_product").slice(0, wanted);
  if (!actions.length) {
    console.log(`AI_BATCH ${batch} proposed=0 retry=true ai_ms=${proposed.elapsed.toFixed(0)}`);
    continue;
  }
  const executed = await json("/api/assistant/execute", { method: "POST", body: { actions } });
  const successful = executed.data.results.filter((item) => item.ok && item.product_id);
  createdIds.push(...successful.map((item) => item.product_id));
  console.log(`AI_BATCH ${batch} proposed=${actions.length} created=${successful.length} total=${createdIds.length}/${target} ai_ms=${proposed.elapsed.toFixed(0)} execute_ms=${executed.elapsed.toFixed(0)}`);
}

if (createdIds.length !== target) throw new Error(`AI only created ${createdIds.length}/${target} products after ${attempts} attempts`);
const finalList = (await json("/api/products?status=active")).data;
if (finalList.total !== baseline + target) throw new Error(`product count mismatch: ${finalList.total} != ${baseline + target}`);

const dashboardJobs = Array.from({ length: 40 }, (_, index) => async () => {
  const result = await json(`/api/dashboard?load=${Date.now()}-${index}`);
  return { elapsed: result.elapsed };
});
const listJobs = Array.from({ length: 60 }, (_, index) => async () => {
  const result = await json(`/api/products?status=active&page=${index % 3 + 1}&load=${Date.now()}-${index}`);
  return { elapsed: result.elapsed };
});
const detailJobs = createdIds.map((id) => async () => {
  const result = await json(`/api/products/${id}?load=${Date.now()}`);
  return { elapsed: result.elapsed };
});

const [dashResults, listResults, detailResults] = await Promise.all([
  runPool(dashboardJobs, 10),
  runPool(listJobs, 12),
  runPool(detailJobs, 10),
]);

const summarize = (name, results) => {
  const ok = results.filter((item) => item.ok);
  const times = ok.map((item) => item.elapsed);
  const summary = {
    name,
    requests: results.length,
    success: ok.length,
    failed: results.length - ok.length,
    p50_ms: Math.round(percentile(times, 0.5)),
    p95_ms: Math.round(percentile(times, 0.95)),
    max_ms: Math.round(Math.max(...times, 0)),
  };
  console.log(`LOAD ${JSON.stringify(summary)}`);
  return summary;
};

const summaries = [
  summarize("dashboard", dashResults),
  summarize("product_list", listResults),
  summarize("product_detail", detailResults),
];
if (summaries.some((item) => item.failed)) throw new Error("load test contained failed requests");
console.log(`COMPLETE ${JSON.stringify({ baseline, added: createdIds.length, final: finalList.total, attempts, summaries })}`);
