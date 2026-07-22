const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SESSION_COOKIE = "bhs_session";
const SESSION_TTL = 60 * 60 * 24 * 7;
const MAX_UPLOAD_BYTES = 1536 * 1024;
const APP_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f5f3ee"><meta name="robots" content="noindex,nofollow"><title>BHS · 门店管理</title><link rel="stylesheet" href="/app.css?v=20260721-5"></head>
<body><div id="app"><main class="native-loading"><span class="brand-mark">B</span><p>正在进入 BHS</p></main></div><script src="/app.js?v=20260721-5" defer></script></body></html>`;
const PRODUCT_FIELDS = [
  "barcode", "sku", "name", "brand", "specification", "category", "unit",
  "stock", "low_stock", "cost", "price", "supplier", "supplier_contact",
  "location", "expiry_date", "notes", "image_key",
];

const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; connect-src 'self' https://api.deepseek.com; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(self), microphone=(self), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...securityHeaders,
      ...extraHeaders,
    },
  });
}

function error(message, status = 400, code = "bad_request") {
  return json({ ok: false, error: message, code }, status);
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function deepseekModel(env) {
  return env.DEEPSEEK_MODEL || "deepseek-v4-flash";
}

function imageContentType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "GIF8") return "image/gif";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return "";
}

function imageExtension(contentType) {
  return ({ "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" })[contentType] || "jpg";
}

function mediaUrl(imageKey) {
  return imageKey ? `/media/${encodeURIComponent(imageKey)}` : "";
}

function productOutput(product) {
  if (!product) return null;
  return {
    id: Number(product.id),
    name: product.name,
    barcode: product.barcode || "",
    sku: product.sku || "",
    brand: product.brand || "",
    specification: product.specification || "",
    category: product.category || "",
    unit: product.unit || "件",
    stock: num(product.stock),
    low_stock: num(product.low_stock),
    cost: num(product.cost),
    price: num(product.price),
    supplier: product.supplier || "",
    image_key: product.image_key || "",
    image_url: mediaUrl(product.image_key),
    archived: Boolean(product.archived_at),
  };
}

function randomToken(size = 24) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signSession(payload, secret) {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
  return `${body}.${base64url(new Uint8Array(signature))}`;
}

async function verifySession(token, secret) {
  if (!token || !secret) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      decodeBase64url(signature),
      encoder.encode(body),
    );
    if (!valid) return null;
    const payload = JSON.parse(decoder.decode(decodeBase64url(body)));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function cookieValue(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  for (const item of cookie.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return parts.join("=");
  }
  return "";
}

function sessionCookie(token, secure = true) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL}; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax`;
}

function clearSessionCookie(secure = true) {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax`;
}

async function hashPassword(password, salt = randomToken(16)) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: 100000 },
    key,
    256,
  );
  return { salt, hash: base64url(new Uint8Array(bits)) };
}

async function passwordMatches(password, salt, expected) {
  const candidate = await hashPassword(password, salt);
  const a = encoder.encode(candidate.hash);
  const b = encoder.encode(expected);
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

async function ensureBoss(env) {
  const username = text(env.BOSS_USERNAME, 100) || "Dongli";
  const existing = await env.DB.prepare("SELECT id, username FROM users WHERE role = 'boss' ORDER BY id LIMIT 1").first();
  const bossPassword = env.BOSS_PASSWORD || env.BOSS_INITIAL_PASSWORD;
  if (existing) {
    if (existing.username.toLowerCase() !== username.toLowerCase()) {
      await env.DB.prepare("UPDATE users SET username = ?, display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(username, username, existing.id).run();
    }
    return;
  }
  if (!bossPassword) return;
  const credentials = await hashPassword(bossPassword);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users
      (username, display_name, role, password_salt, password_hash, active)
     VALUES (?, ?, 'boss', ?, ?, 1)`,
  ).bind(username, username, credentials.salt, credentials.hash).run();
}

async function currentUser(request, env) {
  const payload = await verifySession(cookieValue(request, SESSION_COOKIE), env.SESSION_SECRET || env.SECRET_KEY);
  if (!payload?.uid) return null;
  const user = await env.DB.prepare(
    "SELECT id, username, display_name, role, active, last_login_at, created_at FROM users WHERE id = ?",
  ).bind(payload.uid).first();
  return user?.active ? user : null;
}

function requireRole(user, roles = []) {
  if (!user) throw new HttpError(401, "登录状态已失效", "unauthorized");
  if (roles.length && !roles.includes(user.role)) throw new HttpError(403, "没有操作权限", "forbidden");
}

function validateOrigin(request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new HttpError(403, "请求来源无效", "invalid_origin");
  }
}

class HttpError extends Error {
  constructor(status, message, code = "request_failed") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function productInput(input = {}) {
  const product = {};
  for (const field of PRODUCT_FIELDS) product[field] = input[field] ?? "";
  product.name = text(product.name, 160);
  if (!product.name) throw new HttpError(400, "请填写商品名称");
  for (const field of ["stock", "low_stock", "cost", "price"]) product[field] = Math.max(num(product[field]), 0);
  for (const field of ["barcode", "sku", "brand", "specification", "category", "unit", "supplier", "supplier_contact", "location", "expiry_date", "image_key"]) {
    product[field] = text(product[field], 240);
  }
  product.notes = text(product.notes, 2000);
  product.unit ||= "件";
  return product;
}

async function audit(env, user, action, targetType, targetId = "", detail = "") {
  await env.DB.prepare(
    "INSERT INTO audit_logs (user_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?)",
  ).bind(user?.id || null, action, targetType, String(targetId || ""), text(detail, 1000)).run();
}

async function handleLogin(request, env) {
  await ensureBoss(env);
  const body = await request.json();
  const username = text(body.username, 80);
  const password = String(body.password || "");
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const attemptKey = `${ip}|${username.toLowerCase()}`;
  const attempt = await env.DB.prepare("SELECT failures, locked_until FROM login_attempts WHERE attempt_key = ?").bind(attemptKey).first();
  if (attempt?.locked_until && Date.parse(attempt.locked_until) > Date.now()) {
    throw new HttpError(429, "登录尝试过多，请稍后再试", "login_limited");
  }
  const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").bind(username).first();
  const valid = user?.active && await passwordMatches(password, user.password_salt, user.password_hash);
  if (!valid) {
    const failures = (attempt?.failures || 0) + 1;
    const lockedUntil = failures >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
    await env.DB.prepare(
      `INSERT INTO login_attempts (attempt_key, failures, locked_until, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(attempt_key) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until, updated_at = CURRENT_TIMESTAMP`,
    ).bind(attemptKey, failures, lockedUntil).run();
    throw new HttpError(401, "账号或密码不正确", "invalid_credentials");
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM login_attempts WHERE attempt_key = ?").bind(attemptKey),
    env.DB.prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?").bind(user.id),
    env.DB.prepare("INSERT INTO audit_logs (user_id, action, target_type, target_id) VALUES (?, 'login', 'user', ?)").bind(user.id, String(user.id)),
  ]);
  const token = await signSession({ uid: user.id, exp: Math.floor(Date.now() / 1000) + SESSION_TTL, nonce: randomToken(8) }, env.SESSION_SECRET || env.SECRET_KEY);
  return json({ ok: true, user: publicUser(user) }, 200, { "Set-Cookie": sessionCookie(token, new URL(request.url).protocol === "https:") });
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    active: Boolean(user.active),
    last_login_at: user.last_login_at,
    created_at: user.created_at,
  };
}

