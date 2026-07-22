const root = document.querySelector("#app");
const state = { user: null, route: location.pathname, productQuery: new URLSearchParams(location.search), cache: new Map() };

const icons = {
  dashboard: '<svg viewBox="0 0 24 24"><path d="M4 13h6V4H4v9Zm0 7h6v-4H4v4Zm10 0h6v-9h-6v9Zm0-16v4h6V4h-6Z"/></svg>',
  products: '<svg viewBox="0 0 24 24"><path d="m12 3 8 4-8 4-8-4 8-4Zm-8 7 7 3.5V21l-7-3.5V10Zm9 11v-7.5l7-3.5v7.5L13 21Z"/></svg>',
  sales: '<svg viewBox="0 0 24 24"><path d="M3 20h4V10H3v10Zm7 0h4V5h-4v15Zm7 0h4V3h-4v17Z"/></svg>',
  assistant: '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7v1.3A4 4 0 0 0 6 18h2l4 4 4-4h2a4 4 0 0 0 1-7.7V9a7 7 0 0 0-7-7Zm-3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm6 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M12 8v5m0 4h.01M10 3h4l8 16H2L10 3Z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></svg>',
  chevron: '<svg class="product-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>',
  scan: '<svg viewBox="0 0 24 24"><path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M8 9v6M11 8v8M14 9v6M17 8v8"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M4 7h4l1.5-2h5L16 7h4v12H4V7Z"/><circle cx="12" cy="13" r="3"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="m4 16-.5 4.5L8 20 19 9l-4-4L4 16ZM13.5 6.5l4 4"/></svg>',
  mic: '<svg viewBox="0 0 24 24"><rect x="8" y="3" width="8" height="12" rx="4"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 20h14"/></svg>',
};

