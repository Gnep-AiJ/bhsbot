import { chromium } from "playwright";

const baseURL = process.env.BHS_URL || "http://host.docker.internal:5173";
const username = process.env.BOSS_USERNAME || "Dongli";
const password = process.env.BOSS_INITIAL_PASSWORD;
const out = process.env.OUT || "/out";

const browser = await chromium.launch({ headless: true });

async function capture(name, viewport, path, authenticated = true) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`${baseURL}/login`, { waitUntil: "networkidle" });
  if (authenticated) {
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', password);
    await Promise.all([
      page.waitForURL(`${baseURL}/`),
      page.click('button[type="submit"]'),
    ]);
    if (path !== "/") await page.goto(`${baseURL}${path}`, { waitUntil: "networkidle" });
  }
  const audit = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    pageWidth: document.documentElement.scrollWidth,
    firstInputFontSize: document.querySelector("input, textarea, select")
      ? getComputedStyle(document.querySelector("input, textarea, select")).fontSize
      : null,
  }));
  if (audit.pageWidth > audit.viewport) throw new Error(`${name}: horizontal overflow ${audit.pageWidth}px > ${audit.viewport}px`);
  if (name === "login-mobile" && audit.firstInputFontSize !== "16px") {
    throw new Error(`${name}: input font size is ${audit.firstInputFontSize}, expected 16px`);
  }
  console.log(`${name}: width=${audit.pageWidth}/${audit.viewport}, input=${audit.firstInputFontSize || "n/a"}`);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  await context.close();
}

async function captureDialog(name, opener, nextAction = null) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`${baseURL}/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForURL(`${baseURL}/`),
    page.click('button[type="submit"]'),
  ]);
  await page.click(opener);
  if (nextAction) {
    await page.click(nextAction);
    await page.waitForSelector("#barcodeDialog[open]");
  }
  const audit = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    pageWidth: document.documentElement.scrollWidth,
    openDialogs: document.querySelectorAll("dialog[open]").length,
  }));
  if (audit.pageWidth > audit.viewport) throw new Error(`${name}: horizontal overflow ${audit.pageWidth}px > ${audit.viewport}px`);
  if (audit.openDialogs !== 1) throw new Error(`${name}: expected one open dialog, got ${audit.openDialogs}`);
  console.log(`${name}: width=${audit.pageWidth}/${audit.viewport}, dialogs=${audit.openDialogs}`);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  await context.close();
}

async function captureManagedProducts() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`${baseURL}/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await Promise.all([page.waitForURL(`${baseURL}/`), page.click('button[type="submit"]')]);
  await page.goto(`${baseURL}/products`, { waitUntil: "networkidle" });
  await page.click("[data-management-toggle]");
  await page.click(".product-main-link");
  const audit = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    pageWidth: document.documentElement.scrollWidth,
    selected: document.querySelectorAll('input[name="product_ids"]:checked').length,
  }));
  if (audit.pageWidth > audit.viewport) throw new Error(`products-manage-mobile: horizontal overflow`);
  if (audit.selected !== 1) throw new Error(`products-manage-mobile: expected one selection`);
  console.log(`products-manage-mobile: width=${audit.pageWidth}/${audit.viewport}, selected=${audit.selected}`);
  await page.screenshot({ path: `${out}/products-manage-mobile.png`, fullPage: true });
  await page.click(".bulk-primary");
  await page.waitForSelector("#confirmActionDialog[open]");
  await page.screenshot({ path: `${out}/bulk-confirm-mobile.png`, fullPage: true });
  await context.close();
}

async function captureOpenDetails() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`${baseURL}/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await Promise.all([page.waitForURL(`${baseURL}/`), page.click('button[type="submit"]')]);
  await page.goto(`${baseURL}/products`, { waitUntil: "networkidle" });
  const productHref = await page.locator(".product-main-link").first().getAttribute("href");
  if (!productHref) throw new Error("product-operations-mobile: no active product found");
  await page.goto(`${baseURL}${productHref}`, { waitUntil: "networkidle" });
  await page.click(".product-operations > summary");
  await page.screenshot({ path: `${out}/product-operations-mobile.png`, fullPage: true });
  await page.click('[data-open-dialog="stockAdjustDialog"]');
  await page.waitForSelector("#stockAdjustDialog[open]");
  await page.screenshot({ path: `${out}/stock-adjust-mobile.png`, fullPage: true });
  await context.close();
}

async function captureArchivedPurge() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`${baseURL}/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await Promise.all([page.waitForURL(`${baseURL}/`), page.click('button[type="submit"]')]);
  await page.goto(`${baseURL}/products?status=archived`, { waitUntil: "networkidle" });
  await page.click("[data-management-toggle]");
  await page.click(".product-main-link");
  await page.click('[data-operation="purge"]');
  await page.waitForSelector("#confirmActionDialog[open]");
  const message = await page.locator("#confirmActionDialog [data-confirm-message]").textContent();
  if (!message?.includes("永久删除")) throw new Error("archived-purge-mobile: wrong confirmation message");
  await page.screenshot({ path: `${out}/archived-purge-mobile.png`, fullPage: true });
  await context.close();
}

async function captureAssistantKeyboard() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
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
      composerBottom: Math.round(composer.bottom),
      inputHeight: Math.round(input.height),
      focused: document.body.classList.contains("input-focused"),
      navPointerEvents: navStyle.pointerEvents,
    };
  });
  if (!audit.focused) throw new Error("assistant-keyboard-mobile: focus state missing");
  if (audit.composerBottom > audit.viewport) throw new Error("assistant-keyboard-mobile: composer is obscured");
  if (audit.inputHeight <= 50 || audit.inputHeight > 116) throw new Error(`assistant-keyboard-mobile: bad textarea height ${audit.inputHeight}`);
  if (audit.navPointerEvents !== "none") throw new Error("assistant-keyboard-mobile: navigation still intercepts touch");
  console.log(`assistant-keyboard-mobile: composer=${audit.composerBottom}/${audit.viewport}, input=${audit.inputHeight}px`);
  await page.screenshot({ path: `${out}/assistant-keyboard-mobile.png`, fullPage: true });
  await context.close();
}

await capture("login-mobile", { width: 390, height: 844 }, "/", false);
await capture("dashboard-mobile", { width: 390, height: 844 }, "/");
await capture("products-mobile", { width: 390, height: 844 }, "/products");
await capture("product-detail-mobile", { width: 390, height: 844 }, "/products/1");
await capture("assistant-mobile", { width: 390, height: 844 }, "/assistant");
await capture("sales-mobile", { width: 390, height: 844 }, "/sales");
await capture("connections-mobile", { width: 390, height: 844 }, "/integrations");
await capture("product-new-mobile", { width: 390, height: 844 }, "/products/new");
await capture("users-mobile", { width: 390, height: 844 }, "/users");
await capture("data-mobile", { width: 390, height: 844 }, "/data");
await captureDialog("product-entry-modal-mobile", '[data-open-dialog="productEntryDialog"]');
await captureDialog("barcode-modal-mobile", '[data-open-dialog="productEntryDialog"]', "[data-open-barcode]");
await captureManagedProducts();
await captureArchivedPurge();
await captureOpenDetails();
await captureAssistantKeyboard();
await capture("dashboard-narrow", { width: 375, height: 812 }, "/");
await capture("dashboard-desktop", { width: 1440, height: 1000 }, "/");

await browser.close();