async function dashboard(env) {
  const [inventory, salesToday, salesWeek, issues, movements, trend] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) products, COALESCE(SUM(stock), 0) stock,
      COALESCE(SUM(stock * cost), 0) cost_value, COALESCE(SUM(stock * price), 0) retail_value,
      COALESCE(SUM(CASE WHEN stock <= low_stock THEN 1 ELSE 0 END), 0) low_count
      FROM products WHERE archived_at IS NULL`),
    env.DB.prepare(`SELECT COALESCE(SUM(revenue), 0) revenue, COALESCE(SUM(profit), 0) profit
      FROM sales WHERE voided_at IS NULL AND date(created_at, '+8 hours') = date('now', '+8 hours')`),
    env.DB.prepare(`SELECT COALESCE(SUM(revenue), 0) revenue FROM sales
      WHERE voided_at IS NULL AND datetime(created_at) >= datetime('now', '-6 days', 'start of day')`),
    env.DB.prepare(`SELECT
      COALESCE(SUM(CASE WHEN stock <= 0 THEN 1 ELSE 0 END), 0) out_count,
      COALESCE(SUM(CASE WHEN cost <= 0 OR price <= 0 THEN 1 ELSE 0 END), 0) missing_price_count,
      COALESCE(SUM(CASE WHEN price > 0 AND price < cost THEN 1 ELSE 0 END), 0) negative_margin_count,
      COALESCE(SUM(CASE WHEN expiry_date <> '' AND date(expiry_date) BETWEEN date('now', '+8 hours') AND date('now', '+8 hours', '+30 days') THEN 1 ELSE 0 END), 0) expiring_count
      FROM products WHERE archived_at IS NULL`),
    env.DB.prepare(`SELECT id, product_id, product_name, change_amount, reason, source, created_at
      FROM inventory_movements ORDER BY id DESC LIMIT 8`),
    env.DB.prepare(`SELECT date(created_at, '+8 hours') day, COALESCE(SUM(revenue), 0) revenue
      FROM sales WHERE voided_at IS NULL AND datetime(created_at) >= datetime('now', '-6 days', 'start of day') GROUP BY day ORDER BY day`),
  ]);
  const inv = inventory.results[0] || {};
  const today = salesToday.results[0] || {};
  const issue = issues.results[0] || {};
  const salesMap = new Map(trend.results.map((row) => [row.day, row.revenue]));
  const trendRows = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(Date.now() - offset * 86400000 + 8 * 3600000);
    const day = date.toISOString().slice(0, 10);
    trendRows.push({ day, label: `${date.getUTCMonth() + 1}/${date.getUTCDate()}`, revenue: num(salesMap.get(day)) });
  }
  return {
    stats: {
      ...inv,
      ...issue,
      today_revenue: num(today.revenue),
      today_profit: num(today.profit),
      week_revenue: num(salesWeek.results[0]?.revenue),
      potential_profit: num(inv.retail_value) - num(inv.cost_value),
      has_sales: num(salesWeek.results[0]?.revenue) > 0,
    },
    trend: trendRows,
    recent_movements: movements.results,
  };
}

async function productList(url, env) {
  const q = text(url.searchParams.get("q"), 120);
  const status = ["active", "low", "archived"].includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "active";
  const issue = ["out", "pricing", "margin", "expiry"].includes(url.searchParams.get("issue")) ? url.searchParams.get("issue") : "";
  const page = Math.max(1, Math.trunc(num(url.searchParams.get("page"), 1)));
  const pageSize = url.searchParams.has("page_size")
    ? Math.min(200, Math.max(1, Math.trunc(num(url.searchParams.get("page_size"), 20))))
    : 20;
  const clauses = [status === "archived" ? "archived_at IS NOT NULL" : "archived_at IS NULL"];
  const bindings = [];
  if (q) {
    clauses.push("(name LIKE ? OR brand LIKE ? OR sku LIKE ? OR barcode LIKE ? OR supplier LIKE ?)");
    const term = `%${q}%`;
    bindings.push(term, term, term, term, term);
  }
  if (status === "low") clauses.push("stock <= low_stock");
  if (issue === "out") clauses.push("stock <= 0");
  if (issue === "pricing") clauses.push("(cost <= 0 OR price <= 0)");
  if (issue === "margin") clauses.push("price > 0 AND price < cost");
  if (issue === "expiry") clauses.push("expiry_date <> '' AND date(expiry_date) BETWEEN date('now', '+8 hours') AND date('now', '+8 hours', '+30 days')");
  const where = clauses.join(" AND ");
  const count = await env.DB.prepare(`SELECT COUNT(*) total FROM products WHERE ${where}`).bind(...bindings).first();
  const total = num(count?.total);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pages);
  const rows = await env.DB.prepare(
    `SELECT id, barcode, sku, name, brand, specification, category, unit, stock, low_stock,
      cost, price, supplier, image_key, archived_at
      FROM products WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
  ).bind(...bindings, pageSize, (current - 1) * pageSize).all();
  return { products: rows.results, total, page: current, pages, status, issue, q };
}

async function productDetail(id, env) {
  const product = await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(id).first();
  if (!product) throw new HttpError(404, "商品不存在", "not_found");
  const [movements, sales] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM inventory_movements WHERE product_id = ? ORDER BY id DESC LIMIT 20").bind(id),
    env.DB.prepare("SELECT * FROM sales WHERE product_id = ? ORDER BY id DESC LIMIT 20").bind(id),
  ]);
  return { product, movements: movements.results, sales: sales.results };
}