function esc(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function money(value, digits = 2) {
  return `¥${Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function quantity(value) {
  return Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function dateTime(value) {
  if (!value) return "—";
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.valueOf()) ? esc(value) : date.toLocaleString("zh-CN", { hour12: false });
}

async function api(path, options = {}) {
  const config = { credentials: "same-origin", ...options, headers: { ...(options.headers || {}) } };
  if (config.body && !(config.body instanceof FormData) && typeof config.body !== "string") {
    config.headers["Content-Type"] = "application/json";
    config.body = JSON.stringify(config.body);
  }
  const response = await fetch(path, config);
  if (options.raw) return response;
  const data = await response.json().catch(() => ({ error: "服务返回异常" }));
  if (!response.ok) {
    if (response.status === 401 && state.user) {
      state.user = null;
      await navigate("/login", { replace: true });
    }
    throw new Error(data.error || "操作失败");
  }
  if (config.method && config.method !== "GET") state.cache.clear();
  return data;
}

function apiCached(path, ttl = 10000) {
  const cached = state.cache.get(path);
  if (cached && Date.now() - cached.time < ttl) return cached.promise;
  const promise = api(path).catch((cause) => { state.cache.delete(path); throw cause; });
  state.cache.set(path, { time: Date.now(), promise });
  return promise;
}

function prefetchCoreData() {
  apiCached("/api/products?", 15000).catch(() => {});
  apiCached("/api/sales", 15000).catch(() => {});
}

function loading(label = "加载中") {
  return `<section class="native-page-loading"><span class="native-spinner"></span><p>${esc(label)}</p></section>`;
}

function toast(message, type = "success") {
  let stack = document.querySelector(".native-toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "native-toast-stack";
    document.body.append(stack);
  }
  const item = document.createElement("div");
  item.className = `native-toast ${type}`;
  item.textContent = message;
  stack.append(item);
  setTimeout(() => item.remove(), 3200);
}

function activeFor(path) {
  if (path === "/") return state.route === "/";
  return state.route.startsWith(path);
}

function locationKey() {
  return `${location.pathname}${location.search}`;
}

function syncNavigation() {
  root.querySelectorAll(".desktop-nav a, .mobile-nav a").forEach((link) => {
    link.classList.toggle("active", activeFor(new URL(link.href).pathname));
  });
}

function shell(content, title = "BHS") {
  document.title = `${title} · BHS`;
  const user = state.user;
  const page = root.querySelector("main.native-page");
  const isLoading = content.includes('class="native-page-loading"');
  if (page) {
    syncNavigation();
    if (isLoading && page.childElementCount) {
      page.setAttribute("aria-busy", "true");
      root.classList.add("route-loading");
      return;
    }
    page.innerHTML = content;
    page.removeAttribute("aria-busy");
    root.classList.remove("route-loading");
    window.scrollTo({ top: 0, behavior: "instant" });
    return;
  }
  root.innerHTML = `
    <header class="topbar native-topbar">
      <a class="brand" href="/" data-link aria-label="BHS 首页"><span class="brand-mark">B</span><span class="brand-copy"><b>BHS</b><small>门店系统</small></span></a>
      <nav class="desktop-nav" aria-label="主导航">
        <a class="${activeFor("/") ? "active" : ""}" href="/" data-link>${icons.dashboard}总览</a>
        <a class="${activeFor("/products") ? "active" : ""}" href="/products" data-link>${icons.products}商品</a>
        <a class="${activeFor("/sales") ? "active" : ""}" href="/sales" data-link>${icons.sales}销售</a>
        <a class="${activeFor("/assistant") ? "active" : ""}" href="/assistant" data-link>${icons.assistant}管家</a>
      </nav>
      <details class="user-menu">
        <summary aria-label="账号菜单"><span class="user-avatar">${esc(user.display_name.slice(0, 1).toUpperCase())}</span><span class="user-name">${esc(user.display_name)}</span>${icons.arrow}</summary>
        <div class="user-popover"><b>${esc(user.display_name)}</b><small>${roleName(user.role)} · ${esc(user.username)}</small>
          ${(user.role === "boss" || user.role === "admin") ? '<nav class="account-links"><a href="/users" data-link>成员管理<span>→</span></a><a href="/data" data-link>数据管理<span>→</span></a><a href="/integrations" data-link>连接状态<span>→</span></a></nav>' : ""}
          <button class="native-text-button" type="button" data-logout>退出登录</button>
        </div>
      </details>
    </header>
    <main class="page native-page">${content}</main>
    <nav class="mobile-nav" aria-label="手机导航">
      <a class="${activeFor("/") ? "active" : ""}" href="/" data-link>${icons.dashboard}<span>总览</span></a>
      <a class="${activeFor("/products") ? "active" : ""}" href="/products" data-link>${icons.products}<span>商品</span></a>
      <a class="${activeFor("/sales") ? "active" : ""}" href="/sales" data-link>${icons.sales}<span>销售</span></a>
      <a class="ai-tab ${activeFor("/assistant") ? "active" : ""}" href="/assistant" data-link>${icons.assistant}<span>管家</span></a>
    </nav>`;
  root.querySelector("[data-logout]")?.addEventListener("click", logout);
  syncNavigation();
}

function roleName(role) {
  return ({ boss: "Boss", admin: "管理员", employee: "员工" })[role] || "成员";
}

async function logout() {
  try { await api("/api/logout", { method: "POST", body: {} }); } catch {}
  state.user = null;
  await navigate("/login", { replace: true });
}

async function renderLogin() {
  root.classList.remove("route-loading");
  document.body.className = "auth-page native-auth-page";
  document.title = "登录 · BHS";
  root.innerHTML = `<main class="auth-main native-auth-main">
    <section class="login-card native-login-card">
      <header><span class="login-logo">B</span><div><p>BHS</p><h1>门店管理</h1></div></header>
      <p class="native-login-note">使用内部账号进入</p>
      <form class="login-form" data-login-form>
        <label>账号<input name="username" autocomplete="username" autocapitalize="none" value="Dongli" required></label>
        <label>密码<input name="password" type="password" autocomplete="current-password" required></label>
        <p class="native-form-error" data-error hidden></p>
        <button class="button primary full" type="submit">进入 BHS</button>
      </form>
    </section>
  </main>`;
  const form = root.querySelector("[data-login-form]");
  const errorBox = form.querySelector("[data-error]");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    button.textContent = "正在验证…";
    errorBox.hidden = true;
    try {
      const data = await api("/api/login", { method: "POST", body: Object.fromEntries(new FormData(form)) });
      state.user = data.user;
      await navigate("/", { replace: true });
    } catch (cause) {
      errorBox.textContent = cause.message;
      errorBox.hidden = false;
      button.disabled = false;
      button.textContent = "进入 BHS";
    }
  });
}

async function renderDashboard() {
  const viewKey = locationKey();
  shell(loading("读取经营数据"), "经营总览");
  const { stats, trend, recent_movements: movements } = await apiCached("/api/dashboard", 5000);
  if (viewKey !== locationKey()) return;
  const issueTotal = Number(stats.out_count) + Number(stats.missing_price_count) + Number(stats.negative_margin_count) + Number(stats.expiring_count);
  const maxRevenue = Math.max(1, ...trend.map((item) => Number(item.revenue)));
  const chart = trend.map((item, index) => `${index * (100 / 6)},${96 - (Number(item.revenue) / maxRevenue) * 78}`).join(" ");
  shell(`
    <header class="page-head dashboard-head cockpit-page-head"><div><p class="eyebrow">BHS · 门店实时经营</p><h1>经营总览</h1></div><button class="icon-button add-main" type="button" data-new-product>${icons.plus}<span>录入商品</span></button></header>
    <section class="overview-board" aria-label="核心经营指标">
      <header class="overview-board-head"><div class="overview-live"><i></i><b>经营数据</b><span>${stats.has_sales ? "销售已同步" : "销售数据待接入"}</span></div>${isManager() ? '<a href="/data" data-link>数据中心 <span>→</span></a>' : ""}</header>
      <div class="overview-kpis">
        <article class="overview-kpi kpi-sales"><header><span>今日销售额</span>${icons.sales}</header><strong>${money(stats.today_revenue)}</strong><footer><span>近 7 日累计</span><b>${money(stats.week_revenue, 0)}</b></footer></article>
        <article class="overview-kpi kpi-profit ${Number(stats.today_profit) < 0 ? "is-negative" : ""}"><header><span>今日毛利</span><span class="native-kpi-icon">↗</span></header><strong>${money(stats.today_profit)}</strong><footer>${Number(stats.today_revenue) ? `<span>毛利率</span><b>${(Number(stats.today_profit) / Number(stats.today_revenue) * 100).toFixed(1)}%</b>` : "<span>暂无销售记录</span>"}</footer></article>
        <a class="overview-kpi kpi-alert ${issueTotal ? "has-alert" : ""}" href="/products?issue=out" data-link><header><span>经营异常</span>${icons.alert}</header><strong>${issueTotal}</strong><footer><span>缺货 ${stats.out_count}</span><b>临期 ${stats.expiring_count} →</b></footer></a>
      </div>
      <section class="inventory-overview"><header class="inventory-overview-head"><div><b>库存概况</b><span>按当前商品档案估算</span></div><a href="/products" data-link>查看商品 →</a></header>
        <div class="inventory-overview-grid">
          <a href="/products" data-link><span>商品数量</span><b>${stats.products}</b><small>${stats.low_count} 件待补货</small></a>
          <a href="/products" data-link><span>库存总量</span><b>${quantity(stats.stock)}</b><small>当前在库件数</small></a>
          <a href="/products" data-link><span>库存成本</span><b>${money(stats.cost_value, 0)}</b><small>按商品进价计算</small></a>
          <a href="/products" data-link><span>库存货值</span><b>${money(stats.retail_value, 0)}</b><small>预计毛利 ${money(stats.potential_profit, 0)}</small></a>
        </div>
      </section>
    </section>
    <div class="dashboard-main-grid cockpit-content-grid">
      <section class="ops-panel sales-panel cockpit-panel"><header class="ops-panel-head"><div><p class="eyebrow">销售走势</p><h2>近 7 日</h2></div><a href="/sales" data-link>销售中心</a></header>
        <div class="sales-chart ${stats.has_sales ? "" : "is-empty"}"><div class="chart-grid"></div><svg viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points="${chart}"/></svg>${stats.has_sales ? "" : '<div class="chart-empty"><b>暂无销售数据</b><span>手动记账或接入收银系统后自动更新</span></div>'}</div>
        <div class="chart-labels">${trend.map((item) => `<span>${esc(item.label)}</span>`).join("")}</div>
      </section>
      <section class="ops-panel task-panel cockpit-panel"><header class="ops-panel-head"><div><p class="eyebrow">今日待办</p><h2>经营异常</h2></div><span class="task-total">${issueTotal}</span></header>
        <div class="task-list">
          ${taskLink("缺货商品", "库存已经为 0", stats.out_count, "out", "danger")}
          ${taskLink("价格待完善", "缺少进价或售价", stats.missing_price_count, "pricing", "amber")}
          ${taskLink("负毛利商品", "售价低于进价", stats.negative_margin_count, "margin", "danger")}
          ${taskLink("临期商品", "30 天内到期", stats.expiring_count, "expiry", "")}
        </div>
      </section>
    </div>
    <section class="ops-panel movement-panel dashboard-movement cockpit-panel"><header class="ops-panel-head"><div><p class="eyebrow">库存流水</p><h2>最近变动</h2></div><a href="/data" data-link>查看数据</a></header>
      ${movements.length ? `<div class="movement-list">${movements.map((item) => `<a href="/products/${item.product_id}" data-link><span><b>${esc(item.product_name)}</b><small>${esc(item.reason)}</small></span><strong class="${Number(item.change_amount) < 0 ? "negative" : ""}">${Number(item.change_amount) > 0 ? "+" : ""}${quantity(item.change_amount)}</strong></a>`).join("")}</div>` : '<div class="compact-empty"><b>暂无库存变动</b><span>入库、销售和 AI 调整会记录在这里</span></div>'}
    </section>`, "经营总览");
  root.querySelector("[data-new-product]")?.addEventListener("click", openEntryDialog);
  prefetchCoreData();
}

function taskLink(name, note, count, issue, tone) {
  return `<a href="/products?issue=${issue}" data-link><span class="task-icon ${tone}">${icons.alert}</span><span><b>${name}</b><small>${note}</small></span><strong>${count}</strong></a>`;
}

function isManager() {
  return state.user && ["boss", "admin"].includes(state.user.role);
}

async function renderProducts() {
  const viewKey = locationKey();
  shell(loading("读取商品"), "商品");
  const query = new URLSearchParams(location.search);
  const data = await apiCached(`/api/products?${query.toString()}`, 30000);
  if (viewKey !== locationKey()) return;
  const products = data.products;
  shell(`
    <header class="page-head split products-head product-page-head"><div><p class="eyebrow">商品档案</p><h1>${data.status === "archived" ? "已停用商品" : "商品"}</h1><p class="head-note">共 ${data.total} 件</p></div><div class="product-header-actions">${isManager() ? `<button class="button secondary manage-toggle" type="button" data-manage>${icons.products}<span>管理</span></button>` : ""}<button class="button primary button-icon product-add-button" type="button" data-new-product>${icons.plus}<span>录入商品</span></button></div></header>
    <section class="product-controls"><form class="product-search" data-product-search><label class="search-input"><span class="sr-only">搜索商品</span>${icons.products}<input type="search" name="q" value="${esc(data.q)}" placeholder="名称、条码或供应商"></label><button type="submit">搜索</button></form>
      <nav class="filter-tabs product-filter-tabs"><a class="${data.status === "active" && !data.issue ? "active" : ""}" href="/products" data-link>在售</a><a class="${data.status === "low" ? "active" : ""}" href="/products?status=low" data-link>待补货</a>${isManager() ? `<a class="${data.status === "archived" ? "active" : ""}" href="/products?status=archived" data-link>已停用</a>` : ""}</nav>
    </section>
    ${data.issue ? `<div class="active-filter-note"><span>${({ out: "缺货商品", pricing: "价格待完善", margin: "负毛利商品", expiry: "30 天内到期" })[data.issue]}</span><a href="/products" data-link>清除筛选</a></div>` : ""}
    <form class="product-bulk-form" data-bulk-form>
      ${products.length ? `<div class="product-list" role="list">${products.map(productRow).join("")}</div>
      <div class="bulk-action-bar" data-bulk-bar><div><b><span data-selection-count>0</span> 件已选</b><button type="button" data-select-all>全选本页</button></div><div class="bulk-buttons">${data.status === "archived" ? '<button class="bulk-primary" type="button" data-bulk="restore">恢复所选</button><button class="bulk-primary danger" type="button" data-bulk="purge">永久删除</button>' : '<button class="bulk-primary danger" type="button" data-bulk="archive">停用所选</button>'}</div></div>` : '<section class="product-empty"><h2>没有匹配的商品</h2><p>调整筛选条件，或录入第一件商品。</p></section>'}
    </form>
    ${data.pages > 1 ? `<nav class="pagination"><a class="${data.page <= 1 ? "disabled" : ""}" href="${pageHref(data.page - 1)}" data-link>上一页</a><span>${data.page} / ${data.pages}</span><a class="${data.page >= data.pages ? "disabled" : ""}" href="${pageHref(data.page + 1)}" data-link>下一页</a></nav>` : ""}`, "商品");
  root.querySelector("[data-new-product]")?.addEventListener("click", openEntryDialog);
  root.querySelector("[data-product-search]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const q = new FormData(event.currentTarget).get("q");
    navigate(`/products${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  });
  bindBulkActions();
}

