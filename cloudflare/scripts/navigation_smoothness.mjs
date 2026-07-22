import { chromium } from "playwright";

const baseURL = process.env.BHS_URL || "https://bhsbot.pages.dev";
const username = process.env.BOSS_USERNAME || "Dongli";
const password = process.env.BOSS_INITIAL_PASSWORD;
if (!password) throw new Error("BOSS_INITIAL_PASSWORD is required");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
let delayed = false;

await page.route("**/api/products?*", async (route) => {
  if (!delayed) {
    delayed = true;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  await route.continue();
});

await page.goto(`${baseURL}/login`, { waitUntil: "domcontentloaded" });
await page.fill('input[name="username"]', username);
await page.fill('input[name="password"]', password);
await page.click('button[type="submit"]');
await page.getByRole("heading", { name: "经营总览" }).waitFor();

await page.click('.mobile-nav a[href="/products"]');
await page.waitForTimeout(120);
const transition = await page.evaluate(() => ({
  old_view_preserved: Boolean([...document.querySelectorAll("h1")].find((item) => item.textContent === "经营总览")),
  progress_visible: document.querySelector("#app")?.classList.contains("route-loading"),
  product_tab_active: document.querySelector('.mobile-nav a[href="/products"]')?.classList.contains("active"),
  loading_screen_visible: Boolean(document.querySelector(".native-page-loading")),
}));

await page.getByRole("heading", { name: "商品", exact: true }).waitFor();
const settled = await page.evaluate(() => ({
  rows: document.querySelectorAll(".product-list-item").length,
  progress_visible: document.querySelector("#app")?.classList.contains("route-loading"),
}));

if (!transition.old_view_preserved || !transition.progress_visible || !transition.product_tab_active || transition.loading_screen_visible) {
  throw new Error(`navigation transition regressed: ${JSON.stringify(transition)}`);
}
if (settled.rows !== 20 || settled.progress_visible) throw new Error(`navigation did not settle: ${JSON.stringify(settled)}`);

console.log(`PASS  smooth navigation ${JSON.stringify({ transition, settled })}`);
await browser.close();