async function createProduct(input, env, user, source = "manual") {
  const product = productInput(input);
  try {
    const result = await env.DB.prepare(
      `INSERT INTO products (${PRODUCT_FIELDS.join(", ")}, created_at, updated_at)
       VALUES (${PRODUCT_FIELDS.map(() => "?").join(", ")}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(...PRODUCT_FIELDS.map((field) => product[field])).run();
    const id = result.meta.last_row_id;
    const statements = [
      env.DB.prepare("INSERT INTO audit_logs (user_id, action, target_type, target_id, detail) VALUES (?, 'create', 'product', ?, ?)")
        .bind(user.id, String(id), product.name),
    ];
    if (product.stock) {
      statements.push(env.DB.prepare(
        "INSERT INTO inventory_movements (product_id, product_name, change_amount, before_stock, after_stock, reason, source, operator_id) VALUES (?, ?, ?, 0, ?, ?, ?, ?)",
      ).bind(id, product.name, product.stock, product.stock, "商品初始库存", source, user.id));
    }
    await env.DB.batch(statements);
    if (product.image_key) await markChannelImageAttached(env, product.image_key, id);
    return productDetail(id, env);
  } catch (cause) {
    if (String(cause).includes("UNIQUE")) throw new HttpError(409, "该条码已存在", "duplicate_barcode");
    throw cause;
  }
}

async function updateProduct(id, input, env, user) {
  const current = await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(id).first();
  if (!current) throw new HttpError(404, "商品不存在", "not_found");
  const product = productInput({ ...current, ...input });
  try {
    await env.DB.prepare(
      `UPDATE products SET ${PRODUCT_FIELDS.map((field) => `${field} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).bind(...PRODUCT_FIELDS.map((field) => product[field]), id).run();
    const statements = [env.DB.prepare(
      "INSERT INTO audit_logs (user_id, action, target_type, target_id, detail) VALUES (?, 'update', 'product', ?, ?)",
    ).bind(user.id, String(id), product.name)];
    if (num(current.stock) !== product.stock) {
      statements.push(env.DB.prepare(
        "INSERT INTO inventory_movements (product_id, product_name, change_amount, before_stock, after_stock, reason, source, operator_id) VALUES (?, ?, ?, ?, ?, '编辑商品库存', 'manual', ?)",
      ).bind(id, product.name, product.stock - num(current.stock), num(current.stock), product.stock, user.id));
    }
    await env.DB.batch(statements);
    if (product.image_key) await markChannelImageAttached(env, product.image_key, id);
    if (current.image_key && current.image_key !== product.image_key) await deleteImageIfUnused(env, current.image_key);
    return productDetail(id, env);
  } catch (cause) {
    if (String(cause).includes("UNIQUE")) throw new HttpError(409, "该条码已存在", "duplicate_barcode");
    throw cause;
  }
}

async function adjustStock(id, input, env, user, source = "manual") {
  const current = await env.DB.prepare("SELECT id, name, stock FROM products WHERE id = ? AND archived_at IS NULL").bind(id).first();
  if (!current) throw new HttpError(404, "在售商品不存在", "not_found");
  const operation = ["in", "out", "set"].includes(input.operation) ? input.operation : "in";
  const quantity = Math.max(num(input.quantity), 0);
  if (!quantity && operation !== "set") throw new HttpError(400, "请输入库存数量");
  const before = num(current.stock);
  const after = operation === "set" ? quantity : operation === "out" ? Math.max(0, before - quantity) : before + quantity;
  const change = after - before;
  const reason = text(input.reason, 200) || (operation === "out" ? "出库" : operation === "set" ? "盘点修正" : "入库");
  await env.DB.batch([
    env.DB.prepare("UPDATE products SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(after, id),
    env.DB.prepare("INSERT INTO inventory_movements (product_id, product_name, change_amount, before_stock, after_stock, reason, source, operator_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, current.name, change, before, after, reason, source, user.id),
    env.DB.prepare("INSERT INTO audit_logs (user_id, action, target_type, target_id, detail) VALUES (?, 'stock', 'product', ?, ?)")
      .bind(user.id, String(id), `${reason}: ${change}`),
  ]);
  return productDetail(id, env);
}

async function changeProductStatus(id, operation, env, user) {
  const current = await env.DB.prepare("SELECT id, name, image_key FROM products WHERE id = ?").bind(id).first();
  if (!current) throw new HttpError(404, "商品不存在", "not_found");
  if (operation === "archive") {
    await env.DB.prepare("UPDATE products SET archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
  } else if (operation === "restore") {
    await env.DB.prepare("UPDATE products SET archived_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
  } else if (operation === "purge") {
    await env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
    if (current.image_key) {
      await env.DB.prepare("DELETE FROM channel_media WHERE image_key = ?").bind(current.image_key).run();
      await env.DB.prepare("DELETE FROM product_images WHERE image_key = ?").bind(current.image_key).run();
    }
  } else {
    throw new HttpError(400, "未知商品操作");
  }
  await audit(env, user, operation, "product", id, current.name);
  return { ok: true };
}

async function bulkProducts(input, env, user) {
  const ids = [...new Set((Array.isArray(input.ids) ? input.ids : []).map((id) => Math.trunc(num(id))).filter(Boolean))].slice(0, 100);
  if (!ids.length) throw new HttpError(400, "请选择商品");
  const operation = ["archive", "restore", "purge"].includes(input.operation) ? input.operation : "";
  if (!operation) throw new HttpError(400, "未知批量操作");
  for (const id of ids) await changeProductStatus(id, operation, env, user);
  return { ok: true, affected: ids.length };
}

function csvCell(value) {
  let output = value == null ? "" : String(value);
  if (/^[=+\-@]/.test(output)) output = `'${output}`;
  if (/[",\r\n]/.test(output)) output = `"${output.replace(/"/g, '""')}"`;
  return output;
}

async function exportProducts(env) {
  const rows = await env.DB.prepare("SELECT * FROM products ORDER BY id").all();
  const columns = [
    ["id", "ID"], ["barcode", "条码"], ["sku", "SKU"], ["name", "商品名称"], ["brand", "品牌"],
    ["specification", "规格"], ["category", "分类"], ["unit", "单位"], ["stock", "当前库存"], ["low_stock", "预警库存"],
    ["cost", "进价"], ["price", "售价"], ["supplier", "供应商"], ["supplier_contact", "联系方式"], ["location", "货位"],
    ["expiry_date", "到期日期"], ["notes", "备注"], ["created_at", "创建时间"], ["updated_at", "更新时间"], ["_status", "状态"],
  ];
  const lines = [columns.map((item) => csvCell(item[1])).join(",")];
  for (const row of rows.results) {
    lines.push(columns.map(([key]) => csvCell(key === "_status" ? (row.archived_at ? "已停用" : "在售") : row[key])).join(","));
  }
  return new Response(`\ufeff${lines.join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="BHS-products-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.csv"`,
      "Cache-Control": "no-store",
      ...securityHeaders,
    },
  });
}

function csvResponse(rows, columns, filename) {
  const lines = [columns.map((item) => csvCell(item[1])).join(",")];
  for (const row of rows) lines.push(columns.map(([key]) => csvCell(row[key])).join(","));
  return new Response(`\ufeff${lines.join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.csv"`,
      "Cache-Control": "no-store",
      ...securityHeaders,
    },
  });
}

async function exportSales(env) {
  const rows = await env.DB.prepare("SELECT * FROM sales ORDER BY id").all();
  return csvResponse(rows.results, [
    ["id", "ID"], ["product_id", "商品ID"], ["product_name", "商品名称"], ["quantity", "数量"],
    ["unit_price", "成交单价"], ["unit_cost", "单位成本"], ["revenue", "销售额"], ["profit", "毛利"],
    ["source", "来源"], ["created_at", "销售时间"], ["voided_at", "撤销时间"], ["void_reason", "撤销原因"],
  ], "BHS-sales");
}

async function exportInventory(env) {
  const rows = await env.DB.prepare("SELECT * FROM inventory_movements ORDER BY id").all();
  return csvResponse(rows.results, [
    ["id", "ID"], ["product_id", "商品ID"], ["product_name", "商品名称"], ["change_amount", "变动数量"],
    ["before_stock", "变动前库存"], ["after_stock", "变动后库存"], ["reason", "原因"], ["source", "来源"],
    ["created_at", "变动时间"],
  ], "BHS-inventory");
}

async function dataSummary(env) {
  const result = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM products) product_count,
    (SELECT COUNT(*) FROM sales) sales_count,
    (SELECT COUNT(*) FROM inventory_movements) movement_count`).first();
  return result || { product_count: 0, sales_count: 0, movement_count: 0 };
}

async function importProducts(input, env, user) {
  const rows = Array.isArray(input.rows) ? input.rows.slice(0, 1000) : [];
  if (!rows.length) throw new HttpError(400, "没有可导入的数据");
  let created = 0;
  let updated = 0;
  let failed = 0;
  for (const raw of rows) {
    try {
      const mapped = productInput(raw);
      const existing = mapped.barcode
        ? await env.DB.prepare("SELECT id FROM products WHERE barcode = ?").bind(mapped.barcode).first()
        : null;
      if (existing) {
        await updateProduct(existing.id, mapped, env, user);
        updated += 1;
      } else {
        await createProduct(mapped, env, user, "import");
        created += 1;
      }
    } catch {
      failed += 1;
    }
  }
  await audit(env, user, "import", "products", "", `created=${created}, updated=${updated}, failed=${failed}`);
  return { ok: true, created, updated, failed };
}

async function uploadImage(request, env, user) {
  const form = await request.formData();
  const file = form.get("image");
  if (!(file instanceof File)) throw new HttpError(400, "请选择图片");
  if (!file.type.startsWith("image/")) throw new HttpError(415, "仅支持图片文件");
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, "压缩后的图片不能超过 1.5MB");
  const extension = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "jpg";
  const key = `products/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${extension}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const encoded = base64url(bytes);
  await env.DB.prepare(
    "INSERT INTO product_images (image_key, content_type, body_base64, byte_size) VALUES (?, ?, ?, ?)",
  ).bind(key, file.type, encoded, file.size).run();
  await audit(env, user, "upload", "image", key, file.name);
  return { ok: true, image_key: key, url: `/media/${key}` };
}

async function markChannelImageAttached(env, imageKey, productId) {
  await env.DB.prepare(`UPDATE channel_media SET status = 'attached', attached_product_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE image_key = ?`).bind(productId, imageKey).run();
}

async function deleteImageIfUnused(env, imageKey) {
  const used = await env.DB.prepare("SELECT id FROM products WHERE image_key = ? LIMIT 1").bind(imageKey).first();
  if (used) return false;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM channel_media WHERE image_key = ?").bind(imageKey),
    env.DB.prepare("DELETE FROM product_images WHERE image_key = ?").bind(imageKey),
  ]);
  return true;
}

async function storeChannelImage(input, env) {
  const sourceId = text(input.source_id, 180);
  const sender = text(input.sender, 100);
  const encoded = typeof input.body_base64 === "string" ? input.body_base64 : "";
  if (!sourceId || !encoded) throw new HttpError(400, "图片数据不完整", "invalid_media");
  const existing = await env.DB.prepare("SELECT image_key, content_type, byte_size FROM channel_media WHERE source_id = ?").bind(sourceId).first();
  if (existing) return { ok: true, image_key: existing.image_key, image_url: mediaUrl(existing.image_key), content_type: existing.content_type, byte_size: existing.byte_size };
  let bytes;
  try { bytes = decodeBase64url(encoded); } catch { throw new HttpError(400, "图片编码无效", "invalid_media"); }
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw new HttpError(413, "微信图片不能超过 1.5MB", "media_too_large");
  const contentType = imageContentType(bytes);
  if (!contentType) throw new HttpError(415, "微信图片格式不支持", "invalid_media_type");
  const key = `products/${new Date().toISOString().slice(0, 10)}/wechat-${crypto.randomUUID()}.${imageExtension(contentType)}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO product_images (image_key, content_type, body_base64, byte_size) VALUES (?, ?, ?, ?)").bind(key, contentType, base64url(bytes), bytes.length),
    env.DB.prepare(`INSERT INTO channel_media (source_id, image_key, sender, content_type, byte_size, expires_at)
      VALUES (?, ?, ?, ?, ?, datetime('now', '+35 minutes'))`).bind(sourceId, key, sender, contentType, bytes.length),
  ]);
  return { ok: true, image_key: key, image_url: mediaUrl(key), content_type: contentType, byte_size: bytes.length };
}

async function cleanupChannelImages(input, env) {
  const keys = [...new Set((Array.isArray(input.image_keys) ? input.image_keys : []).map((value) => text(value, 260)).filter(Boolean))].slice(0, 10);
  let deleted = 0;
  for (const key of keys) {
    const pending = await env.DB.prepare("SELECT image_key FROM channel_media WHERE image_key = ? AND status = 'pending'").bind(key).first();
    if (pending && await deleteImageIfUnused(env, key)) deleted += 1;
  }
  await env.DB.prepare(`DELETE FROM product_images WHERE image_key IN (
    SELECT image_key FROM channel_media WHERE status = 'pending' AND expires_at < CURRENT_TIMESTAMP
  ) AND image_key NOT IN (SELECT image_key FROM products WHERE image_key <> '')`).run();
  await env.DB.prepare("DELETE FROM channel_media WHERE status = 'pending' AND expires_at < CURRENT_TIMESTAMP").run();
  return { ok: true, deleted };
}

async function serveImage(key, env, request) {
  const object = await env.DB.prepare(
    "SELECT content_type, body_base64, byte_size FROM product_images WHERE image_key = ?",
  ).bind(key).first();
  if (!object) return new Response("Not found", { status: 404 });
  const bytes = decodeBase64url(object.body_base64);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const headers = new Headers({ "Content-Type": object.content_type, "Content-Length": String(bytes.byteLength) });
  headers.set("ETag", `"${base64url(new Uint8Array(digest)).slice(0, 24)}"`);
  headers.set("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(bytes, { status: 200, headers });
}

async function salesData(env) {
  const [stats, trend, top, recent] = await env.DB.batch([
    env.DB.prepare(`SELECT COALESCE(SUM(revenue), 0) revenue, COALESCE(SUM(profit), 0) profit,
      COALESCE(SUM(quantity), 0) quantity, COUNT(*) orders FROM sales
      WHERE voided_at IS NULL AND date(created_at, '+8 hours') = date('now', '+8 hours')`),
    env.DB.prepare(`SELECT date(created_at, '+8 hours') day, SUM(revenue) revenue, SUM(profit) profit
      FROM sales WHERE voided_at IS NULL AND datetime(created_at) >= datetime('now', '-6 days', 'start of day') GROUP BY day ORDER BY day`),
    env.DB.prepare(`SELECT product_name, SUM(quantity) quantity, SUM(revenue) revenue, SUM(profit) profit
      FROM sales WHERE voided_at IS NULL GROUP BY product_name ORDER BY revenue DESC LIMIT 8`),
    env.DB.prepare("SELECT * FROM sales WHERE voided_at IS NULL ORDER BY id DESC LIMIT 30"),
  ]);
  return { stats: stats.results[0] || {}, trend: trend.results, top_products: top.results, recent_sales: recent.results };
}

async function recordSale(input, env, user) {
  const id = Math.trunc(num(input.product_id));
  const quantity = Math.max(num(input.quantity), 0);
  if (!id || !quantity) throw new HttpError(400, "请选择商品并填写销售数量");
  const product = await env.DB.prepare("SELECT * FROM products WHERE id = ? AND archived_at IS NULL").bind(id).first();
  if (!product) throw new HttpError(404, "商品不存在", "not_found");
  if (num(product.stock) < quantity) throw new HttpError(409, "库存不足", "insufficient_stock");
  const unitPrice = input.unit_price == null ? Math.max(num(product.price), 0) : Math.max(num(input.unit_price), 0);
  const revenue = unitPrice * quantity;
  const profit = (unitPrice - num(product.cost)) * quantity;
  const after = num(product.stock) - quantity;
  const writes = await env.DB.batch([
    env.DB.prepare("UPDATE products SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(after, id),
    env.DB.prepare(`INSERT INTO sales
      (product_id, product_name, quantity, unit_price, unit_cost, revenue, profit, source, operator_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, product.name, quantity, unitPrice, num(product.cost), revenue, profit, text(input.source, 30) || "manual", user.id),
    env.DB.prepare(`INSERT INTO inventory_movements
      (product_id, product_name, change_amount, before_stock, after_stock, reason, source, operator_id)
      VALUES (?, ?, ?, ?, ?, '销售出库', 'sale', ?)`)
      .bind(id, product.name, -quantity, num(product.stock), after, user.id),
  ]);
  await audit(env, user, "sale", "product", id, `${quantity} x ${unitPrice}`);
  return { ok: true, sale_id: Number(writes[1]?.meta?.last_row_id || 0), product_id: id, product_name: product.name, quantity, unit_price: unitPrice, revenue, profit, stock: after, image_url: mediaUrl(product.image_key) };
}

async function voidSale(id, reason, env, user) {
  const sale = await env.DB.prepare("SELECT * FROM sales WHERE id = ?").bind(id).first();
  if (!sale) throw new HttpError(404, "销售记录不存在", "not_found");
  if (sale.voided_at) throw new HttpError(409, "该销售记录已经撤销", "already_voided");
  const product = sale.product_id ? await env.DB.prepare("SELECT id, name, stock, image_key FROM products WHERE id = ?").bind(sale.product_id).first() : null;
  const voidReason = text(reason, 200) || "AI 撤销销售";
  const statements = [env.DB.prepare("UPDATE sales SET voided_at = CURRENT_TIMESTAMP, void_reason = ?, void_operator_id = ? WHERE id = ? AND voided_at IS NULL").bind(voidReason, user.id, id)];
  let stock = null;
  if (product) {
    stock = num(product.stock) + num(sale.quantity);
    statements.push(
      env.DB.prepare("UPDATE products SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(stock, product.id),
      env.DB.prepare(`INSERT INTO inventory_movements
        (product_id, product_name, change_amount, before_stock, after_stock, reason, source, operator_id)
        VALUES (?, ?, ?, ?, ?, ?, 'sale_void', ?)`).bind(product.id, product.name, num(sale.quantity), num(product.stock), stock, voidReason, user.id),
    );
  }
  await env.DB.batch(statements);
  await audit(env, user, "void", "sale", id, voidReason);
  return { ok: true, sale_id: id, product_id: sale.product_id, product_name: sale.product_name, restored_stock: stock, image_url: mediaUrl(product?.image_key) };
}

async function listUsers(env) {
  const rows = await env.DB.prepare("SELECT id, username, display_name, role, active, last_login_at, created_at FROM users ORDER BY id").all();
  return { users: rows.results.map(publicUser) };
}

async function createUser(input, env, actor) {
  const username = text(input.username, 80);
  const displayName = text(input.display_name, 80) || username;
  const requestedRole = ["admin", "employee"].includes(input.role) ? input.role : "employee";
  const role = actor.role === "boss" ? requestedRole : "employee";
  const password = String(input.password || "");
  if (!username || password.length < 8) throw new HttpError(400, "账号不能为空，密码至少 8 位");
  const credentials = await hashPassword(password);
  try {
    const result = await env.DB.prepare(
      "INSERT INTO users (username, display_name, role, password_salt, password_hash) VALUES (?, ?, ?, ?, ?)",
    ).bind(username, displayName, role, credentials.salt, credentials.hash).run();
    await audit(env, actor, "create", "user", result.meta.last_row_id, username);
    return { ok: true, id: result.meta.last_row_id };
  } catch (cause) {
    if (String(cause).includes("UNIQUE")) throw new HttpError(409, "账号已存在", "duplicate_user");
    throw cause;
  }
}

async function updateUser(id, input, env, actor) {
  const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  if (!target) throw new HttpError(404, "成员不存在", "not_found");
  if (target.role === "boss" && input.active === false) throw new HttpError(400, "不能停用 Boss 账号");
  if (actor.role === "admin" && (target.role !== "employee" || target.id === actor.id)) throw new HttpError(403, "管理员只能管理员工账号", "forbidden");
  const displayName = text(input.display_name ?? target.display_name, 80) || target.display_name;
  const role = target.role === "boss" ? "boss" : (["admin", "employee"].includes(input.role) ? input.role : target.role);
  const active = input.active == null ? target.active : (input.active ? 1 : 0);
  const statements = [env.DB.prepare("UPDATE users SET display_name = ?, role = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(displayName, role, active, id)];
  if (input.password) {
    if (String(input.password).length < 8) throw new HttpError(400, "密码至少 8 位");
    const credentials = await hashPassword(String(input.password));
    statements.push(env.DB.prepare("UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?").bind(credentials.salt, credentials.hash, id));
  }
  await env.DB.batch(statements);
  await audit(env, actor, "update", "user", id, target.username);
  return { ok: true };
}

async function barcodeLookup(code, env) {
  const clean = text(code, 64).replace(/\s/g, "");
  if (!/^\d{8,14}$/.test(clean)) throw new HttpError(400, "条码格式不正确");
  const local = await env.DB.prepare("SELECT * FROM products WHERE barcode = ?").bind(clean).first();
  if (local) return { found: true, source: "BHS", product: local };
  try {
    const response = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(clean)}.json`, {
      headers: { "User-Agent": "BHS/1.0 (product lookup)" },
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
    if (!response.ok) return { found: false, barcode: clean };
    const data = await response.json();
    if (!data.product) return { found: false, barcode: clean };
    const product = data.product;
    return {
      found: true,
      source: "Open Food Facts",
      product: {
        barcode: clean,
        name: product.product_name_zh || product.product_name || "",
        brand: product.brands || "",
        specification: product.quantity || "",
        category: product.categories_tags?.[0]?.replace(/^.*:/, "") || "",
        image_url: product.image_front_small_url || "",
      },
    };
  } catch {
    return { found: false, barcode: clean };
  }
}

async function productDraftFromText(description, env) {
  const content = text(description, 3000);
  if (!content) throw new HttpError(400, "请用 1–3000 字描述商品信息");
  if (!env.DEEPSEEK_API_KEY) throw new HttpError(503, "AI 服务尚未配置", "ai_unavailable");
  const fields = PRODUCT_FIELDS.filter((field) => field !== "image_key");
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: deepseekModel(env),
      response_format: { type: "json_object" },
      temperature: 0.1,
      messages: [
        { role: "system", content: `从用户口述中提取超市商品资料，只输出 JSON 对象。允许字段：${fields.join(",")}。stock、low_stock、cost、price 必须是非负数字；未提到的字段不要输出；不要推测价格、库存或供应商。unit 未提到时可不输出。` },
        { role: "user", content },
      ],
    }),
  });
  if (!response.ok) throw new HttpError(502, "AI 暂时无法整理，请稍后再试", "ai_failed");
  const completion = await response.json();
  let raw;
  try { raw = JSON.parse(completion.choices?.[0]?.message?.content || "{}"); } catch { raw = {}; }
  const draft = {};
  for (const field of fields) {
    if (raw[field] == null || raw[field] === "") continue;
    draft[field] = ["stock", "low_stock", "cost", "price"].includes(field)
      ? Math.max(num(raw[field]), 0)
      : text(raw[field], field === "notes" ? 2000 : 240);
  }
  if (!Object.keys(draft).length) throw new HttpError(422, "没有识别到商品信息，请说得更具体一些");
  return { draft };
}

function secureEqual(left, right) {
  const a = encoder.encode(String(left || ""));
  const b = encoder.encode(String(right || ""));
  if (!a.length || a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

function channelAuthorized(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const bearer = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  const token = bearer || request.headers.get("X-BHS-Channel-Token") || "";
  return secureEqual(token, env.BHS_CHANNEL_TOKEN);
}

function visibleMessageContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((item) => item?.type === "text" || item?.type === "input_text").map((item) => item.text || "").join("\n").trim();
}

async function channelCompletion(messages, env, compact = true) {
  if (!env.DEEPSEEK_API_KEY) throw new HttpError(503, "AI 服务尚未配置", "ai_unavailable");
  const inventory = await env.DB.prepare(`SELECT id, name, barcode, stock, low_stock, cost, price, supplier, expiry_date
    FROM products WHERE archived_at IS NULL ORDER BY (stock <= low_stock) DESC, updated_at DESC LIMIT 120`).all();
  const system = `你是 BHS 超市经营管家。根据真实商品数据回答，不要编造。信息不足时明确追问。${compact ? "这是微信对话，回答简短、适合手机阅读；商品很多时只给汇总和最重要的 5 条。" : ""}\n当前商品数据：${JSON.stringify(inventory.results)}`;
  const cleanMessages = messages.slice(-24).map((item) => ({ role: ["system", "assistant", "user"].includes(item.role) ? item.role : "user", content: visibleMessageContent(item.content) })).filter((item) => item.content);
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: deepseekModel(env), messages: [{ role: "system", content: system }, ...cleanMessages], temperature: 0.2, max_tokens: compact ? 900 : 2000 }),
  });
  if (!response.ok) throw new HttpError(502, "AI 服务暂时没有响应", "ai_failed");
  const completion = await response.json();
  return text(completion.choices?.[0]?.message?.content, compact ? 1800 : 6000) || "这次没有生成有效回复，请重新描述。";
}

async function channelActor(env) {
  const actor = await env.DB.prepare("SELECT * FROM users WHERE role = 'boss' AND active = 1 ORDER BY id LIMIT 1").first();
  if (!actor) throw new HttpError(503, "Boss 账号不可用", "channel_actor_unavailable");
  return actor;
}

async function handleChannelMessage(request, env) {
  const body = await request.json();
  const content = text(body.message, 4000);
  const sender = text(body.sender, 80) || "ClawBot";
  const externalId = text(body.external_id, 160);
  if (!content) throw new HttpError(400, "message is required");
  if (externalId) {
    const receipt = await env.DB.prepare("SELECT response_json FROM channel_receipts WHERE external_id = ?").bind(externalId).first();
    if (receipt?.response_json) return JSON.parse(receipt.response_json);
  }
  const attachments = (Array.isArray(body.attachments) ? body.attachments : []).filter((item) => item?.image_key).slice(0, 3);
  const result = await askAssistant({ message: content, attachments }, env, await channelActor(env), "WECHAT");
  if (externalId) await env.DB.prepare("INSERT OR REPLACE INTO channel_receipts (external_id, kind, response_json) VALUES (?, 'message', ?)").bind(externalId, JSON.stringify(result)).run();
  await audit(env, null, "message", "wechat", sender, content.slice(0, 200));
  return result;
}

async function handleChannelExecution(request, env) {
  const body = await request.json();
  const externalId = text(body.external_id, 160);
  if (externalId) {
    const receipt = await env.DB.prepare("SELECT response_json FROM channel_receipts WHERE external_id = ?").bind(externalId).first();
    if (receipt?.response_json) return JSON.parse(receipt.response_json);
  }
  const result = await executeAssistantActions(body, env, await channelActor(env));
  if (externalId) await env.DB.prepare("INSERT OR REPLACE INTO channel_receipts (external_id, kind, response_json) VALUES (?, 'execution', ?)").bind(externalId, JSON.stringify(result)).run();
  return result;
}

async function handleChannelHeartbeat(env) {
  await env.DB.prepare(`INSERT INTO integration_status (name, status, last_seen_at)
    VALUES ('wechat', 'online', CURRENT_TIMESTAMP)
    ON CONFLICT(name) DO UPDATE SET status = 'online', last_seen_at = CURRENT_TIMESTAMP`).run();
  return { ok: true };
}

async function handleOpenAiCompletion(request, env) {
  const body = await request.json();
  if (!Array.isArray(body.messages) || !body.messages.length) throw new HttpError(400, "messages is required", "invalid_request_error");
  const channel = (request.headers.get("X-BHS-Channel") || "WECHAT").toUpperCase() === "WEB" ? "WEB" : "WECHAT";
  const lastUser = [...body.messages].reverse().find((item) => item.role === "user");
  const visible = visibleMessageContent(lastUser?.content);
  if (visible) await env.DB.prepare("INSERT INTO assistant_messages (role, content, channel) VALUES ('user', ?, ?)").bind(visible, channel).run();
  const answer = await channelCompletion(body.messages, env, channel === "WECHAT");
  await env.DB.prepare("INSERT INTO assistant_messages (role, content, channel) VALUES ('assistant', ?, ?)").bind(answer, channel).run();
  const id = `chatcmpl-bhs-${crypto.randomUUID()}`;
  const model = text(body.model, 100) || "bhs-deepseek";
  if (body.stream) {
    const first = JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }] });
    const final = JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    return new Response(`data: ${first}\n\ndata: ${final}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", ...securityHeaders } });
  }
  return json({ id, object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
}

async function assistantHistory(env) {
  const rows = await env.DB.prepare("SELECT id, role, content, channel, result_json, created_at FROM assistant_messages ORDER BY id DESC LIMIT 40").all();
  return { messages: rows.results.reverse().map((row) => {
    let result = {};
    try { result = row.result_json ? JSON.parse(row.result_json) : {}; } catch { result = {}; }
    return { ...row, outputs: Array.isArray(result.outputs) ? result.outputs : [] };
  }) };
}

function safeAction(action) {
  if (!action || typeof action !== "object") return null;
  const type = text(action.type, 40);
  const allowed = ["create_product", "adjust_stock", "update_product", "archive_product", "restore_product", "purge_product", "record_sale", "void_sale", "create_user", "update_user"];
  if (!allowed.includes(type)) return null;
  return {
    type,
    product_id: Math.trunc(num(action.product_id)) || null,
    sale_id: Math.trunc(num(action.sale_id)) || null,
    user_id: Math.trunc(num(action.user_id)) || null,
    product: action.product && typeof action.product === "object" ? action.product : null,
    user: action.user && typeof action.user === "object" ? action.user : null,
    operation: ["in", "out", "set"].includes(action.operation) ? action.operation : "in",
    quantity: Math.max(num(action.quantity), 0),
    unit_price: action.unit_price == null ? null : Math.max(num(action.unit_price), 0),
    reason: text(action.reason, 200),
    summary: text(action.summary, 240),
  };
}

function safeQuery(query) {
  if (!query || typeof query !== "object") return null;
  const type = text(query.type, 40);
  if (!["dashboard", "products", "product_detail", "sales", "movements", "users"].includes(type)) return null;
  return {
    type,
    search: text(query.search, 120),
    status: ["active", "low", "out", "archived", "all"].includes(query.status) ? query.status : "active",
    product_id: Math.trunc(num(query.product_id)) || null,
    days: Math.min(365, Math.max(1, Math.trunc(num(query.days, 7)))),
    limit: Math.min(20, Math.max(1, Math.trunc(num(query.limit, 8)))),
  };
}

function fallbackQueryReply(outputs) {
  if (!outputs.length) return "没有查到符合条件的数据。";
  const first = outputs[0];
  if (first.type === "dashboard") return `当前共有 ${first.metrics.products} 个商品，库存 ${first.metrics.stock} 件；今日销售额 ¥${first.metrics.today_revenue.toFixed(2)}，毛利 ¥${first.metrics.today_profit.toFixed(2)}；低库存 ${first.metrics.low_count} 个。`;
  if (first.type === "products") return first.items.length ? `查到 ${first.total} 个商品，先显示 ${first.items.length} 个。` : "没有查到符合条件的商品。";
  if (first.type === "product") return `已找到商品：${first.item.name}，库存 ${first.item.stock} ${first.item.unit}，售价 ¥${first.item.price.toFixed(2)}。`;
  if (first.type === "sales") return `近 ${first.days} 天共 ${first.summary.orders} 笔有效销售，销售额 ¥${first.summary.revenue.toFixed(2)}，毛利 ¥${first.summary.profit.toFixed(2)}。`;
  if (first.type === "movements") return `查到 ${first.items.length} 条库存流水。`;
  if (first.type === "users") return `当前共有 ${first.items.length} 位内部成员。`;
  return "查询完成。";
}

async function executeAssistantQueries(queries, env) {
  const outputs = [];
  for (const query of queries) {
    if (query.type === "dashboard") {
      const data = await dashboard(env);
      outputs.push({ type: "dashboard", title: "经营总览", metrics: data.stats, trend: data.trend });
    } else if (query.type === "products") {
      const clauses = [];
      const bindings = [];
      if (query.status === "archived") clauses.push("archived_at IS NOT NULL");
      else if (query.status !== "all") clauses.push("archived_at IS NULL");
      if (query.status === "low") clauses.push("stock <= low_stock");
      if (query.status === "out") clauses.push("stock <= 0");
      if (query.search) {
        const term = `%${query.search}%`;
        clauses.push("(name LIKE ? OR brand LIKE ? OR barcode LIKE ? OR sku LIKE ? OR supplier LIKE ?)");
        bindings.push(term, term, term, term, term);
      }
      const where = clauses.length ? clauses.join(" AND ") : "1=1";
      const total = await env.DB.prepare(`SELECT COUNT(*) total FROM products WHERE ${where}`).bind(...bindings).first();
      const rows = await env.DB.prepare(`SELECT * FROM products WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`).bind(...bindings, query.limit).all();
      outputs.push({ type: "products", title: query.search ? `“${query.search}”商品` : query.status === "low" ? "低库存商品" : query.status === "out" ? "缺货商品" : "商品", total: num(total?.total), items: rows.results.map(productOutput) });
    } else if (query.type === "product_detail") {
      let product = null;
      if (query.product_id) product = await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(query.product_id).first();
      if (!product && query.search) {
        const term = `%${query.search}%`;
        product = await env.DB.prepare("SELECT * FROM products WHERE name LIKE ? OR barcode = ? OR sku = ? ORDER BY archived_at IS NULL DESC, updated_at DESC LIMIT 1").bind(term, query.search, query.search).first();
      }
      if (product) outputs.push({ type: "product", title: "商品详情", item: productOutput(product) });
    } else if (query.type === "sales") {
      const modifier = `-${query.days - 1} days`;
      const productClause = query.product_id ? " AND product_id = ?" : "";
      const summaryBindings = query.product_id ? [modifier, query.product_id] : [modifier];
      const summary = await env.DB.prepare(`SELECT COUNT(*) orders, COALESCE(SUM(quantity),0) quantity, COALESCE(SUM(revenue),0) revenue, COALESCE(SUM(profit),0) profit
        FROM sales WHERE voided_at IS NULL AND datetime(created_at) >= datetime('now', ?, 'start of day')${productClause}`).bind(...summaryBindings).first();
      const rows = await env.DB.prepare(`SELECT id, product_id, product_name, quantity, unit_price, revenue, profit, source, created_at
        FROM sales WHERE voided_at IS NULL AND datetime(created_at) >= datetime('now', ?, 'start of day')${productClause} ORDER BY id DESC LIMIT ?`).bind(...summaryBindings, query.limit).all();
      outputs.push({ type: "sales", title: `近 ${query.days} 天销售`, days: query.days, summary: { orders: num(summary?.orders), quantity: num(summary?.quantity), revenue: num(summary?.revenue), profit: num(summary?.profit) }, items: rows.results });
    } else if (query.type === "movements") {
      const modifier = `-${query.days - 1} days`;
      const bindings = [modifier];
      let productClause = "";
      if (query.product_id) { productClause = " AND product_id = ?"; bindings.push(query.product_id); }
      const rows = await env.DB.prepare(`SELECT id, product_id, product_name, change_amount, before_stock, after_stock, reason, source, created_at
        FROM inventory_movements WHERE datetime(created_at) >= datetime('now', ?, 'start of day')${productClause} ORDER BY id DESC LIMIT ?`).bind(...bindings, query.limit).all();
      outputs.push({ type: "movements", title: "库存流水", items: rows.results });
    } else if (query.type === "users") {
      const rows = await env.DB.prepare("SELECT id, username, display_name, role, active, last_login_at FROM users ORDER BY id LIMIT ?").bind(query.limit).all();
      outputs.push({ type: "users", title: "内部成员", items: rows.results.map(publicUser) });
    }
  }
  return outputs;
}

async function summarizeAssistantResults(message, outputs, env) {
  const fallback = fallbackQueryReply(outputs);
  try {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: deepseekModel(env),
        messages: [
          { role: "system", content: "你是 BHS 超市经营管家。只根据工具返回的真实数据，用简洁中文回答用户；主动指出缺货、低毛利或异常，但不要编造。只输出 JSON：{\"reply\":\"...\"}。" },
          { role: "user", content: `用户问题：${message}\n工具结果：${JSON.stringify(outputs)}` },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 900,
      }),
    });
    if (!response.ok) return fallback;
    const completion = await response.json();
    const parsed = JSON.parse(completion.choices?.[0]?.message?.content || "{}");
    return text(parsed.reply, 1800) || fallback;
  } catch {
    return fallback;
  }
}

async function askAssistant(input, env, user, channel = "WEB") {
  const message = text(input.message, 4000);
  if (!message) throw new HttpError(400, "请输入要交给管家的内容");
  if (!env.DEEPSEEK_API_KEY) throw new HttpError(503, "AI 服务尚未配置", "ai_unavailable");
  const [inventory, recentSales, members, recent] = await env.DB.batch([
    env.DB.prepare(`SELECT id, name, barcode, sku, stock, low_stock, cost, price, supplier, expiry_date, archived_at
      FROM products ORDER BY archived_at IS NULL DESC, updated_at DESC LIMIT 160`),
    env.DB.prepare("SELECT id, product_id, product_name, quantity, unit_price, revenue, profit, created_at FROM sales WHERE voided_at IS NULL ORDER BY id DESC LIMIT 30"),
    env.DB.prepare("SELECT id, username, display_name, role, active FROM users ORDER BY id LIMIT 30"),
    env.DB.prepare("SELECT role, content FROM assistant_messages ORDER BY id DESC LIMIT 8"),
  ]);
  const system = `你是 BHS 超市的执行型 AI 店长。你负责理解自然语言、查询实时数据并提出安全操作。
严格只输出 JSON：{"reply":"中文回复","queries":[],"actions":[]}。
查询会立即执行，不需要确认：
- dashboard: {type:"dashboard"}
- products: {type:"products",search,status:"active|low|out|archived|all",limit}
- product_detail: {type:"product_detail",product_id或search}
- sales: {type:"sales",days,product_id,limit}
- movements: {type:"movements",days,product_id,limit}
- users: {type:"users",limit}
用户要求查看、统计、分析、找商品或看图片时必须生成 queries，不能凭上下文猜结果。
数据变更只提出 actions，绝不能声称已执行；系统会要求用户确认：
- create_product: {type,product:{name,barcode,sku,brand,specification,category,unit,stock,low_stock,cost,price,supplier,supplier_contact,location,expiry_date,notes},summary}
- update_product: {type,product_id,product:{只包含要修改字段},summary}
- adjust_stock: {type,product_id,operation:"in|out|set",quantity,reason,summary}
- archive_product / restore_product: {type,product_id,summary}
- purge_product: 只有用户明确说永久删除或彻底删除时使用
- record_sale: {type,product_id,quantity,unit_price,summary}
- void_sale: {type,sale_id,reason,summary}，用于撤销错误销售并返还库存
- create_user: {type,user:{username,display_name,role:"admin|employee",password},summary}
- update_user: {type,user_id,user:{display_name,role,active,password},summary}
缺少商品 ID 时根据给定真实数据匹配；匹配不唯一或关键字段不足时 actions 为空并追问。不要编造 ID、价格、数量或密码。
当前商品：${JSON.stringify(inventory.results)}
最近有效销售：${JSON.stringify(recentSales.results)}
内部成员：${JSON.stringify(members.results)}`;
  const messages = [
    { role: "system", content: system },
    ...recent.results.reverse().map((row) => ({ role: row.role, content: row.content })),
    { role: "user", content: message },
  ];
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: deepseekModel(env), messages, response_format: { type: "json_object" }, temperature: 0.1, max_tokens: 1800 }),
  });
  if (!response.ok) throw new HttpError(502, "AI 服务暂时没有响应", "ai_failed");
  const completion = await response.json();
  let parsed;
  try { parsed = JSON.parse(completion.choices?.[0]?.message?.content || "{}"); }
  catch { parsed = { reply: "暂时无法整理结果。", queries: [], actions: [] }; }
  const queries = (Array.isArray(parsed.queries) ? parsed.queries : []).map(safeQuery).filter(Boolean).slice(0, 6);
  const outputs = await executeAssistantQueries(queries, env);
  let actions = (Array.isArray(parsed.actions) ? parsed.actions : []).map(safeAction).filter(Boolean).slice(0, 10);
  const attachments = (Array.isArray(input.attachments) ? input.attachments : []).filter((item) => item?.image_key).slice(0, 3);
  if (attachments.length) {
    const target = actions.find((action) => ["create_product", "update_product"].includes(action.type));
    if (target) target.product = { ...(target.product || {}), image_key: attachments[0].image_key };
  }
  const reply = outputs.length ? await summarizeAssistantResults(message, outputs, env) : text(parsed.reply, 6000) || "我需要更明确的信息才能处理。";
  await env.DB.batch([
    env.DB.prepare("INSERT INTO assistant_messages (role, content, channel, user_id) VALUES ('user', ?, ?, ?)").bind(message, channel, user.id),
    env.DB.prepare("INSERT INTO assistant_messages (role, content, channel, user_id, result_json) VALUES ('assistant', ?, ?, ?, ?)").bind(reply, channel, user.id, JSON.stringify({ outputs })),
  ]);
  return { reply, actions, outputs };
}