function productRow(product) {
  const margin = Number(product.price) ? ((Number(product.price) - Number(product.cost)) / Number(product.price) * 100) : 0;
  const low = Number(product.stock) <= Number(product.low_stock);
  return `<article class="product-list-item ${low ? "is-low" : ""} ${product.archived_at ? "is-archived" : ""}">
    <label class="product-select"><input type="checkbox" name="product_ids" value="${product.id}"><span></span></label>
    <a class="product-main-link" href="/products/${product.id}" data-link aria-label="查看${esc(product.name)}详情"></a>
    <div class="product-identity"><span class="product-avatar product-list-avatar">${product.image_key ? `<img src="/media/${encodeURIComponent(product.image_key)}" alt="" loading="lazy" decoding="async">` : esc(product.name.slice(0, 1))}</span><span class="product-copy"><b>${esc(product.name)}</b><small>${esc([product.brand, product.specification].filter(Boolean).join(" · ") || product.barcode || product.category || "资料待完善")}</small></span></div>
    <div class="product-stock"><span>库存</span><b>${quantity(product.stock)} ${esc(product.unit)}</b>${product.archived_at ? "<i class=\"archived\">已停用</i>" : low ? "<i>待补货</i>" : ""}</div>
    <div class="product-number"><span>进价</span><b>${money(product.cost)}</b></div><div class="product-number"><span>售价</span><b>${money(product.price)}</b></div>
    <div class="product-number product-margin ${margin < 0 ? "is-negative" : ""}"><span>毛利率</span><b>${margin.toFixed(1)}%</b></div><div class="product-supplier"><span>供应商</span><b>${esc(product.supplier || "未设置")}</b></div>${icons.chevron}
  </article>`;
}

function pageHref(page) {
  const query = new URLSearchParams(location.search);
  query.set("page", page);
  return `/products?${query}`;
}

function bindBulkActions() {
  const form = root.querySelector("[data-bulk-form]");
  if (!form) return;
  const checkboxes = [...form.querySelectorAll('input[name="product_ids"]')];
  const bar = form.querySelector("[data-bulk-bar]");
  const update = () => {
    const count = checkboxes.filter((item) => item.checked).length;
    if (bar) bar.querySelector("[data-selection-count]").textContent = count;
  };
  const manageButton = root.querySelector("[data-manage]");
  manageButton?.addEventListener("click", () => {
    const active = !form.classList.contains("is-managing");
    form.classList.toggle("is-managing", active);
    manageButton.classList.toggle("active", active);
    manageButton.setAttribute("aria-pressed", String(active));
    if (!active) checkboxes.forEach((item) => { item.checked = false; });
    update();
  });
  form.querySelectorAll(".product-main-link").forEach((link) => link.addEventListener("click", (event) => {
    if (!form.classList.contains("is-managing")) return;
    event.preventDefault();
    const checkbox = link.closest(".product-list-item")?.querySelector('input[name="product_ids"]');
    if (checkbox) checkbox.checked = !checkbox.checked;
    update();
  }));
  checkboxes.forEach((item) => item.addEventListener("change", update));
  form.querySelector("[data-select-all]")?.addEventListener("click", () => { checkboxes.forEach((item) => { item.checked = true; }); update(); });
  form.querySelectorAll("[data-bulk]").forEach((button) => button.addEventListener("click", async () => {
    const ids = checkboxes.filter((item) => item.checked).map((item) => Number(item.value));
    if (!ids.length) return toast("请先选择商品", "error");
    const operation = button.dataset.bulk;
    const label = ({ archive: "停用", restore: "恢复", purge: "永久删除" })[operation];
    if (!confirm(`确定${label} ${ids.length} 件商品吗？${operation === "purge" ? "此操作无法恢复。" : ""}`)) return;
    try { await api("/api/products/bulk", { method: "POST", body: { ids, operation } }); toast(`${label}完成`); await renderProducts(); } catch (cause) { toast(cause.message, "error"); }
  }));
}

