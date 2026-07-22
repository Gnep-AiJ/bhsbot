const base = process.env.BHS_URL || "https://bhsbot.pages.dev";
const username = process.env.BOSS_USERNAME || "Dongli";
const password = process.env.BOSS_INITIAL_PASSWORD;
const token = process.env.BHS_CHANNEL_TOKEN;
if (!password || !token) throw new Error("BOSS_INITIAL_PASSWORD and BHS_CHANNEL_TOKEN are required");

const unauthorized = await fetch(`${base}/api/channel/heartbeat`, { method: "POST" });
if (unauthorized.status !== 401) throw new Error(`heartbeat auth failed: ${unauthorized.status}`);

const channelHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
const heartbeat = await fetch(`${base}/api/channel/heartbeat`, { method: "POST", headers: channelHeaders, body: "{}" });
if (!heartbeat.ok) throw new Error(`heartbeat failed: ${heartbeat.status}`);

const externalId = `channel-upgrade-smoke-${Date.now()}`;
const body = JSON.stringify({ message: "只回复：微信桥接升级正常。不要提出任何操作。", sender: "桥接回归", external_id: externalId });
const first = await fetch(`${base}/api/channel/message`, { method: "POST", headers: channelHeaders, body });
const firstData = await first.json();
if (!first.ok || !firstData.reply || !Array.isArray(firstData.actions)) throw new Error(`channel message failed: ${first.status}`);
const repeated = await fetch(`${base}/api/channel/message`, { method: "POST", headers: channelHeaders, body });
const repeatedData = await repeated.json();
if (!repeated.ok || JSON.stringify(repeatedData) !== JSON.stringify(firstData)) throw new Error("channel receipt is not idempotent");

let cookie = "";
const login = await fetch(`${base}/api/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: base },
  body: JSON.stringify({ username, password }),
});
if (!login.ok) throw new Error(`login failed: ${login.status}`);
cookie = login.headers.get("set-cookie")?.split(";")[0] || "";
const integrations = await fetch(`${base}/api/integrations`, { headers: { Cookie: cookie } });
const integrationData = await integrations.json();
if (!integrations.ok || !integrationData.wechat?.connected) throw new Error("fresh heartbeat did not mark WeChat connected");

console.log("PASS  authenticated heartbeat, AI channel, idempotent receipt and live connection status");