async function executeAssistantActions(input, env, user) {
  const actions = (Array.isArray(input.actions) ? input.actions : []).map(safeAction).filter(Boolean).slice(0, 20);
  if (!actions.length) throw new HttpError(400, "没有可执行的操作");
  const results = [];
  const outputs = [];
  for (const action of actions) {
    try {
      if (action.type === "create_product") {
        const created = await createProduct(action.product || {}, env, user, "ai");
        results.push({ ok: true, type: action.type, product_id: created.product.id });
        outputs.push({ type: "product", title: "已新增商品", item: productOutput(created.product) });
      } else if (action.type === "adjust_stock") {
        const updated = await adjustStock(action.product_id, action, env, user, "ai");
        results.push({ ok: true, type: action.type, product_id: action.product_id });
        outputs.push({ type: "product", title: "库存已更新", item: productOutput(updated.product) });
      } else if (action.type === "update_product") {
        const updated = await updateProduct(action.product_id, action.product || {}, env, user);
        results.push({ ok: true, type: action.type, product_id: action.product_id });
        outputs.push({ type: "product", title: "商品已更新", item: productOutput(updated.product) });
      } else if (action.type === "archive_product" || action.type === "restore_product") {
        requireRole(user, ["boss", "admin"]);
        const operation = action.type === "archive_product" ? "archive" : "restore";
        await changeProductStatus(action.product_id, operation, env, user);
        const updated = await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(action.product_id).first();
        results.push({ ok: true, type: action.type, product_id: action.product_id });
        if (updated) outputs.push({ type: "product", title: operation === "archive" ? "商品已停用" : "商品已恢复", item: productOutput(updated) });
      } else if (action.type === "purge_product") {
        requireRole(user, ["boss", "admin"]);
        await changeProductStatus(action.product_id, "purge", env, user);
        results.push({ ok: true, type: action.type, product_id: action.product_id });
      } else if (action.type === "record_sale") {
        const sale = await recordSale({ product_id: action.product_id, quantity: action.quantity, unit_price: action.unit_price, source: "ai" }, env, user);
        results.push({ ok: true, type: action.type, product_id: action.product_id, sale_id: sale.sale_id });
        outputs.push({ type: "sale", title: "销售已记录", item: sale });
      } else if (action.type === "void_sale") {
        requireRole(user, ["boss", "admin"]);
        const voided = await voidSale(action.sale_id, action.reason, env, user);
        results.push({ ok: true, type: action.type, sale_id: action.sale_id, product_id: voided.product_id });
        outputs.push({ type: "sale_void", title: "销售已撤销", item: voided });
      } else if (action.type === "create_user") {
        requireRole(user, ["boss", "admin"]);
        const created = await createUser(action.user || {}, env, user);
        const member = await env.DB.prepare("SELECT id, username, display_name, role, active, last_login_at FROM users WHERE id = ?").bind(created.id).first();
        results.push({ ok: true, type: action.type, user_id: created.id });
        if (member) outputs.push({ type: "user", title: "成员已创建", item: publicUser(member) });
      } else if (action.type === "update_user") {
        requireRole(user, ["boss", "admin"]);
        await updateUser(action.user_id, action.user || {}, env, user);
        const member = await env.DB.prepare("SELECT id, username, display_name, role, active, last_login_at FROM users WHERE id = ?").bind(action.user_id).first();
        results.push({ ok: true, type: action.type, user_id: action.user_id });
        if (member) outputs.push({ type: "user", title: "成员已更新", item: publicUser(member) });
      }
    } catch (cause) {
      results.push({ ok: false, type: action.type, product_id: action.product_id, sale_id: action.sale_id, user_id: action.user_id, error: cause.message || "执行失败" });
    }
  }
  await audit(env, user, "execute", "ai_actions", "", JSON.stringify(results));
  return { ok: results.every((item) => item.ok), results, outputs };
}

