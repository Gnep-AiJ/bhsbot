import { chromium } from "playwright";

const baseURL = process.env.BHS_URL || "http://host.docker.internal:8788";
const username = process.env.BOSS_USERNAME || "Dongli";
const password = process.env.BOSS_INITIAL_PASSWORD;
const out = process.env.OUT || "/out";
if (!password) throw new Error("BOSS_INITIAL_PASSWORD is required");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const pass = (label) => console.log(`PASS  ${label}`);
const assert = (condition, message) => { if (!condition) throw new Error(message); };

await page.goto(`${baseURL}/login`, { waitUntil: "networkidle" });
await page.fill('input[name="username"]', username);
await page.fill('input[name="password"]', password);
await Promise.all([
  page.waitForURL(`${baseURL}/`),
  page.click('button[type="submit"]'),
]);
await page.getByRole("heading", { name: "经营总览" }).waitFor();
pass("SPA login and dashboard");

let layout = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
assert(layout.width <= layout.viewport, `dashboard overflow ${layout.width}/${layout.viewport}`);
await page.screenshot({ path: `${out}/native-dashboard-mobile.png`, fullPage: true });
pass("mobile dashboard layout");

await page.waitForTimeout(450);
const started = Date.now();
await page.click('.mobile-nav a[href="/products"][data-link]');
await page.getByRole("heading", { name: "商品", exact: true }).waitFor();
const transition = Date.now() - started;
assert(transition < 1800, `SPA navigation took ${transition}ms`);
pass(`SPA page transition ${transition}ms`);

await page.click("[data-new-product]");
await page.locator("dialog[open]").waitFor();
await page.screenshot({ path: `${out}/product-entry-mobile.png`, fullPage: true });
await page.click('dialog [data-entry="manual"]');
await page.locator(".native-product-dialog[open]").waitFor();
await page.screenshot({ path: `${out}/product-form-mobile.png`, fullPage: true });
const stamp = Date.now();
await page.fill('dialog input[name="name"]', `浏览器测试商品 ${stamp}`);
await page.fill('dialog input[name="barcode"]', String(stamp).slice(-13).padStart(13, "7"));
await page.fill('dialog input[name="stock"]', "12");
await page.fill('dialog input[name="low_stock"]', "3");
await page.fill('dialog input[name="cost"]', "3.20");
await page.fill('dialog input[name="price"]', "5.80");
await page.fill('dialog input[name="supplier"]', "BHS 测试供应商");
await page.click('dialog button[type="submit"]');
await page.waitForURL(new RegExp(`${baseURL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/products/\\d+`));
await page.locator(".native-product-hero").waitFor();
const productId = Number(new URL(page.url()).pathname.split("/").pop());
assert(productId, "product detail route missing id");
pass("product dialog, D1 create and detail route");

await page.click(".product-operations > summary");
await page.click("[data-stock]");
await page.fill('dialog input[name="quantity"]', "8");
await page.fill('dialog input[name="reason"]', "浏览器回归入库");
await page.click('dialog button[type="submit"]');
await page.getByText("20 件", { exact: false }).first().waitFor();
pass("stock dialog and live detail refresh");

await page.goto(`${baseURL}/assistant`, { waitUntil: "networkidle" });
await page.setViewportSize({ width: 390, height: 520 });
await page.fill("#chatInput", "检查库存");
await page.focus("#chatInput");
await page.waitForTimeout(150);
const assistant = await page.evaluate(() => {
  const form = document.querySelector("[data-chat-form]").getBoundingClientRect();
  return { bottom: Math.round(form.bottom), viewport: window.innerHeight, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, focused: document.body.classList.contains("input-focused") };
});
assert(!assistant.overflow && assistant.focused && assistant.bottom <= assistant.viewport, `assistant layout invalid ${JSON.stringify(assistant)}`);
await page.screenshot({ path: `${out}/native-assistant-keyboard.png`, fullPage: true });
pass("assistant keyboard viewport");

await page.evaluate(async (id) => {
  await fetch(`/api/products/${id}/archive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  await fetch(`/api/products/${id}/purge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
}, productId);

await context.close();
await browser.close();
pass("BHS browser smoke complete");