async function renderProductDetail(id) {
  const viewKey = locationKey();
  shell(loading("读取商品详情"), "商品详情");
  const { product, movements, sales } = await apiCached(`/api/products/${id}`, 30000);
  if (viewKey !== locationKey()) return;
  const margin = Number(product.price) ? ((Number(product.price) - Number(product.cost)) / Number(product.price) * 100) : 0;
  shell(`
    <header class="page-head split native-detail-head"><div><a class="native-back" href="/products" data-link>← 商品</a><p class="eyebrow">商品档案</p><h1>${esc(product.name)}</h1><p class="head-note">${esc([product.brand, product.specification].filter(Boolean).join(" · ") || product.barcode || "资料待完善")}</p></div>
      <details class="product-operations"><summary>操作</summary><div><button type="button" data-edit>编辑资料</button>${product.archived_at ? '<button type="button" data-status="restore">恢复商品</button><button class="danger" type="button" data-status="purge">永久删除</button>' : '<button type="button" data-stock>调整库存</button><button class="danger" type="button" data-status="archive">停用商品</button>'}</div></details>
    </header>
    <section class="native-product-hero"><div class="native-product-image">${product.image_key ? `<img src="/media/${encodeURIComponent(product.image_key)}" alt="">` : `<span>${esc(product.name.slice(0, 1))}</span>`}</div><div class="native-product-kpis"><article><span>库存</span><b>${quantity(product.stock)} ${esc(product.unit)}</b><small>预警 ${quantity(product.low_stock)}</small></article><article><span>进价</span><b>${money(product.cost)}</b><small>库存成本 ${money(Number(product.cost) * Number(product.stock))}</small></article><article><span>售价</span><b>${money(product.price)}</b><small>毛利率 ${margin.toFixed(1)}%</small></article></div></section>
    <div class="native-detail-grid"><section class="ops-panel native-info-panel"><header class="ops-panel-head"><div><p class="eyebrow">商品信息</p><h2>档案详情</h2></div></header><dl class="native-info-list">
      ${detailItem("条码", product.barcode)}${detailItem("SKU", product.sku)}${detailItem("分类", product.category)}${detailItem("货位", product.location)}${detailItem("供应商", product.supplier)}${detailItem("联系方式", product.supplier_contact)}${detailItem("到期日期", product.expiry_date)}${detailItem("备注", product.notes)}
    </dl></section>
    <section class="ops-panel movement-panel"><header class="ops-panel-head"><div><p class="eyebrow">库存流水</p><h2>最近变动</h2></div></header>${movements.length ? `<div class="movement-list">${movements.map((item) => `<div><span><b>${esc(item.reason)}</b><small>${dateTime(item.created_at)}</small></span><strong class="${Number(item.change_amount) < 0 ? "negative" : ""}">${Number(item.change_amount) > 0 ? "+" : ""}${quantity(item.change_amount)}</strong></div>`).join("")}</div>` : '<div class="compact-empty"><b>暂无库存变动</b></div>'}</section></div>
    ${sales.length ? `<section class="ops-panel native-sales-history"><header class="ops-panel-head"><div><p class="eyebrow">销售记录</p><h2>最近销售</h2></div></header><div class="movement-list">${sales.map((sale) => `<div><span><b>${quantity(sale.quantity)} ${esc(product.unit)}</b><small>${dateTime(sale.created_at)}</small></span><strong>${money(sale.revenue)}</strong></div>`).join("")}</div></section>` : ""}`, product.name);
  root.querySelector("[data-edit]")?.addEventListener("click", () => openProductDialog(product));
  root.querySelector("[data-stock]")?.addEventListener("click", () => openStockDialog(product));
  root.querySelectorAll("[data-status]").forEach((button) => button.addEventListener("click", async () => {
    const operation = button.dataset.status;
    const label = ({ archive: "停用", restore: "恢复", purge: "永久删除" })[operation];
    if (!confirm(`确定${label}“${product.name}”吗？${operation === "purge" ? "此操作无法恢复。" : ""}`)) return;
    try { await api(`/api/products/${product.id}/${operation}`, { method: "POST", body: {} }); toast(`${label}完成`); await navigate("/products"); } catch (cause) { toast(cause.message, "error"); }
  }));
}

function detailItem(label, value) {
  return `<div><dt>${label}</dt><dd>${esc(value || "未设置")}</dd></div>`;
}

function showDialog(content, className = "native-dialog") {
  const dialog = document.createElement("dialog");
  dialog.className = `app-dialog ${className}`;
  dialog.innerHTML = `<section class="dialog-sheet">${content}</section>`;
  document.body.append(dialog);
  document.body.classList.add("has-dialog");
  dialog.addEventListener("close", () => { dialog.remove(); if (!document.querySelector("dialog[open]")) document.body.classList.remove("has-dialog"); });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.querySelectorAll("[data-dialog-close]").forEach((button) => button.addEventListener("click", () => dialog.close()));
  dialog.showModal();
  return dialog;
}

function openEntryDialog() {
  const dialog = showDialog(`<header class="dialog-head"><div><p class="eyebrow">录入商品</p><h2>选择录入方式</h2></div><button class="dialog-close" type="button" data-dialog-close>×</button></header>
    <div class="entry-options">
      <button type="button" data-entry="scan"><span class="entry-option-icon">${icons.scan}</span><span><b>扫条码</b><small>拍摄或输入包装条码</small></span><i>›</i></button>
      <button type="button" data-entry="ai"><span class="entry-option-icon">${icons.camera}</span><span><b>拍照口述</b><small>拍商品，语音或文字告诉 AI</small></span><i>›</i></button>
      <button type="button" data-entry="manual"><span class="entry-option-icon">${icons.edit}</span><span><b>手动录入</b><small>完整填写商品资料</small></span><i>›</i></button>
    </div>`, "entry-dialog");
  dialog.querySelector('[data-entry="scan"]').addEventListener("click", () => { dialog.close(); openBarcodeDialog(); });
  dialog.querySelector('[data-entry="ai"]').addEventListener("click", () => { dialog.close(); openProductDialog(null, null, { aiMode: true }); });
  dialog.querySelector('[data-entry="manual"]').addEventListener("click", () => { dialog.close(); openProductDialog(); });
}

async function detectBarcode(file) {
  if (!("BarcodeDetector" in window)) throw new Error("当前浏览器不支持照片识别，请直接输入条码");
  const supported = await BarcodeDetector.getSupportedFormats?.() || [];
  const wanted = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "itf"].filter((format) => !supported.length || supported.includes(format));
  const detector = new BarcodeDetector(wanted.length ? { formats: wanted } : undefined);
  const bitmap = await createImageBitmap(file);
  try {
    const codes = await detector.detect(bitmap);
    const code = codes.find((item) => /^\d{8,14}$/.test(item.rawValue?.replace(/\s/g, "")))?.rawValue;
    if (!code) throw new Error("没有识别到条码，请重新拍摄或直接输入");
    return code.replace(/\s/g, "");
  } finally { bitmap.close(); }
}

async function lookupBarcode(code, feedback, dialog) {
  const clean = String(code || "").replace(/\s/g, "");
  if (!/^\d{8,14}$/.test(clean)) { feedback.innerHTML = '<p class="lookup-state error">请输入 8–14 位数字条码</p>'; return; }
  feedback.innerHTML = '<p class="lookup-state">正在查询商品资料…</p>';
  try {
    const result = await api(`/api/barcode/${encodeURIComponent(clean)}`);
    const draft = result.found ? result.product : { barcode: clean };
    feedback.innerHTML = result.found
      ? `<div class="barcode-result"><span class="barcode-result-placeholder">商品</span><span><b>${esc(draft.name || "未命名商品")}</b><small>${esc([draft.brand, draft.specification].filter(Boolean).join(" · ") || clean)}</small></span><button class="button primary full" type="button" data-use-barcode>继续录入</button></div>`
      : `<div class="barcode-result"><span class="barcode-result-placeholder">条码</span><span><b>未查到现成资料</b><small>${esc(clean)} · 可继续补充</small></span><button class="button primary full" type="button" data-use-barcode>继续录入</button></div>`;
    feedback.querySelector("[data-use-barcode]").addEventListener("click", () => { dialog.close(); openProductDialog(null, draft); });
  } catch (cause) { feedback.innerHTML = `<p class="lookup-state error">${esc(cause.message)}</p>`; }
}

function openBarcodeDialog() {
  const dialog = showDialog(`<header class="dialog-head"><div><p class="eyebrow">录入商品</p><h2>扫商品条码</h2></div><button class="dialog-close" type="button" data-dialog-close>×</button></header>
    <label class="barcode-capture">${icons.scan}<b>拍摄条码</b><small>让条码完整、清晰地出现在画面中</small><input type="file" accept="image/*" capture="environment" data-barcode-photo></label>
    <form class="barcode-manual" data-barcode-form><label>也可以直接输入条码</label><div><input name="barcode" inputmode="numeric" pattern="[0-9]{8,14}" maxlength="14" placeholder="8–14 位数字"><button class="button secondary" type="submit">查询</button></div></form>
    <div class="barcode-feedback" data-barcode-feedback></div>`, "barcode-dialog");
  const feedback = dialog.querySelector("[data-barcode-feedback]");
  dialog.querySelector("[data-barcode-photo]").addEventListener("change", async (event) => {
    const file = event.target.files[0]; if (!file) return;
    feedback.innerHTML = '<p class="lookup-state">正在识别条码…</p>';
    try { await lookupBarcode(await detectBarcode(file), feedback, dialog); } catch (cause) { feedback.innerHTML = `<p class="lookup-state error">${esc(cause.message)}</p>`; }
  });
  dialog.querySelector("[data-barcode-form]").addEventListener("submit", (event) => { event.preventDefault(); lookupBarcode(new FormData(event.currentTarget).get("barcode"), feedback, dialog); });
}

