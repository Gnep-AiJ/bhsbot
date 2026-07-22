import { chromium } from "playwright";

const baseURL = process.env.BHS_URL || "https://bhsbot.pages.dev";
const username = process.env.BOSS_USERNAME || "Dongli";
const password = process.env.BOSS_INITIAL_PASSWORD;
const out = process.env.OUT || "/out";
if (!password) throw new Error("BOSS_INITIAL_PASSWORD is required");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
let mockedPosts = 0;
try {
  await page.route("**/api/assistant", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    mockedPosts += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        reply: "已查询当前商品，下面显示前 3 个。",
        actions: [],
        outputs: [{ type: "products", title: "当前商品", total: 3, items: [
          { id: 1, name: "测试商品 A", stock: 12, unit: "件", price: 5.2, image_url: "" },
          { id: 2, name: "测试商品 B", stock: 8, unit: "瓶", price: 8.8, image_url: "" },
          { id: 3, name: "测试商品 C", stock: 3, unit: "袋", price: 12, image_url: "" },
        ] }],
      }),
    });
  });
  await page.goto(`${baseURL}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.getByRole("heading", { name: "经营总览" }).waitFor();
  await page.click('.mobile-nav a[href="/assistant"]');
  await page.getByRole("heading", { name: "BHS AI" }).waitFor();
  await page.locator('.butler-form textarea[name="message"]').fill("查询当前商品，返回前 3 个商品卡片，只查询，不要修改。");
  const response = page.waitForResponse((item) => item.url().endsWith("/api/assistant") && item.request().method() === "POST");
  await page.locator("[data-chat-form]").evaluate((form) => form.requestSubmit());
  await response;
  await page.locator(".assistant-data-card").first().waitFor({ timeout: 10_000 });
  const audit = await page.evaluate(() => ({
    cards: document.querySelectorAll(".assistant-data-card").length,
    products: document.querySelectorAll(".assistant-product-results a").length,
    proposed_actions: document.querySelectorAll(".native-ai-actions").length,
    horizontal_overflow: document.documentElement.scrollWidth > innerWidth,
  }));
  if (audit.cards < 1 || audit.products < 1) {
    const assistantText = await page.locator(".message.assistant").last().innerText().catch(() => "");
    throw new Error(`structured cards missing: ${JSON.stringify(audit)} assistant=${assistantText.slice(0, 300)}`);
  }
  if (audit.proposed_actions) throw new Error("read-only query displayed mutation actions");
  if (audit.horizontal_overflow) throw new Error("assistant result cards overflow mobile viewport");
  await page.screenshot({ path: `${out}/assistant-structured-mobile.png`, fullPage: true });
  console.log(`PASS  mobile structured AI results ${JSON.stringify({ ...audit, mocked_posts: mockedPosts })}`);
} finally {
  await browser.close();
}
