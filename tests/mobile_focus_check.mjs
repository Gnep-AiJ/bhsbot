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
await page.goto(`${baseURL}/assistant`, { waitUntil: "networkidle" });
await page.focus("#chatInput");
await page.fill("#chatInput", "请分析今天的缺货、临期和负毛利商品，并告诉我处理顺序。\n同时给出补货建议。");
await page.setViewportSize({ width: 390, height: 520 });
await page.waitForTimeout(180);

const audit = await page.evaluate(() => {
  const composer = document.querySelector("#chatForm").getBoundingClientRect();
  const input = document.querySelector("#chatInput").getBoundingClientRect();
  const navStyle = getComputedStyle(document.querySelector(".mobile-nav"));
  return {
    viewport: window.innerHeight,
    width: document.documentElement.scrollWidth,
    composerBottom: Math.round(composer.bottom),
    inputHeight: Math.round(input.height),
    focused: document.body.classList.contains("input-focused"),
    navPointerEvents: navStyle.pointerEvents,
  };
});

if (audit.width > 390) throw new Error(`horizontal overflow ${audit.width}px`);
if (!audit.focused) throw new Error("focus state missing");
if (audit.composerBottom > audit.viewport) throw new Error("composer is obscured");
if (audit.inputHeight <= 50 || audit.inputHeight > 116) throw new Error(`bad textarea height ${audit.inputHeight}`);
if (audit.navPointerEvents !== "none") throw new Error("navigation still intercepts touch");
console.log(`assistant-keyboard-mobile: composer=${audit.composerBottom}/${audit.viewport}, input=${audit.inputHeight}px, width=${audit.width}/390`);
await page.screenshot({ path: `${out}/assistant-keyboard-mobile.png`, fullPage: true });

await browser.close();
