const base = process.env.BHS_URL || "https://bhsbot.pages.dev";
const username = process.env.BOSS_USERNAME || "Dongli";
const password = process.env.BOSS_INITIAL_PASSWORD;
if (!password) throw new Error("BOSS_INITIAL_PASSWORD is required");

const login = await fetch(`${base}/api/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: base },
  body: JSON.stringify({ username, password }),
});
if (!login.ok) throw new Error(`login failed: ${login.status}`);
const cookie = login.headers.get("set-cookie").split(";")[0];
const response = await fetch(`${base}/api/assistant`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie },
  body: JSON.stringify({ message: "当前在售商品有多少种？只回答数量，不要执行操作。" }),
});
const result = await response.json();
if (!response.ok) throw new Error(`${response.status}: ${result.error || "AI failed"}`);
if (!result.reply || !Array.isArray(result.actions) || result.actions.length) throw new Error("AI response contract failed");
if (!result.reply.includes("50")) throw new Error(`AI count mismatch: ${result.reply}`);
console.log(`PASS  DeepSeek response (${result.reply.length} chars, 0 actions)`);
