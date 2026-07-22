const base = process.env.BHS_URL || "http://127.0.0.1:8788";
const username = process.env.BOSS_USERNAME || "Dongli";
const password = process.env.BOSS_INITIAL_PASSWORD;
if (!password) throw new Error("BOSS_INITIAL_PASSWORD is required");

let cookie = "";
const request = async (path, options = {}) => {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  if (!["GET", "HEAD"].includes(options.method || "GET")) headers.Origin = base;
  const response = await fetch(`${base}${path}`, { ...options, headers, redirect: "manual" });
  if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
  return response;
};
const body = async (response) => {
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${data.error || JSON.stringify(data)}`);
  return data;
};
const pass = (label) => console.log(`PASS  ${label}`);

const health = await body(await request(`/api/health?check=${Date.now()}`));
if (!health.ok || health.service !== "BHS") throw new Error("BHS health check failed");
pass("BHS health contract");

await body(await request("/api/login", { method: "POST", body: { username, password } }));
const session = await body(await request("/api/session"));
if (session.user.role !== "boss") throw new Error("Boss session missing");
pass("Boss bootstrap, password hashing and signed session");

const stamp = Date.now();
const created = await body(await request("/api/products", {
  method: "POST",
  body: { name: `BHS 测试商品 ${stamp}`, barcode: String(stamp).slice(-13).padStart(13, "8"), stock: 10, low_stock: 3, cost: 2.5, price: 4.8, supplier: "测试供应商" },
}));
const id = created.product.id;
if (!id) throw new Error("product was not created");
pass("D1 product create");

await body(await request(`/api/products/${id}/stock`, { method: "POST", body: { operation: "in", quantity: 5, reason: "本地回归入库" } }));
const adjusted = await body(await request(`/api/products/${id}`));
if (Number(adjusted.product.stock) !== 15) throw new Error("stock adjustment was not persisted");
pass("D1 stock movement persistence");

await body(await request("/api/sales", { method: "POST", body: { product_id: id, quantity: 2, unit_price: 4.8 } }));
const sold = await body(await request(`/api/products/${id}`));
if (Number(sold.product.stock) !== 13 || sold.sales.length !== 1) throw new Error("sale transaction failed");
pass("sale, inventory deduction and history");

const summary = await body(await request("/api/data/summary"));
if (Number(summary.product_count) < 1 || Number(summary.sales_count) < 1 || Number(summary.movement_count) < 2) throw new Error("data summary is incomplete");
for (const path of ["/api/data/sales.csv", "/api/data/inventory.csv"]) {
  const exported = await request(path);
  if (!exported.ok || !exported.headers.get("content-disposition")?.includes("attachment")) throw new Error(`${path} export failed`);
}
pass("product, sales and inventory exports");

const draft = await body(await request("/api/products/ai-draft", { method: "POST", body: { description: "测试牛奶一箱，进价 36 元，售价 48 元，库存 12 箱，预警库存 3 箱" } }));
if (!draft.draft?.name || Number(draft.draft.cost) !== 36 || Number(draft.draft.price) !== 48) throw new Error("AI product draft failed");
pass("AI product information draft");

const channelToken = process.env.BHS_CHANNEL_TOKEN;
if (!channelToken) throw new Error("BHS_CHANNEL_TOKEN is required");
const channelHeaders = { Authorization: `Bearer ${channelToken}` };
await body(await request("/api/channel/health", { headers: channelHeaders }));
const models = await body(await request("/api/openai/v1/models", { headers: channelHeaders }));
if (models.data?.[0]?.id !== "bhs-deepseek") throw new Error("OpenAI-compatible model endpoint failed");
const channel = await body(await request("/api/channel/message", { method: "POST", headers: channelHeaders, body: { message: "只回复：微信通道正常", sender: "回归测试" } }));
if (!channel.reply) throw new Error("WeChat channel did not return a reply");
pass("WeChat and OpenAI-compatible channel");

const imageBody = new FormData();
imageBody.append("image", new File([new Uint8Array([137, 80, 78, 71])], "test.png", { type: "image/png" }));
const uploaded = await body(await request("/api/uploads", { method: "POST", body: imageBody }));
const image = await request(uploaded.url);
if (!image.ok) throw new Error("D1 image could not be read");
pass("D1 image upload and read");

const csv = await request("/api/data/products.csv");
const bytes = new Uint8Array(await csv.arrayBuffer());
if (!csv.ok || bytes[0] !== 0xef || !csv.headers.get("content-disposition")?.includes("attachment")) throw new Error("CSV export failed");
pass("authenticated CSV export");

await body(await request(`/api/products/${id}/archive`, { method: "POST", body: {} }));
await body(await request(`/api/products/${id}/purge`, { method: "POST", body: {} }));
const missing = await request(`/api/products/${id}`);
if (missing.status !== 404) throw new Error("permanent deletion failed");
pass("archive and permanent deletion");

console.log("PASS  BHS smoke complete");
