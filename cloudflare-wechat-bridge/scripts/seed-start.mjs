import fs from "node:fs";
import https from "node:https";

function loadEnvFile(path) {
  if (!path || !fs.existsSync(path)) return;
  for (const rawLine of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (process.env[key]) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(process.env.ENV_FILE);

function requestJson(url, options = {}, attempts = 3) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { ...options, timeout: 20_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        let data = {};
        try { data = body ? JSON.parse(body) : {}; } catch { data = { raw: body }; }
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, data });
      });
    });
    request.on("timeout", () => request.destroy(new Error("request_timeout")));
    request.on("error", async (error) => {
      if (attempts <= 1) return reject(error);
      await new Promise((done) => setTimeout(done, 1_200));
      try { resolve(await requestJson(url, options, attempts - 1)); } catch (retryError) { reject(retryError); }
    });
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function main() {
  const base = process.env.BRIDGE_URL;
  const token = process.env.BHS_CHANNEL_TOKEN;
  const syncFile = process.env.WEIXIN_SYNC_FILE;
  if (!base || !token || !syncFile) throw new Error("BRIDGE_URL, BHS_CHANNEL_TOKEN and WEIXIN_SYNC_FILE are required");

  const cursor = JSON.parse(fs.readFileSync(syncFile, "utf8")).get_updates_buf;
  if (!cursor) throw new Error("Existing WeChat sync cursor is missing");
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const seed = await requestJson(`${base}/seed`, { method: "POST", headers, body: JSON.stringify({ cursor }) });
  if (!seed.ok || !seed.data.ok) throw new Error(`Failed to seed bridge cursor: ${seed.status}`);

  const start = await requestJson(`${base}/start`, { method: "POST", headers, body: "{}" });
  if (!start.ok || !start.data.running) throw new Error(`Failed to start bridge: ${start.status}`);

  await new Promise((resolve) => setTimeout(resolve, 2500));
  const status = await requestJson(`${base}/status`, { headers });
  if (!status.ok || !status.data.running) throw new Error(`Bridge status failed: ${status.status}`);
  console.log(`PASS  cursor seeded and bridge started ${JSON.stringify(status.data)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
