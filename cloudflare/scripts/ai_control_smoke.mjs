const base = process.env.BHS_URL || "https://bhsbot.pages.dev";
const token = process.env.BHS_CHANNEL_TOKEN;
if (!token) throw new Error("BHS_CHANNEL_TOKEN is required");

const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
const stamp = Date.now();
const barcode = `29${String(stamp).slice(-11)}`;
let productId = 0;

async function call(path, body, externalId = "") {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(externalId ? { ...body, external_id: externalId } : body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${data.error || ""}`);
  return data;
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

try {
  const unauthorized = await fetch(`${base}/api/channel/media`, { method: "POST" });
  assert(unauthorized.status === 401, `media authorization failed: ${unauthorized.status}`);

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const media = await call("/api/channel/media", {
    source_id: `smoke-image-${stamp}`,
    sender: "AI_CONTROL_SMOKE",
    content_type: "image/png",
    body_base64: png.toString("base64url"),
  });
  assert(media.image_key && media.image_url, "media was not persisted");

  const created = await call("/api/channel/execute", { actions: [{
    type: "create_product",
    product: { name: `AI全权测试商品-${stamp}`, barcode, stock: 8, low_stock: 2, cost: 2.5, price: 4.5, unit: "件", image_key: media.image_key },
    summary: "创建测试商品",
  }] }, `smoke-create-${stamp}`);
  productId = created.results?.[0]?.product_id;
  assert(productId && created.outputs?.[0]?.item?.image_url === media.image_url, "create did not attach the image");

  const update = await call("/api/channel/execute", { actions: [{ type: "update_product", product_id: productId, product: { price: 5.2, supplier: "AI测试供应商" }, summary: "修改售价和供应商" }] }, `smoke-update-${stamp}`);
  assert(update.results?.[0]?.ok && update.outputs?.[0]?.item?.price === 5.2, "update failed");

  const stock = await call("/api/channel/execute", { actions: [{ type: "adjust_stock", product_id: productId, operation: "in", quantity: 4, reason: "AI测试进货", summary: "增加库存" }] }, `smoke-stock-${stamp}`);
  assert(stock.outputs?.[0]?.item?.stock === 12, "stock adjustment failed");

  const sale = await call("/api/channel/execute", { actions: [{ type: "record_sale", product_id: productId, quantity: 2, summary: "记录销售" }] }, `smoke-sale-${stamp}`);
  const saleId = sale.results?.[0]?.sale_id;
  assert(saleId && sale.outputs?.[0]?.item?.unit_price === 5.2, "sale recording or default price failed");

  const voided = await call("/api/channel/execute", { actions: [{ type: "void_sale", sale_id: saleId, reason: "AI测试撤销", summary: "撤销销售" }] }, `smoke-void-${stamp}`);
  assert(voided.results?.[0]?.ok && voided.outputs?.[0]?.item?.restored_stock === 12, "sale void failed to restore stock");

  await call("/api/channel/execute", { actions: [{ type: "archive_product", product_id: productId, summary: "停用商品" }] }, `smoke-archive-${stamp}`);
  const restored = await call("/api/channel/execute", { actions: [{ type: "restore_product", product_id: productId, summary: "恢复商品" }] }, `smoke-restore-${stamp}`);
  assert(restored.outputs?.[0]?.item?.archived === false, "restore failed");

  const query = await call("/api/channel/message", {
    message: `查询条码 ${barcode} 的商品详情和图片，只查询，不要修改。`,
    sender: "AI_CONTROL_SMOKE",
  }, `smoke-query-${stamp}`);
  const products = (query.outputs || []).flatMap((output) => output.item ? [output.item] : (output.items || []));
  assert(Array.isArray(query.actions) && query.actions.length === 0, "read-only query proposed a mutation");
  assert(products.some((item) => item.id === productId && item.image_url === media.image_url), "AI query did not return the product image");

  await call("/api/channel/execute", { actions: [{ type: "purge_product", product_id: productId, summary: "永久删除测试商品" }] }, `smoke-purge-${stamp}`);
  productId = 0;
  const removedImage = await fetch(`${base}${media.image_url}`);
  assert(removedImage.status === 404, `purge left product image behind: ${removedImage.status}`);

  console.log("PASS  media attach, product CRUD, stock, sale/void, structured query image and purge cleanup");
} finally {
  if (productId) {
    await call("/api/channel/execute", { actions: [{ type: "purge_product", product_id: productId, summary: "清理失败的测试商品" }] }, `smoke-finally-${stamp}`).catch(() => {});
  }
}
