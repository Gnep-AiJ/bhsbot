const base = process.env.BHS_URL || "https://bhsbot.pages.dev";
const username = process.env.BOSS_USERNAME || "Dongli";
const token = process.env.BHS_CHANNEL_TOKEN;
const password = process.env.BOSS_INITIAL_PASSWORD;
if (!token || !password) throw new Error("BHS_CHANNEL_TOKEN and BOSS_INITIAL_PASSWORD are required");

const marker = `BHS_HISTORY_SMOKE_${Date.now()}`;
const channel = await fetch(`${base}/api/channel/message`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ message: `${marker}：查询当前商品并返回前 1 个商品卡片，只查询。`, sender: "HISTORY_SMOKE", external_id: `history-smoke-${marker}` }),
});
const channelData = await channel.json();
if (!channel.ok || !channelData.outputs?.length) throw new Error(`channel query failed: ${channel.status}`);

const login = await fetch(`${base}/api/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: base },
  body: JSON.stringify({ username, password }),
});
if (!login.ok) throw new Error(`login failed: ${login.status}`);
const cookie = login.headers.get("set-cookie")?.split(";")[0] || "";
const history = await fetch(`${base}/api/assistant`, { headers: { Cookie: cookie } });
const historyData = await history.json();
const index = historyData.messages?.findIndex((item) => item.role === "user" && item.content.includes(marker)) ?? -1;
const assistant = index >= 0 ? historyData.messages[index + 1] : null;
if (!history.ok || !assistant?.outputs?.length) throw new Error("structured outputs were not restored from history");

console.log(`PASS  structured history restored marker=${marker}`);
