import { chromium } from "playwright";

const baseURL = process.env.BHS_URL || "http://host.docker.internal:5173";
const username = process.env.BOSS_USERNAME || "Dongli";
const password = process.env.BOSS_INITIAL_PASSWORD;
const out = process.env.OUT || "/out";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();

await page.goto(`${baseURL}/login`, { waitUntil: "networkidle" });
await page.fill('input[name="username"]', username);
await page.fill('input[name="password"]', password);
await Promise.all([page.waitForURL(`${baseURL}/`), page.click('button[type="submit"]')]);

async function capture(name, path, viewport = { width: 390, height: 844 }) {
  await page.setViewportSize(viewport);
  await page.goto(`${baseURL}${path}`, { waitUntil: "networkidle" });
  const audit = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    width: document.documentElement.scrollWidth,
    firstInputFont: document.querySelector("input, textarea, select")
      ? getComputedStyle(document.querySelector("input, textarea, select")).fontSize
      : null,
  }));
  if (audit.width > audit.viewport) throw new Error(`${name}: overflow ${audit.width}/${audit.viewport}`);
  if (viewport.width <= 820 && audit.firstInputFont && audit.firstInputFont !== "16px") {
    throw new Error(`${name}: mobile input font ${audit.firstInputFont}`);
  }
  console.log(`${name}: width=${audit.width}/${audit.viewport}`);
  await page.screenshot({ path: `${out}/theme-${name}.png` });
}

await capture("dashboard-mobile", "/");
await capture("dashboard-compact", "/", { width: 320, height: 568 });
await capture("products-mobile", "/products");
const detailHref = await page.locator(".product-main-link").first().getAttribute("href");
if (!detailHref) throw new Error("no product available for detail capture");
await capture("detail-mobile", detailHref);
await capture("assistant-mobile", "/assistant");
await capture("sales-mobile", "/sales");
await capture("data-mobile", "/data");
await capture("dashboard-desktop", "/", { width: 1440, height: 1000 });
await capture("products-desktop", "/products", { width: 1440, height: 1000 });

await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${baseURL}/`, { waitUntil: "networkidle" });
await page.click('[data-open-dialog="productEntryDialog"]');
await page.waitForSelector("#productEntryDialog[open]");
await page.screenshot({ path: `${out}/theme-entry-dialog-mobile.png` });

await browser.close();
