import fs from "node:fs";
import https from "node:https";

function loadEnv(path) {
  for (const raw of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (process.env[key]) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { ...options, timeout: 65_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        let data = {};
        try { data = body ? JSON.parse(body) : {}; } catch { data = {}; }
        resolve({ status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300, headers: response.headers, data });
      });
    });
    request.on("timeout", () => request.destroy(new Error(`request_timeout:${new URL(url).hostname}`)));
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function main() {
  loadEnv(process.env.ENV_FILE || ".env");
  const bridge = process.env.BRIDGE_URL || "https://bhs-wechat-bridge.w1nter.workers.dev";
  const bhs = process.env.BHS_URL || "https://bhsbot.pages.dev";
  const token = process.env.BHS_CHANNEL_TOKEN;
  const username = process.env.BOSS_USERNAME || "Dongli";
  const password = process.env.BOSS_INITIAL_PASSWORD;
  if (!token || !password) throw new Error("BHS_CHANNEL_TOKEN and BOSS_INITIAL_PASSWORD are required");

  const status = await requestJson(`${bridge}/status`, { headers: { Authorization: `Bearer ${token}` } });
  if (!status.ok || !status.data.running || status.data.last_error) throw new Error(`bridge unhealthy: ${status.status} ${status.data.last_error || "not_running"}`);
  const pollAge = Date.now() - Date.parse(status.data.last_poll_at || 0);
  if (!Number.isFinite(pollAge) || pollAge > 120_000) throw new Error(`bridge poll is stale: ${status.data.last_poll_at || "never"}`);

  const login = await requestJson(`${bhs}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: bhs },
    body: JSON.stringify({ username, password }),
  });
  if (!login.ok) throw new Error(`BHS login failed: ${login.status}`);
  const cookie = String(login.headers["set-cookie"] || "").split(";")[0];
  const integrations = await requestJson(`${bhs}/api/integrations`, { headers: { Cookie: cookie } });
  if (!integrations.ok || !integrations.data.wechat || !integrations.data.wechat.connected) throw new Error("BHS does not report WeChat connected");

  console.log(JSON.stringify({
    ok: true,
    bridge: {
      running: status.data.running,
      last_poll_at: status.data.last_poll_at,
      last_heartbeat_at: status.data.last_heartbeat_at,
      queued: status.data.queued,
      processed_messages: status.data.processed_messages,
      pending_action: Boolean(status.data.pending_action),
      pending_media: Boolean(status.data.pending_media),
    },
    bhs_wechat_connected: true,
  }));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
