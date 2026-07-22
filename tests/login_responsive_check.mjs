import { chromium } from "playwright";

const baseURL = process.env.BHS_URL || "http://127.0.0.1:5173";
const out = process.env.OUT || "/tmp/bhs-visual";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();

async function audit(name, viewport, focusPassword = false) {
  await page.setViewportSize(viewport);
  await page.goto(`${baseURL}/login`, { waitUntil: "networkidle" });
  if (focusPassword) {
    await page.focus('input[name="password"]');
    await page.waitForTimeout(150);
  }

  const result = await page.evaluate(() => {
    const card = document.querySelector(".login-card").getBoundingClientRect();
    const button = document.querySelector('.login-form button').getBoundingClientRect();
    const password = document.querySelector('input[name="password"]');
    return {
      viewportWidth: document.documentElement.clientWidth,
      contentWidth: document.documentElement.scrollWidth,
      viewportHeight: window.innerHeight,
      cardLeft: Math.round(card.left),
      cardRight: Math.round(card.right),
      buttonBottom: Math.round(button.bottom),
      buttonHeight: Math.round(button.height),
      passwordFont: getComputedStyle(password).fontSize,
      focused: document.body.classList.contains("input-focused"),
    };
  });

  if (result.contentWidth > result.viewportWidth) {
    throw new Error(`${name}: horizontal overflow ${result.contentWidth}/${result.viewportWidth}`);
  }
  if (result.cardLeft < 0 || result.cardRight > result.viewportWidth) {
    throw new Error(`${name}: card outside viewport ${result.cardLeft}-${result.cardRight}`);
  }
  if (result.passwordFont !== "16px") {
    throw new Error(`${name}: password input can trigger iOS zoom (${result.passwordFont})`);
  }
  if (result.buttonHeight < 48) {
    throw new Error(`${name}: login button touch target is only ${result.buttonHeight}px`);
  }
  if (focusPassword && !result.focused) {
    throw new Error(`${name}: focus state missing`);
  }
  if (focusPassword && result.buttonBottom > result.viewportHeight) {
    throw new Error(`${name}: login button obscured ${result.buttonBottom}/${result.viewportHeight}`);
  }

  console.log(`${name}: width=${result.contentWidth}/${result.viewportWidth}, button=${result.buttonBottom}/${result.viewportHeight}`);
  await page.screenshot({ path: `${out}/login-${name}.png`, fullPage: false });
}

await audit("iphone-se", { width: 320, height: 568 });
await audit("android", { width: 360, height: 640 });
await audit("iphone", { width: 390, height: 844 });
await audit("short", { width: 390, height: 520 });
await audit("keyboard", { width: 390, height: 430 }, true);
await audit("landscape", { width: 844, height: 390 }, true);

await browser.close();
