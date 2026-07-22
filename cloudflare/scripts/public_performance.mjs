import { chromium } from "playwright";

const baseURL = process.env.BHS_URL || "https://bhsbot.pages.dev";
const username = process.env.BOSS_USERNAME || "Dongli";
const password = process.env.BOSS_INITIAL_PASSWORD;
if (!password) throw new Error("BOSS_INITIAL_PASSWORD is required");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const timings = {};
const goto = async (url, options) => {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await page.goto(url, options); }
    catch (error) {
      lastError = error;
      if (!String(error.message).includes("ERR_NETWORK_CHANGED") || attempt === 3) throw error;
      await page.waitForTimeout(500);
    }
  }
  throw lastError;
};

let started = performance.now();
await goto(`${baseURL}/login?perf=${Date.now()}`, { waitUntil: "domcontentloaded" });
await page.locator('input[name="username"]').waitFor();
timings.login_page_ms = Math.round(performance.now() - started);

await page.fill('input[name="username"]', username);
await page.fill('input[name="password"]', password);
started = performance.now();
await page.click('button[type="submit"]');
await page.getByRole("heading", { name: "经营总览" }).waitFor();
timings.login_to_dashboard_ms = Math.round(performance.now() - started);

await page.waitForTimeout(300);
started = performance.now();
await page.click('.mobile-nav a[href="/products"]');
await page.getByRole("heading", { name: "商品", exact: true }).waitFor();
await page.locator(".product-list-item").first().waitFor();
timings.dashboard_to_products_warm_ms = Math.round(performance.now() - started);
timings.products_on_page = await page.locator(".product-list-item").count();

started = performance.now();
await page.locator(".product-main-link").first().click();
await page.locator(".native-product-hero").waitFor();
timings.products_to_detail_ms = Math.round(performance.now() - started);

started = performance.now();
await goto(`${baseURL}/products?perf=${Date.now()}`, { waitUntil: "domcontentloaded" });
await page.locator(".product-list-item").first().waitFor();
timings.products_cold_navigation_ms = Math.round(performance.now() - started);

const layout = await page.evaluate(() => ({
  horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  document_height: document.documentElement.scrollHeight,
  viewport_height: innerHeight,
}));
const resources = await page.evaluate(() => performance.getEntriesByType("resource").map((item) => ({ name: item.name, duration: Math.round(item.duration), transfer: item.transferSize })).filter((item) => item.name.includes("/api/")));
console.log(`PERFORMANCE ${JSON.stringify({ timings, layout, api_resources: resources.slice(-12) })}`);

await browser.close();