function productFormFields(product = {}) {
  const field = (name, label, options = {}) => `<label class="${options.wide ? "span-two" : ""}">${label}${options.required ? "<span>*</span>" : ""}<input name="${name}" value="${esc(product[name] ?? options.value ?? "")}" ${options.type ? `type="${options.type}"` : ""} ${options.type === "number" ? 'min="0" step="0.01"' : ""} ${options.inputmode ? `inputmode="${options.inputmode}"` : ""} ${options.required ? "required" : ""} ${options.placeholder ? `placeholder="${options.placeholder}"` : ""}></label>`;
  return `<section class="form-section"><h3>基本信息</h3><div class="field-grid two">${field("name", "商品名称", { required: true, wide: true, placeholder: "例如：农夫山泉" })}${field("brand", "品牌")}${field("specification", "规格", { placeholder: "如 500ml / 24 瓶" })}${field("sku", "SKU")}${field("barcode", "条码", { inputmode: "numeric" })}${field("category", "分类")}${field("unit", "单位", { value: "件" })}</div></section>
    <section class="form-section"><h3>库存与价格</h3><div class="field-grid two">${field("stock", "当前库存", { type: "number", inputmode: "decimal", value: 0 })}${field("low_stock", "预警库存", { type: "number", inputmode: "decimal", value: 5 })}${field("cost", "进价（元）", { type: "number", inputmode: "decimal", value: 0 })}${field("price", "售价（元）", { type: "number", inputmode: "decimal", value: 0 })}</div></section>
    <section class="form-section"><h3>供货与存放</h3><div class="field-grid two">${field("supplier", "供应商")}${field("supplier_contact", "联系方式", { inputmode: "tel" })}${field("location", "货位")}${field("expiry_date", "到期日期", { type: "date" })}<label class="span-two">备注<textarea name="notes" rows="3">${esc(product.notes || "")}</textarea></label></div></section><input type="hidden" name="image_key" value="${esc(product.image_key || "")}">`;
}

async function compressImage(file) {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    if (file.size <= 1536 * 1024) return file;
    throw new Error("当前图片格式无法压缩，请改用 JPG、PNG 或 WebP");
  }
  const limit = 1600;
  const scale = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d", { alpha: false }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", .82));
  if (!blob) throw new Error("图片压缩失败");
  if (blob.size > 1536 * 1024) throw new Error("图片压缩后仍超过 1.5MB");
  return blob;
}

function aiIntake() {
  return `<section class="ai-intake" data-product-ai><div class="ai-intake-head"><span class="ai-label">AI 整理</span><h3>说出商品信息</h3><p>名称、进价、售价、库存、供应商等，想到什么就说什么。</p></div><div class="ai-intake-compose"><textarea rows="3" maxlength="3000" placeholder="输入文字，或点击语音按钮说出商品信息" data-ai-description></textarea><div class="ai-intake-actions"><button class="button secondary voice-button" type="button" data-voice-input>${icons.mic}<span>语音输入</span></button><button class="button primary" type="button" data-ai-organize>AI 整理信息</button></div></div><p class="ai-intake-status" data-ai-status>整理后请核对价格和库存。</p></section>`;
}

function bindAiIntake(dialog, form) {
  const intake = dialog.querySelector("[data-product-ai]"); if (!intake) return;
  const description = intake.querySelector("[data-ai-description]");
  const voiceButton = intake.querySelector("[data-voice-input]");
  const organizeButton = intake.querySelector("[data-ai-organize]");
  const status = intake.querySelector("[data-ai-status]");
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    const recognition = new SpeechRecognition(); recognition.lang = "zh-CN"; recognition.continuous = false; recognition.interimResults = false;
    recognition.onstart = () => { voiceButton.classList.add("is-listening"); voiceButton.querySelector("span").textContent = "正在听…"; status.textContent = "请说出商品名称、价格、库存和供应商等信息。"; };
    recognition.onresult = (event) => { const transcript = [...event.results].map((item) => item[0]?.transcript || "").join("").trim(); if (transcript) description.value = `${description.value.trim()} ${transcript}`.trim(); status.textContent = "已转成文字，点击“AI 整理信息”。"; };
    recognition.onerror = () => { status.textContent = "没有听清，请再试一次或直接输入文字。"; };
    recognition.onend = () => { voiceButton.classList.remove("is-listening"); voiceButton.querySelector("span").textContent = "语音输入"; };
    voiceButton.addEventListener("click", () => recognition.start());
  } else voiceButton.addEventListener("click", () => { status.textContent = "当前浏览器不支持语音转文字，请直接输入。"; description.focus(); });
  organizeButton.addEventListener("click", async () => {
    const content = description.value.trim(); if (!content) { status.textContent = "请先说出或输入商品信息。"; description.focus(); return; }
    organizeButton.disabled = true; organizeButton.textContent = "正在整理…"; status.textContent = "AI 正在提取商品资料。";
    try {
      const result = await api("/api/products/ai-draft", { method: "POST", body: { description: content } });
      let filled = 0;
      for (const [key, value] of Object.entries(result.draft || {})) { if (value === "" || value == null || !form.elements[key]) continue; form.elements[key].value = value; form.elements[key].classList.add("ai-filled"); setTimeout(() => form.elements[key]?.classList.remove("ai-filled"), 2200); filled += 1; }
      status.textContent = `已填写 ${filled} 项，请核对后保存。`;
    } catch (cause) { status.textContent = cause.message; }
    finally { organizeButton.disabled = false; organizeButton.textContent = "AI 整理信息"; }
  });
}

function openProductDialog(product = null, draft = null, options = {}) {
  const data = { ...(product || {}), ...(draft || {}) };
  const dialog = showDialog(`<header class="dialog-head"><div><p class="eyebrow">${product ? "商品档案" : "录入商品"}</p><h2>${product ? "编辑商品" : "新增商品"}</h2></div><button class="dialog-close" type="button" data-dialog-close>×</button></header>
    <form class="native-product-form" data-product-form><div class="native-product-editor"><section class="native-photo-panel"><div class="photo-preview" data-photo-preview>${data.image_key ? `<img src="/media/${encodeURIComponent(data.image_key)}" alt="商品照片">` : `<span class="photo-empty">${icons.camera}<b>商品照片</b><small>拍摄正面包装</small></span>`}</div><div class="photo-actions"><label class="button secondary upload-button">拍照<input type="file" accept="image/*" capture="environment" data-product-image></label><label class="button secondary upload-button">从图库选择<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" data-product-image></label></div><small class="field-note">上传前会自动压缩</small></section><div class="native-product-sections">${options.aiMode ? aiIntake() : ""}${productFormFields(data)}<p class="native-form-error" data-error hidden></p><div class="form-actions"><button class="button quiet" type="button" data-dialog-close>取消</button><button class="button primary" type="submit">${product ? "保存修改" : "保存商品"}</button></div></div></div></form>`, "native-product-dialog");
  const form = dialog.querySelector("[data-product-form]");
  bindAiIntake(dialog, form);
  dialog.querySelectorAll("[data-product-image]").forEach((input) => input.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try { const previewUrl = URL.createObjectURL(file); const preview = dialog.querySelector("[data-photo-preview]"); preview.innerHTML = `<img src="${previewUrl}" alt="待上传商品照片">`; const compressed = await compressImage(file); const upload = new FormData(); upload.append("image", compressed, "product.webp"); const uploaded = await api("/api/uploads", { method: "POST", body: upload }); form.elements.image_key.value = uploaded.image_key; toast("图片已上传"); } catch (cause) { toast(cause.message, "error"); }
  }));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = "正在保存…";
    try {
      const saved = await api(product ? `/api/products/${product.id}` : "/api/products", { method: product ? "PUT" : "POST", body });
      dialog.close(); toast(product ? "商品已更新" : "商品已录入"); await navigate(`/products/${saved.product.id}`);
    } catch (cause) { const box = form.querySelector("[data-error]"); box.textContent = cause.message; box.hidden = false; button.disabled = false; button.textContent = product ? "保存修改" : "确认录入"; }
  });
}

