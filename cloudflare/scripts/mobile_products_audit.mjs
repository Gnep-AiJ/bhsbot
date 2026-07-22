import { chromium } from "playwright";

const baseURL = process.env.BHS_URL || "https://bhsbot.pages.dev";
const username = process.env.BOSS_USERNAME || "Dongli";
const password = process.env.BOSS_INITIAL_PASSWORD;
const out = process.env.OUT || "/out";
if (!password) throw new Error("BOSS_INITIAL_PASSWORD is required");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
await page.goto(`${baseURL}/login`, { waitUntil: "domcontentloaded" });
await page.fill('input[name="username"]', username);
await page.fill('input[name="password"]', password);
await page.click('button[type="submit"]');
await page.getByRole("heading", { name: "经营总览" }).waitFor();
await page.evaluate(() => document.querySelector('.mobile-nav a[href="/products"]')?.click());
await page.locator(".product-list-item").first().waitFor();

const metrics = await page.evaluate(() => {
  const rows = [...document.querySelectorAll(".product-list-item")];
  const intersects = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
  return {
    viewport: { width: innerWidth, height: innerHeight },
    document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    rows: rows.length,
    row_heights: rows.slice(0, 10).map((row) => Math.round(row.getBoundingClientRect().height)),
    first: (() => {
      const row = rows[0];
      const identity = row.querySelector(".product-identity").getBoundingClientRect();
      const copy = row.querySelector(".product-copy").getBoundingClientRect();
      const stock = row.querySelector(".product-stock").getBoundingClientRect();
      const link = row.querySelector(".product-main-link").getBoundingClientRect();
      return {
        text: row.innerText,
        row: { width: row.getBoundingClientRect().width, height: row.getBoundingClientRect().height },
        identity: { width: identity.width, right: identity.right },
        copy: { width: copy.width, right: copy.right },
        stock: { width: stock.width, left: stock.left, right: stock.right },
        stock_overlaps_copy: intersects(copy, stock),
        anchor_box: { width: link.width, height: link.height },
      };
    })(),
    clipped_names: rows.filter((row) => {
      const name = row.querySelector(".product-copy b");
      return name.scrollWidth > name.clientWidth;
    }).length,
    horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
});

await page.screenshot({ path: `${out}/products-390-top.png`, fullPage: false });
await page.evaluate(() => scrollTo(0, Math.round(document.documentElement.scrollHeight * .45)));
await page.waitForTimeout(150);
await page.screenshot({ path: `${out}/products-390-middle.png`, fullPage: false });

await page.setViewportSize({ width: 360, height: 800 });
await page.evaluate(() => scrollTo(0, 0));
await page.waitForTimeout(100);
await page.screenshot({ path: `${out}/products-360-top.png`, fullPage: false });
const narrow = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth, row: document.querySelector(".product-list-item")?.getBoundingClientRect().toJSON() }));

await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(() => scrollTo(0, 0));
await page.click("[data-manage]");
await page.locator(".product-bulk-form.is-managing").waitFor();
await page.locator(".product-main-link").first().click();
const management = await page.evaluate(() => ({
  selected: document.querySelector('[data-selection-count]')?.textContent,
  checkbox_visible: getComputedStyle(document.querySelector(".product-select")).display !== "none",
  bulk_bar_visible: getComputedStyle(document.querySelector("[data-bulk-bar]")).display !== "none",
}));
await page.screenshot({ path: `${out}/products-390-manage.png`, fullPage: false });

console.log(`AUDIT ${JSON.stringify({ metrics, narrow, management })}`);
await browser.close();
