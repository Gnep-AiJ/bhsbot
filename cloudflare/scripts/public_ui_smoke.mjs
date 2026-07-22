import { chromium } from "playwright";

const baseURL = process.env.BHS_URL || "https://bhsbot.pages.dev";
const username = process.env.BOSS_USERNAME || "Dongli";
const password = process.env.BOSS_INITIAL_PASSWORD;
const out = process.env.OUT || "/out";
if (!password) throw new Error("BOSS_INITIAL_PASSWORD is required");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const pass = (label) => console.log(`PASS  ${label}`);

await page.goto(`${baseURL}/login`, { waitUntil: "networkidle" });
await page.fill('input[name="username"]', username);
await page.fill('input[name="password"]', password);
await Promise.all([page.waitForURL(`${baseURL}/`), page.click('button[type="submit"]')]);
await page.getByRole("heading", { name: "经营总览" }).waitFor();
assert(!(await page.locator("body").innerText()).includes("Cloudflare"), "infrastructure copy is visible");
assert(!(await page.locator("body").innerText()).includes("原生运行"), "runtime copy is visible");
await page.screenshot({ path: `${out}/dashboard-mobile.png`, fullPage: true });
pass("login, dashboard and business-only copy");

await page.click('.mobile-nav a[href="/products"]');
await page.click("[data-new-product]");
for (const label of ["扫条码", "拍照口述", "手动录入"]) await page.getByRole("button", { name: new RegExp(label) }).waitFor();
await page.screenshot({ path: `${out}/entry-mobile.png`, fullPage: true });
pass("three original product entry paths");

await page.click('[data-entry="manual"]');
await page.locator('input[name="sku"]').waitFor();
assert(await page.inputValue('input[name="low_stock"]') === "5", "low stock default is not 5");
assert(await page.getByText("从图库选择", { exact: true }).isVisible(), "gallery input missing");
await page.screenshot({ path: `${out}/product-form-mobile.png`, fullPage: true });
await page.click(".native-product-dialog [data-dialog-close]");
pass("complete mobile product form");

await page.click("[data-new-product]");
await page.click('[data-entry="ai"]');
await page.getByRole("button", { name: "语音输入" }).waitFor();
await page.getByRole("button", { name: "AI 整理信息" }).waitFor();
await page.click(".native-product-dialog [data-dialog-close]");
pass("AI photo and voice intake");

await page.goto(`${baseURL}/data`, { waitUntil: "networkidle" });
for (const label of ["商品数据", "销售数据", "库存流水", "导入商品", "外部同步"]) await page.getByRole("heading", { name: label }).waitFor();
assert(await page.getByRole("button", { name: "导出 CSV" }).count() === 3, "three CSV exports are not present");
pass("data import and three exports");

await page.goto(`${baseURL}/integrations`, { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "微信对话" }).waitFor();
assert(!(await page.locator("body").innerText()).includes("DeepSeek"), "AI provider detail is visible");
assert(!(await page.locator("body").innerText()).includes("Cloudflare"), "infrastructure detail is visible");
pass("clean WeChat connection status");

await page.setViewportSize({ width: 390, height: 520 });
await page.goto(`${baseURL}/assistant`, { waitUntil: "networkidle" });
await page.fill("#chatInput", "检查库存");
await page.focus("#chatInput");
const chat = await page.evaluate(() => {
  const form = document.querySelector("[data-chat-form]").getBoundingClientRect();
  return { bottom: form.bottom, viewport: innerHeight, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
});
assert(!chat.overflow && chat.bottom <= chat.viewport, `assistant input is outside viewport: ${JSON.stringify(chat)}`);
await page.screenshot({ path: `${out}/assistant-mobile.png`, fullPage: true });
pass("mobile assistant input viewport");

await browser.close();
pass("BHS public UI smoke complete");