function openStockDialog(product) {
  const dialog = showDialog(`<header class="dialog-head"><div><p class="eyebrow">库存流水</p><h2>调整库存</h2></div><button class="dialog-close" data-dialog-close>×</button></header><div class="stock-current"><span>当前库存</span><strong>${quantity(product.stock)} ${esc(product.unit)}</strong></div><form class="form-stack" data-stock-form><label>操作<select name="operation"><option value="in">入库增加</option><option value="out">出库减少</option><option value="set">盘点后设为</option></select></label><label>数量<input name="quantity" type="number" min="0" step="0.01" inputmode="decimal" required></label><label>原因<input name="reason" maxlength="200" placeholder="例如：供应商到货、盘点修正" required></label><button class="button primary full" type="submit">确认调整</button></form>`, "stock-dialog");
  dialog.querySelector("[data-stock-form]").addEventListener("submit", async (event) => {
    event.preventDefault();
    try { await api(`/api/products/${product.id}/stock`, { method: "POST", body: Object.fromEntries(new FormData(event.currentTarget)) }); dialog.close(); toast("库存已调整"); await renderProductDetail(product.id); } catch (cause) { toast(cause.message, "error"); }
  });
}

async function renderSales() {
  const viewKey = locationKey();
  shell(loading("读取销售数据"), "销售");
  const [data, products] = await Promise.all([apiCached("/api/sales", 15000), apiCached("/api/products?status=active&page_size=200", 30000)]);
  if (viewKey !== locationKey()) return;
  const stats = data.stats;
  shell(`<header class="page-head split"><div><p class="eyebrow">门店经营</p><h1>销售</h1><p class="head-note">手动记账或等待收银系统接入</p></div><button class="button primary" type="button" data-record-sale>${icons.plus}<span>记一笔</span></button></header>
    <section class="native-sales-kpis"><article><span>今日销售额</span><b>${money(stats.revenue)}</b></article><article><span>今日毛利</span><b>${money(stats.profit)}</b></article><article><span>销售数量</span><b>${quantity(stats.quantity)}</b></article><article><span>销售笔数</span><b>${stats.orders || 0}</b></article></section>
    <div class="native-detail-grid"><section class="ops-panel"><header class="ops-panel-head"><div><p class="eyebrow">热销商品</p><h2>销售排行</h2></div></header>${data.top_products.length ? `<div class="movement-list">${data.top_products.map((item) => `<div><span><b>${esc(item.product_name)}</b><small>${quantity(item.quantity)} 件</small></span><strong>${money(item.revenue)}</strong></div>`).join("")}</div>` : '<div class="compact-empty"><b>暂无销售数据</b></div>'}</section>
    <section class="ops-panel"><header class="ops-panel-head"><div><p class="eyebrow">实时流水</p><h2>最近销售</h2></div></header>${data.recent_sales.length ? `<div class="movement-list">${data.recent_sales.map((item) => `<div><span><b>${esc(item.product_name)}</b><small>${dateTime(item.created_at)}</small></span><strong>${money(item.revenue)}</strong></div>`).join("")}</div>` : '<div class="compact-empty"><b>暂无销售流水</b></div>'}</section></div>`, "销售");
  root.querySelector("[data-record-sale]").addEventListener("click", () => openSaleDialog(products.products));
}

function openSaleDialog(products) {
  const dialog = showDialog(`<header class="dialog-head"><div><p class="eyebrow">销售流水</p><h2>手动记一笔</h2></div><button class="dialog-close" data-dialog-close>×</button></header><form class="form-stack" data-sale-form><label>商品<select name="product_id" required><option value="">选择商品</option>${products.map((product) => `<option value="${product.id}" data-price="${product.price}">${esc(product.name)} · 库存 ${quantity(product.stock)}</option>`).join("")}</select></label><label>数量<input name="quantity" type="number" min="0.01" step="0.01" inputmode="decimal" required></label><label>成交单价<input name="unit_price" type="number" min="0" step="0.01" inputmode="decimal"></label><button class="button primary full" type="submit">确认记账</button></form>`, "native-sale-dialog");
  const form = dialog.querySelector("[data-sale-form]");
  form.elements.product_id.addEventListener("change", () => { form.elements.unit_price.value = form.elements.product_id.selectedOptions[0]?.dataset.price || ""; });
  form.addEventListener("submit", async (event) => { event.preventDefault(); try { await api("/api/sales", { method: "POST", body: Object.fromEntries(new FormData(form)) }); dialog.close(); toast("销售已记账"); await renderSales(); } catch (cause) { toast(cause.message, "error"); } });
}

async function renderAssistant() {
  const viewKey = locationKey();
  shell(loading("唤醒经营管家"), "BHS AI");
  const { messages } = await api("/api/assistant");
  if (viewKey !== locationKey()) return;
  shell(`<section class="chat-shell butler-shell native-butler" data-chat><header class="chat-head butler-head"><div class="butler-identity"><span class="ai-spark">B</span><div><p class="eyebrow">经营管家</p><h1>BHS AI</h1></div></div><span class="live-indicator"><i></i>在线</span></header><div class="butler-capabilities"><span>数据分析</span><span>库存管理</span><span>商品操作</span><span>报表建议</span></div>
    <div class="chat-messages" data-messages>${messages.length ? messages.map((message) => messageBubble(message) + (message.role === "assistant" ? assistantOutputs(message.outputs) : "")).join("") : `<div class="chat-empty" data-chat-empty><span class="ai-core"><i></i>B</span><b>经营上的事，交给我</b><p>查询数据，或用自然语言下达录入、入库和调价任务。</p><div class="prompt-chips"><button type="button" data-prompt="分析当前经营数据，告诉我最需要处理的三件事。">生成经营简报</button><button type="button" data-prompt="检查所有库存，给出补货优先级。">检查补货</button><button type="button" data-prompt="分析商品的成本、售价和毛利空间。">分析毛利</button></div></div>`}</div>
    <form class="chat-form butler-form" data-chat-form><label class="sr-only" for="chatInput">给 BHS AI 下达任务</label><textarea id="chatInput" name="message" rows="1" maxlength="4000" placeholder="查询、分析或直接下达任务…" required></textarea><button class="send-button" type="submit" aria-label="发送">${icons.arrow}</button></form></section>`, "BHS AI");
  const form = root.querySelector("[data-chat-form]");
  root.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => { form.elements.message.value = button.dataset.prompt; form.requestSubmit(); }));
  form.addEventListener("submit", submitAssistant);
  const input = form.elements.message;
  input.addEventListener("focus", () => document.body.classList.add("input-focused"));
  input.addEventListener("blur", () => document.body.classList.remove("input-focused"));
  scrollMessages();
}

function messageBubble(message) {
  return `<article class="message ${message.role}"><div class="message-meta"><span>${message.role === "assistant" ? "BHS AI" : esc(state.user.display_name)}</span><span>${message.channel === "WECHAT" ? "微信" : "网页"}</span></div><div class="message-body">${esc(message.content).replace(/\n/g, "<br>")}</div></article>`;
}