async function integrations(env) {
  const [heartbeat, lastWechat] = await env.DB.batch([
    env.DB.prepare("SELECT status, last_seen_at FROM integration_status WHERE name = 'wechat'"),
    env.DB.prepare("SELECT created_at FROM assistant_messages WHERE channel = 'WECHAT' ORDER BY id DESC LIMIT 1"),
  ]);
  const pulse = heartbeat.results[0];
  return {
    wechat: {
      connected: Boolean(pulse?.status === "online" && pulse?.last_seen_at && Date.now() - new Date(`${pulse.last_seen_at.replace(" ", "T")}Z`).getTime() < 7 * 60 * 1000),
      last_message_at: lastWechat.results[0]?.created_at || null,
    },
  };
}

async function routeApi(request, env, url) {
  validateOrigin(request);
  const path = url.pathname;
  if (path === "/api/health" && request.method === "GET") {
    const row = await env.DB.prepare("SELECT 1 ok").first();
    return json({ ok: row?.ok === 1, service: "BHS" });
  }
  if (path === "/api/channel/health" && request.method === "GET") {
    if (!channelAuthorized(request, env)) return error("unauthorized", 401, "unauthorized");
    return json({ ok: true, service: "BHS", time: new Date().toISOString() });
  }
  if (path === "/api/channel/message" && request.method === "POST") {
    if (!channelAuthorized(request, env)) return error("unauthorized", 401, "unauthorized");
    return json(await handleChannelMessage(request, env));
  }
  if (path === "/api/channel/execute" && request.method === "POST") {
    if (!channelAuthorized(request, env)) return error("unauthorized", 401, "unauthorized");
    return json(await handleChannelExecution(request, env));
  }
  if (path === "/api/channel/media" && request.method === "POST") {
    if (!channelAuthorized(request, env)) return error("unauthorized", 401, "unauthorized");
    return json(await storeChannelImage(await request.json(), env), 201);
  }
  if (path === "/api/channel/media/cleanup" && request.method === "POST") {
    if (!channelAuthorized(request, env)) return error("unauthorized", 401, "unauthorized");
    return json(await cleanupChannelImages(await request.json(), env));
  }
  if (path === "/api/channel/heartbeat" && request.method === "POST") {
    if (!channelAuthorized(request, env)) return error("unauthorized", 401, "unauthorized");
    return json(await handleChannelHeartbeat(env));
  }
  if (path === "/api/openai/v1/models" && request.method === "GET") {
    if (!channelAuthorized(request, env)) return json({ error: { message: "Unauthorized", type: "auth_error" } }, 401);
    return json({ object: "list", data: [{ id: "bhs-deepseek", object: "model", owned_by: "BHS" }] });
  }
  if (path === "/api/openai/v1/chat/completions" && request.method === "POST") {
    if (!channelAuthorized(request, env)) return json({ error: { message: "Unauthorized", type: "auth_error" } }, 401);
    return handleOpenAiCompletion(request, env);
  }
  if (path === "/api/login" && request.method === "POST") return handleLogin(request, env);
  if (path === "/api/logout" && request.method === "POST") return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie(url.protocol === "https:") });

  const user = await currentUser(request, env);
  requireRole(user);
  if (path === "/api/session" && request.method === "GET") return json({ ok: true, user: publicUser(user) });
  if (path === "/api/dashboard" && request.method === "GET") return json(await dashboard(env));
  if (path === "/api/products" && request.method === "GET") return json(await productList(url, env));
  if (path === "/api/products" && request.method === "POST") return json(await createProduct(await request.json(), env, user), 201);
  if (path === "/api/products/bulk" && request.method === "POST") {
    requireRole(user, ["boss", "admin"]);
    return json(await bulkProducts(await request.json(), env, user));
  }
  const productMatch = path.match(/^\/api\/products\/(\d+)(?:\/(stock|archive|restore|purge))?$/);
  if (productMatch) {
    const id = Number(productMatch[1]);
    const action = productMatch[2];
    if (!action && request.method === "GET") return json(await productDetail(id, env));
    if (!action && request.method === "PUT") return json(await updateProduct(id, await request.json(), env, user));
    if (action === "stock" && request.method === "POST") return json(await adjustStock(id, await request.json(), env, user));
    if (["archive", "restore", "purge"].includes(action) && request.method === "POST") {
      requireRole(user, ["boss", "admin"]);
      return json(await changeProductStatus(id, action, env, user));
    }
  }
  if (path === "/api/uploads" && request.method === "POST") return json(await uploadImage(request, env, user), 201);
  if (path === "/api/data/products.csv" && request.method === "GET") {
    requireRole(user, ["boss", "admin"]);
    return exportProducts(env);
  }
  if (path === "/api/data/summary" && request.method === "GET") {
    requireRole(user, ["boss", "admin"]);
    return json(await dataSummary(env));
  }
  if (path === "/api/data/sales.csv" && request.method === "GET") {
    requireRole(user, ["boss", "admin"]);
    return exportSales(env);
  }
  if (path === "/api/data/inventory.csv" && request.method === "GET") {
    requireRole(user, ["boss", "admin"]);
    return exportInventory(env);
  }
  if (path === "/api/data/import" && request.method === "POST") {
    requireRole(user, ["boss", "admin"]);
    return json(await importProducts(await request.json(), env, user));
  }
  if (path === "/api/sales" && request.method === "GET") return json(await salesData(env));
  if (path === "/api/sales" && request.method === "POST") return json(await recordSale(await request.json(), env, user), 201);
  const saleVoidMatch = path.match(/^\/api\/sales\/(\d+)\/void$/);
  if (saleVoidMatch && request.method === "POST") {
    requireRole(user, ["boss", "admin"]);
    const input = await request.json();
    return json(await voidSale(Number(saleVoidMatch[1]), input.reason, env, user));
  }
  if (path === "/api/users" && request.method === "GET") {
    requireRole(user, ["boss", "admin"]);
    return json(await listUsers(env));
  }
  if (path === "/api/users" && request.method === "POST") {
    requireRole(user, ["boss", "admin"]);
    return json(await createUser(await request.json(), env, user), 201);
  }
  const userMatch = path.match(/^\/api\/users\/(\d+)$/);
  if (userMatch && request.method === "PATCH") {
    requireRole(user, ["boss", "admin"]);
    return json(await updateUser(Number(userMatch[1]), await request.json(), env, user));
  }
  const barcodeMatch = path.match(/^\/api\/barcode\/(\d{8,14})$/);
  if (barcodeMatch && request.method === "GET") return json(await barcodeLookup(barcodeMatch[1], env));
  if (path === "/api/products/ai-draft" && request.method === "POST") return json(await productDraftFromText((await request.json()).description, env));
  if (path === "/api/assistant" && request.method === "GET") return json(await assistantHistory(env));
  if (path === "/api/assistant" && request.method === "POST") return json(await askAssistant(await request.json(), env, user));
  if (path === "/api/assistant/execute" && request.method === "POST") return json(await executeAssistantActions(await request.json(), env, user));
  if (path === "/api/integrations" && request.method === "GET") {
    requireRole(user, ["boss", "admin"]);
    return json(await integrations(env));
  }
  throw new HttpError(404, "接口不存在", "not_found");
}

async function appShell(request, env) {
  return new Response(APP_HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      ...securityHeaders,
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/media/") && request.method === "GET") {
        const key = decodeURIComponent(url.pathname.slice("/media/".length));
        if (!key || key.includes("..")) return new Response("Not found", { status: 404 });
        return serveImage(key, env, request);
      }
      if (url.pathname.startsWith("/api/")) return await routeApi(request, env, url);
      if (request.method === "GET" || request.method === "HEAD") return appShell(request, env);
      return error("Method not allowed", 405, "method_not_allowed");
    } catch (cause) {
      if (cause instanceof HttpError) return error(cause.message, cause.status, cause.code);
      console.error("BHS request failed", cause);
      return error("服务暂时不可用", 500, "internal_error");
    }
  },
};