function assistantOutputs(outputs = []) {
  const cards = outputs.map((output) => {
    if (output.type === "dashboard") {
      const data = output.metrics || {};
      return `<section class="assistant-data-card"><header><b>${esc(output.title || "经营总览")}</b></header><div class="assistant-metrics"><span><small>今日销售</small><b>${money(data.today_revenue)}</b></span><span><small>今日毛利</small><b>${money(data.today_profit)}</b></span><span><small>库存商品</small><b>${quantity(data.products)}</b></span><span><small>低库存</small><b>${quantity(data.low_count)}</b></span></div></section>`;
    }
    if (output.type === "product" || output.type === "products") {
      const items = output.type === "product" ? [output.item].filter(Boolean) : (output.items || []);
      return `<section class="assistant-data-card"><header><b>${esc(output.title || "商品")}</b>${output.total != null ? `<small>${quantity(output.total)} 个</small>` : ""}</header><div class="assistant-product-results">${items.map((item) => `<a href="/products/${item.id}" data-link><span class="assistant-product-photo">${item.image_url?.startsWith("/media/") ? `<img src="${esc(item.image_url)}" alt="" loading="lazy">` : esc((item.name || "商").slice(0, 1))}</span><span><b>${esc(item.name)}</b><small>库存 ${quantity(item.stock)} ${esc(item.unit || "件")} · 售价 ${money(item.price)}</small></span><span>›</span></a>`).join("") || "<p>没有匹配结果</p>"}</div></section>`;
    }
    if (output.type === "sales") {
      const summary = output.summary || {};
      return `<section class="assistant-data-card"><header><b>${esc(output.title || "销售")}</b></header><div class="assistant-metrics compact"><span><small>销售额</small><b>${money(summary.revenue)}</b></span><span><small>毛利</small><b>${money(summary.profit)}</b></span><span><small>笔数</small><b>${quantity(summary.orders)}</b></span></div><div class="assistant-line-results">${(output.items || []).map((item) => `<p><b>${esc(item.product_name)}</b><span>${quantity(item.quantity)} × ${money(item.unit_price)}</span></p>`).join("")}</div></section>`;
    }
    if (output.type === "movements") return `<section class="assistant-data-card"><header><b>${esc(output.title || "库存流水")}</b></header><div class="assistant-line-results">${(output.items || []).map((item) => `<p><b>${esc(item.product_name)}</b><span>${Number(item.change_amount) > 0 ? "+" : ""}${quantity(item.change_amount)} · ${esc(item.reason)}</span></p>`).join("")}</div></section>`;
    if (output.type === "sale" || output.type === "sale_void") {
      const item = output.item || {};
      return `<section class="assistant-data-card"><header><b>${esc(output.title || "销售记录")}</b></header><div class="assistant-result-main"><b>${esc(item.product_name || "销售")}</b><span>${item.revenue != null ? `${quantity(item.quantity)} × ${money(item.unit_price)} · ${money(item.revenue)}` : `记录 #${quantity(item.sale_id)} 已撤销`}</span></div></section>`;
    }
    if (output.type === "users" || output.type === "user") {
      const items = output.type === "user" ? [output.item].filter(Boolean) : (output.items || []);
      return `<section class="assistant-data-card"><header><b>${esc(output.title || "内部成员")}</b></header><div class="assistant-line-results">${items.map((item) => `<p><b>${esc(item.display_name)}</b><span>${esc(item.username)} · ${roleName(item.role)} · ${item.active ? "启用" : "停用"}</span></p>`).join("")}</div></section>`;
    }
    return "";
  }).filter(Boolean);
  return cards.length ? `<div class="assistant-results">${cards.join("")}</div>` : "";
}

function scrollMessages() {
  const box = root.querySelector("[data-messages]");
  if (box) box.scrollTop = box.scrollHeight;
}

async function submitAssistant(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = form.elements.message.value.trim();
  if (!message) return;
  const box = root.querySelector("[data-messages]");
  box.querySelector("[data-chat-empty]")?.remove();
  box.insertAdjacentHTML("beforeend", messageBubble({ role: "user", content: message, channel: "WEB" }) + '<article class="message assistant native-thinking"><div class="message-body"><span></span><span></span><span></span></div></article>');
  form.elements.message.value = "";
  form.querySelector("button").disabled = true;
  scrollMessages();
  try {
    const result = await api("/api/assistant", { method: "POST", body: { message } });
    box.querySelector(".native-thinking")?.remove();
    box.insertAdjacentHTML("beforeend", messageBubble({ role: "assistant", content: result.reply, channel: "WEB" }) + assistantOutputs(result.outputs));
    if (result.actions?.length) box.insertAdjacentHTML("beforeend", actionProposal(result.actions));
  } catch (cause) {
    box.querySelector(".native-thinking")?.remove();
    box.insertAdjacentHTML("beforeend", `<article class="message assistant"><div class="message-body">${esc(cause.message)}</div></article>`);
  } finally {
    form.querySelector("button").disabled = false;
    bindActionProposal();
    scrollMessages();
  }
}

function actionProposal(actions) {
  return `<article class="native-ai-actions" data-ai-actions data-actions="${esc(JSON.stringify(actions))}"><header><span>待确认操作</span><b>${actions.length} 项</b></header><ul>${actions.map((action) => `<li>${esc(action.summary || ({ create_product: "新增商品", adjust_stock: "调整库存", update_product: "修改商品", archive_product: "停用商品", restore_product: "恢复商品", purge_product: "永久删除商品", record_sale: "记录销售", void_sale: "撤销销售", create_user: "添加成员", update_user: "修改成员" })[action.type])}</li>`).join("")}</ul><div><button class="button secondary" type="button" data-ai-cancel>取消</button><button class="button primary" type="button" data-ai-confirm>确认执行</button></div></article>`;
}

function bindActionProposal() {
  root.querySelectorAll("[data-ai-actions]").forEach((panel) => {
    if (panel.dataset.bound) return;
    panel.dataset.bound = "1";
    panel.querySelector("[data-ai-cancel]").addEventListener("click", () => panel.remove());
    panel.querySelector("[data-ai-confirm]").addEventListener("click", async () => {
      const button = panel.querySelector("[data-ai-confirm]"); button.disabled = true; button.textContent = "执行中…";
      try {
        const actions = JSON.parse(panel.dataset.actions);
        const result = await api("/api/assistant/execute", { method: "POST", body: { actions } });
        const success = result.results.filter((item) => item.ok).length;
        panel.innerHTML = `<p>已执行 ${success}/${result.results.length} 项操作。所有变更已写入审计记录。</p>${assistantOutputs(result.outputs)}`;
        toast("AI 操作执行完成");
      } catch (cause) { toast(cause.message, "error"); button.disabled = false; button.textContent = "确认执行"; }
    });
  });
}

async function renderData() {
  const viewKey = locationKey();
  shell(loading("读取数据"), "数据");
  const summary = await api("/api/data/summary");
  if (viewKey !== locationKey()) return;
  shell(`<header class="page-head compact-head"><p class="eyebrow">管理</p><h1>数据</h1></header><div class="data-list">
    <section class="data-row"><span class="data-icon">${icons.download}</span><div class="grow"><h2>商品数据</h2><p>${summary.product_count} 条记录</p></div><button class="button secondary" type="button" data-export="/api/data/products.csv" data-filename="BHS-products.csv">导出 CSV</button></section>
    <section class="data-row"><span class="data-icon">${icons.sales}</span><div class="grow"><h2>销售数据</h2><p>${summary.sales_count} 条记录</p></div><button class="button secondary" type="button" data-export="/api/data/sales.csv" data-filename="BHS-sales.csv">导出 CSV</button></section>
    <section class="data-row"><span class="data-icon">↔</span><div class="grow"><h2>库存流水</h2><p>${summary.movement_count} 条记录</p></div><button class="button secondary" type="button" data-export="/api/data/inventory.csv" data-filename="BHS-inventory.csv">导出 CSV</button></section>
    <section class="data-row"><span class="data-icon">↑</span><div class="grow"><h2>导入商品</h2><p>支持 BHS CSV 和常见表格字段</p></div><label class="button secondary native-file-button">选择 CSV<input type="file" accept=".csv,text/csv" data-import></label></section>
    <section class="data-row"><span class="data-icon">↻</span><div class="grow"><h2>外部同步</h2><p>收银系统或数据接口</p></div><span class="status pending">未配置</span></section>
  </div>`, "数据");
  root.querySelectorAll("[data-export]").forEach((button) => button.addEventListener("click", async () => {
    const response = await api(button.dataset.export, { raw: true });
    if (!response.ok) return toast("导出失败", "error");
    const blob = await response.blob(); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = button.dataset.filename; link.click(); URL.revokeObjectURL(link.href);
  }));
  root.querySelector("[data-import]").addEventListener("change", importCsv);
}

function parseCsv(content) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function importCsv(event) {
  const file = event.target.files[0]; if (!file) return;
  const table = parseCsv((await file.text()).replace(/^\ufeff/, ""));
  if (table.length < 2) return toast("CSV 没有可导入的数据", "error");
  const aliases = { "条码": "barcode", "barcode": "barcode", "SKU": "sku", "商品名称": "name", "名称": "name", "name": "name", "品牌": "brand", "规格": "specification", "分类": "category", "单位": "unit", "当前库存": "stock", "库存": "stock", "预警库存": "low_stock", "进价": "cost", "售价": "price", "供应商": "supplier", "联系方式": "supplier_contact", "货位": "location", "到期日期": "expiry_date", "备注": "notes" };
  const headers = table[0].map((item) => aliases[item.trim()] || "");
  const rows = table.slice(1).filter((row) => row.some(Boolean)).map((row) => Object.fromEntries(headers.map((key, index) => key ? [key, row[index] || ""] : null).filter(Boolean)));
  if (!rows.some((row) => row.name)) return toast("CSV 缺少商品名称列", "error");
  try { const result = await api("/api/data/import", { method: "POST", body: { rows } }); toast(`导入完成：新增 ${result.created}，更新 ${result.updated}，失败 ${result.failed}`); } catch (cause) { toast(cause.message, "error"); }
  event.target.value = "";
}

async function renderUsers() {
  const viewKey = locationKey();
  shell(loading("读取成员"), "成员");
  const { users } = await api("/api/users");
  if (viewKey !== locationKey()) return;
  shell(`<header class="page-head split"><div><p class="eyebrow">${users.length} 位成员</p><h1>成员</h1></div><button class="button primary" type="button" data-new-user>${icons.plus}<span>添加成员</span></button></header><div class="native-user-list">${users.map((user) => { const canToggle = user.role !== "boss" && user.id !== state.user.id && (state.user.role === "boss" || user.role === "employee"); return `<article><span class="user-avatar">${esc(user.display_name.slice(0, 1))}</span><div><b>${esc(user.display_name)}</b><small>${esc(user.username)} · ${roleName(user.role)}</small></div><span class="status ${user.active ? "active" : "pending"}">${user.active ? "启用" : "停用"}</span>${canToggle ? `<button type="button" data-toggle-user="${user.id}" data-active="${user.active ? "1" : "0"}">${user.active ? "停用" : "启用"}</button>` : ""}</article>`; }).join("")}</div>`, "成员");
  root.querySelector("[data-new-user]")?.addEventListener("click", openUserDialog);
  root.querySelectorAll("[data-toggle-user]").forEach((button) => button.addEventListener("click", async () => { try { await api(`/api/users/${button.dataset.toggleUser}`, { method: "PATCH", body: { active: button.dataset.active !== "1" } }); toast("成员状态已更新"); await renderUsers(); } catch (cause) { toast(cause.message, "error"); } }));
}

function openUserDialog() {
  const dialog = showDialog(`<header class="dialog-head"><div><p class="eyebrow">内部权限</p><h2>添加成员</h2></div><button class="dialog-close" data-dialog-close>×</button></header><form class="form-stack" data-user-form><label>账号<input name="username" required></label><label>姓名<input name="display_name"></label><label>初始密码<input name="password" type="password" minlength="8" required></label><label>角色<select name="role"><option value="employee">员工</option>${state.user.role === "boss" ? '<option value="admin">管理员</option>' : ""}</select></label><button class="button primary full" type="submit">创建成员</button></form>`);
  dialog.querySelector("[data-user-form]").addEventListener("submit", async (event) => { event.preventDefault(); try { await api("/api/users", { method: "POST", body: Object.fromEntries(new FormData(event.currentTarget)) }); dialog.close(); toast("成员已添加"); await renderUsers(); } catch (cause) { toast(cause.message, "error"); } });
}

async function renderIntegrations() {
  const viewKey = locationKey();
  shell(loading("读取连接状态"), "连接");
  const data = await api("/api/integrations");
  if (viewKey !== locationKey()) return;
  shell(`<header class="page-head compact-head"><h1>连接</h1><p class="lead">查看微信对话是否可用。</p></header><section class="connection-card"><div class="connection-icon" aria-hidden="true">${icons.assistant}</div><div class="grow"><h2>微信对话</h2><p>与网页共用商品资料和消息记录</p></div><span class="connection-status ${data.wechat.connected ? "is-online" : "is-offline"}"><i></i>${data.wechat.connected ? "已连接" : "未连接"}</span></section>`, "连接");
}

async function renderNotFound() {
  shell('<section class="product-empty"><h2>页面不存在</h2><p>返回经营总览继续使用。</p><a class="button primary" href="/" data-link>返回总览</a></section>', "页面不存在");
}

async function renderRoute() {
  state.route = location.pathname;
  state.productQuery = new URLSearchParams(location.search);
  document.body.className = state.route === "/assistant" ? "assistant-page" : "";
  if (!state.user) return renderLogin();
  if (state.route === "/login") return navigate("/", { replace: true });
  try {
    if (state.route === "/") return await renderDashboard();
    if (state.route === "/products") return await renderProducts();
    const productMatch = state.route.match(/^\/products\/(\d+)$/);
    if (productMatch) return await renderProductDetail(Number(productMatch[1]));
    if (state.route === "/sales") return await renderSales();
    if (state.route === "/assistant") return await renderAssistant();
    if (state.route === "/data" && isManager()) return await renderData();
    if (state.route === "/users" && isManager()) return await renderUsers();
    if (state.route === "/integrations" && isManager()) return await renderIntegrations();
    return await renderNotFound();
  } catch (cause) {
    shell(`<section class="native-error-state"><b>页面加载失败</b><p>${esc(cause.message)}</p><button class="button secondary" type="button" data-retry>重新加载</button></section>`, "加载失败");
    root.querySelector("[data-retry]")?.addEventListener("click", renderRoute);
  }
}

async function navigate(path, options = {}) {
  if (!options.replace && path === locationKey()) {
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  if (options.replace) history.replaceState({}, "", path); else history.pushState({}, "", path);
  await renderRoute();
}

function prefetchLink(link) {
  if (!state.user || link.origin !== location.origin) return;
  if (/^\/products\/\d+$/.test(link.pathname)) apiCached(`/api${link.pathname}`, 30000).catch(() => {});
  else if (link.pathname === "/products") apiCached(`/api/products?${new URL(link.href).searchParams.toString()}`, 30000).catch(() => {});
  else if (link.pathname === "/sales") Promise.all([apiCached("/api/sales", 15000), apiCached("/api/products?status=active&page_size=200", 30000)]).catch(() => {});
  else if (link.pathname === "/") apiCached("/api/dashboard", 5000).catch(() => {});
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-link]");
  if (event.defaultPrevented || !link || link.origin !== location.origin || event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  navigate(`${link.pathname}${link.search}${link.hash}`);
});
document.addEventListener("pointerdown", (event) => {
  const link = event.target.closest("a[data-link]");
  if (link) prefetchLink(link);
}, { passive: true });
window.addEventListener("popstate", renderRoute);

async function boot() {
  try {
    const session = await api("/api/session");
    state.user = session.user;
  } catch {
    state.user = null;
  }
  await renderRoute();
}

boot();
