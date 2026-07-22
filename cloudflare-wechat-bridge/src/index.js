import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const TEXT = 1;
const IMAGE = 2;
const VOICE = 3;
const FILE = 4;
const VIDEO = 5;
const USER_MESSAGE = 1;
const BOT_MESSAGE = 2;
const FINISHED = 2;
const POLL_TIMEOUT_MS = 40_000;
const POLL_RESTART_DELAY_MS = 4_000;
const MAX_QUEUE_BATCH = 5;
const MAX_RECENT_IDS = 240;
const MAX_IMAGE_BYTES = 1536 * 1024;
const PENDING_ACTION_TTL_MS = 30 * 60 * 1000;
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function secureEqual(left, right) {
  const a = new TextEncoder().encode(String(left || ""));
  const b = new TextEncoder().encode(String(right || ""));
  if (!a.length || a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

function authorized(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const bearer = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  return secureEqual(bearer, env.BRIDGE_ADMIN_TOKEN);
}

function randomWechatUin() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const value = new DataView(bytes.buffer).getUint32(0, false);
  return btoa(String(value));
}

function endpoint(baseUrl, path) {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function normalizeCommand(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s，。！!？?、.]/g, "");
}

export function isConfirmation(value) {
  return ["确认", "确定", "执行", "确认执行", "是", "yes", "y"].includes(normalizeCommand(value));
}

export function isCancellation(value) {
  return ["取消", "放弃", "不要", "不执行", "no", "n"].includes(normalizeCommand(value));
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function imageMime(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "";
}

function safeTencentUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("wechat_cdn_protocol_invalid");
  const host = url.hostname.toLowerCase();
  if (!(host === "weixin.qq.com" || host.endsWith(".weixin.qq.com") || host === "qq.com" || host.endsWith(".qq.com"))) throw new Error("wechat_cdn_host_invalid");
  return url.toString();
}

function parseAesKey(media, imageAesKey = "") {
  if (imageAesKey && /^[0-9a-f]{32}$/i.test(imageAesKey)) return Buffer.from(imageAesKey, "hex");
  if (!media?.aes_key) return null;
  const decoded = Buffer.from(media.aes_key, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString("ascii"))) return Buffer.from(decoded.toString("ascii"), "hex");
  throw new Error("wechat_image_key_invalid");
}

export function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv("aes-128-ecb", key, Buffer.alloc(0));
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptAesEcb(plaintext, key) {
  const cipher = createCipheriv("aes-128-ecb", key, Buffer.alloc(0));
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function extractInbound(message) {
  let text = "";
  let kind = "unknown";
  let image = null;
  for (const item of message?.item_list || []) {
    if (item?.type === IMAGE && item.image_item) {
      image ||= item.image_item;
      kind = "image";
    } else if (item?.type === TEXT && item.text_item?.text != null && !text) {
      text = String(item.text_item.text).trim();
      if (kind === "unknown") kind = "text";
    } else if (item?.type === VOICE && item.voice_item?.text && !text) {
      text = String(item.voice_item.text).trim();
      if (kind === "unknown") kind = "voice";
    } else if (item?.type === FILE && kind === "unknown") kind = "file";
    else if (item?.type === VIDEO && kind === "unknown") kind = "video";
  }
  return {
    id: String(message?.message_id || message?.client_id || `${message?.from_user_id || "unknown"}:${message?.create_time_ms || Date.now()}`),
    sender: String(message?.from_user_id || ""),
    contextToken: String(message?.context_token || ""),
    text,
    kind,
    image,
    createdAt: Number(message?.create_time_ms || Date.now()),
    attempts: 0,
  };
}

export function formatActionProposal(reply, actions) {
  const summaries = actions.map((action) => action?.summary).filter(Boolean).slice(0, 6);
  const list = summaries.length ? `\n\n待执行：\n${summaries.map((item) => `• ${item}`).join("\n")}` : "";
  return `${reply || "已整理为待确认操作。"}${list}\n\n回复“确认”执行，回复“取消”放弃。`;
}

export function formatExecution(result) {
  const rows = Array.isArray(result?.results) ? result.results : [];
  const success = rows.filter((item) => item.ok).length;
  const failures = rows.filter((item) => !item.ok);
  if (!failures.length) return `已执行 ${success} 项操作，数据已同步到 BHS。`;
  return `已执行 ${success}/${rows.length} 项。${failures.slice(0, 3).map((item) => `\n• ${item.error || "执行失败"}`).join("")}`;
}

export function outputMediaUrls(outputs = []) {
  const urls = [];
  const add = (value) => {
    if (typeof value === "string" && value && !urls.includes(value)) urls.push(value);
  };
  for (const output of outputs) {
    add(output?.item?.image_url);
    for (const item of output?.items || []) add(item?.image_url);
  }
  return urls.slice(0, 3);
}

function reply(text, outputs = []) {
  return { text: String(text || ""), media: outputMediaUrls(outputs) };
}

function attachmentKeys(items = []) {
  return [...new Set(items.map((item) => item?.image_key).filter(Boolean))];
}

function attachImage(actions, attachment) {
  if (!attachment?.image_key) return actions;
  const target = actions.find((action) => ["create_product", "update_product"].includes(action?.type));
  if (target) target.product = { ...(target.product || {}), image_key: attachment.image_key };
  return actions;
}

export class WeChatBridge {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/ensure" && request.method === "POST") return json(await this.ensure());
    if (path === "/start" && request.method === "POST") return json(await this.start());
    if (path === "/stop" && request.method === "POST") return json(await this.stop());
    if (path === "/seed" && request.method === "POST") return json(await this.seed(await request.json()));
    if (path === "/status" && request.method === "GET") return json(await this.status());
    return json({ error: "not_found" }, 404);
  }

  async ensure() {
    const enabled = await this.ctx.storage.get("enabled");
    if (enabled === false) return { ok: true, running: false };
    if (enabled == null) await this.ctx.storage.put("enabled", true);
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + 250);
    return { ok: true, running: true };
  }

  async start() {
    await this.ctx.storage.put({ enabled: true, last_error: "" });
    await this.ctx.storage.setAlarm(Date.now() + 100);
    return { ok: true, running: true };
  }

  async stop() {
    await this.ctx.storage.put("enabled", false);
    await this.ctx.storage.deleteAlarm();
    return { ok: true, running: false };
  }

  async seed(input) {
    const cursor = typeof input?.cursor === "string" ? input.cursor : "";
    if (!cursor) return { ok: false, error: "cursor_required" };
    await this.ctx.storage.put("cursor", cursor);
    return { ok: true, seeded: true };
  }

  async status() {
    const values = await this.ctx.storage.get([
      "enabled", "last_poll_at", "last_inbound_at", "last_reply_at", "last_heartbeat_at",
      "last_error", "pending_messages", "blocked_messages", "processed_messages",
    ]);
    const enabled = values.get("enabled") === true;
    const allowedUser = String(this.env.WEIXIN_ALLOWED_USER_ID || "").trim();
    const [pendingAction, pendingMedia] = allowedUser
      ? await Promise.all([
          this.ctx.storage.get(`pending_actions:${allowedUser}`),
          this.ctx.storage.get(`pending_media:${allowedUser}`),
        ])
      : [null, null];
    return {
      ok: true,
      running: enabled,
      scheduled: enabled && (await this.ctx.storage.getAlarm()) != null,
      last_poll_at: values.get("last_poll_at") || null,
      last_inbound_at: values.get("last_inbound_at") || null,
      last_reply_at: values.get("last_reply_at") || null,
      last_heartbeat_at: values.get("last_heartbeat_at") || null,
      last_error: values.get("last_error") || "",
      queued: (values.get("pending_messages") || []).length,
      blocked_messages: values.get("blocked_messages") || 0,
      processed_messages: values.get("processed_messages") || 0,
      pending_action: Boolean(pendingAction),
      pending_media: Boolean(pendingMedia),
    };
  }

  async alarm() {
    if ((await this.ctx.storage.get("enabled")) === false) return;
    let delay = POLL_RESTART_DELAY_MS;
    try {
      let queue = (await this.ctx.storage.get("pending_messages")) || [];
      if (!queue.length) queue = await this.pollOnce();
      if (queue.length) await this.processQueue(queue);
      await this.maybeHeartbeat();
      await this.ctx.storage.put("last_error", "");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await this.ctx.storage.put("last_error", message.slice(0, 300));
      delay = message.includes("session_expired") ? 5 * 60 * 1000 : 15_000;
    } finally {
      if ((await this.ctx.storage.get("enabled")) !== false) await this.ctx.storage.setAlarm(Date.now() + delay);
    }
  }

  async weixin(path, body, timeoutMs = POLL_TIMEOUT_MS) {
    if (!this.env.WEIXIN_TOKEN || !this.env.WEIXIN_BASE_URL) throw new Error("wechat_credentials_missing");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint(this.env.WEIXIN_BASE_URL, path), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          AuthorizationType: "ilink_bot_token",
          Authorization: `Bearer ${this.env.WEIXIN_TOKEN}`,
          "X-WECHAT-UIN": randomWechatUin(),
          "iLink-App-Id": this.env.WEIXIN_APP_ID || "bot",
          "iLink-App-ClientVersion": this.env.WEIXIN_APP_CLIENT_VERSION || "132102",
        },
        body: JSON.stringify({ ...body, base_info: { channel_version: this.env.WEIXIN_CHANNEL_VERSION || "2.4.6", bot_agent: "BHS/1.1.0" } }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`wechat_http_${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async pollOnce() {
    const cursor = (await this.ctx.storage.get("cursor")) || "";
    const response = await this.weixin("ilink/bot/getupdates", { get_updates_buf: cursor });
    if ((response.ret && response.ret !== 0) || (response.errcode && response.errcode !== 0)) {
      if (response.ret === -14 || response.errcode === -14) throw new Error("session_expired");
      throw new Error(`wechat_api_${response.errcode || response.ret}`);
    }
    const queue = (await this.ctx.storage.get("pending_messages")) || [];
    const recent = (await this.ctx.storage.get("recent_ids")) || [];
    const seen = new Set(recent);
    let blocked = (await this.ctx.storage.get("blocked_messages")) || 0;
    const allowedUser = String(this.env.WEIXIN_ALLOWED_USER_ID || "").trim();
    for (const raw of response.msgs || []) {
      if (raw.message_type != null && raw.message_type !== USER_MESSAGE) continue;
      const message = extractInbound(raw);
      if (!message.sender || seen.has(message.id)) continue;
      seen.add(message.id);
      recent.push(message.id);
      if (allowedUser && message.sender !== allowedUser) {
        blocked += 1;
        continue;
      }
      if (message.text || ["image", "file", "video"].includes(message.kind)) queue.push(message);
    }
    await this.ctx.storage.put({
      cursor: response.get_updates_buf || cursor,
      pending_messages: queue,
      recent_ids: recent.slice(-MAX_RECENT_IDS),
      blocked_messages: blocked,
      last_poll_at: new Date().toISOString(),
    });
    return queue;
  }

  async processQueue(queue) {
    let completed = 0;
    while (queue.length && completed < MAX_QUEUE_BATCH) {
      const message = queue[0];
      try {
        if (!message.reply) {
          message.reply = message.replyText ? reply(message.replyText) : await this.replyFor(message);
          delete message.replyText;
          queue[0] = message;
          await this.ctx.storage.put("pending_messages", queue);
        }
        await this.sendReply(message.sender, message.contextToken, message.reply);
        queue.shift();
        completed += 1;
        await this.ctx.storage.put({
          pending_messages: queue,
          last_reply_at: new Date().toISOString(),
          processed_messages: ((await this.ctx.storage.get("processed_messages")) || 0) + 1,
        });
      } catch (cause) {
        message.attempts = Number(message.attempts || 0) + 1;
        queue[0] = message;
        await this.ctx.storage.put("pending_messages", queue);
        throw cause;
      }
    }
  }

  async downloadImage(image) {
    const candidates = [
      image?.media ? { media: image.media, imageAesKey: image?.aeskey || "" } : null,
      image?.thumb_media ? { media: image.thumb_media, imageAesKey: "" } : null,
    ].filter(Boolean);
    let lastError = null;
    for (const candidate of candidates) {
      try {
        const media = candidate.media;
        const cdnBase = this.env.WEIXIN_CDN_BASE_URL || CDN_BASE_URL;
        const url = media.full_url
          ? safeTencentUrl(media.full_url)
          : safeTencentUrl(`${cdnBase}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param || "")}`);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`wechat_cdn_download_${response.status}`);
        const encrypted = Buffer.from(await response.arrayBuffer());
        const key = parseAesKey(media, candidate.imageAesKey);
        const bytes = key ? decryptAesEcb(encrypted, key) : encrypted;
        const contentType = imageMime(bytes);
        if (!contentType) throw new Error("wechat_image_type_invalid");
        if (bytes.length > MAX_IMAGE_BYTES) throw new Error("wechat_image_too_large");
        return { bytes, contentType };
      } catch (cause) {
        lastError = cause;
      }
    }
    throw lastError || new Error("wechat_image_reference_missing");
  }

  async storeInboundImage(message) {
    if (!message.image) throw new Error("wechat_image_reference_missing");
    const image = await this.downloadImage(message.image);
    return this.callBhs("/api/channel/media", {
      source_id: `wechat-image:${message.id}`,
      sender: message.sender,
      content_type: image.contentType,
      body_base64: base64url(image.bytes),
    });
  }

  async cleanupAttachments(attachments) {
    const imageKeys = attachmentKeys(attachments);
    if (!imageKeys.length) return;
    try { await this.callBhs("/api/channel/media/cleanup", { image_keys: imageKeys }); } catch { /* expiry cleanup will retry later */ }
  }

  async replyFor(message) {
    await this.ctx.storage.put("last_inbound_at", new Date().toISOString());
    const pendingKey = `pending_actions:${message.sender}`;
    const mediaKey = `pending_media:${message.sender}`;
    let pending = await this.ctx.storage.get(pendingKey);
    let pendingMedia = await this.ctx.storage.get(mediaKey);
    if (pending && Date.now() - pending.createdAt > PENDING_ACTION_TTL_MS) {
      await this.cleanupAttachments(pending.attachments);
      await this.ctx.storage.delete(pendingKey);
      pending = null;
    }
    if (pendingMedia && Date.now() - pendingMedia.createdAt > PENDING_ACTION_TTL_MS) {
      await this.cleanupAttachments([pendingMedia]);
      await this.ctx.storage.delete(mediaKey);
      pendingMedia = null;
    }

    if (isCancellation(message.text)) {
      await this.cleanupAttachments([...(pending?.attachments || []), ...(pendingMedia ? [pendingMedia] : [])]);
      await this.ctx.storage.delete([pendingKey, mediaKey]);
      return reply(pending || pendingMedia ? "已取消，未修改任何数据，暂存图片也已清理。" : "当前没有待取消的操作。");
    }

    if (isConfirmation(message.text)) {
      if (!pending) return reply("当前没有待确认操作，请重新告诉我要处理什么。");
      const result = await this.callBhs("/api/channel/execute", {
        actions: pending.actions,
        external_id: `wechat-execute:${message.id}`,
      });
      await this.ctx.storage.delete(pendingKey);
      await this.cleanupAttachments(pending.attachments);
      return reply(formatExecution(result), result.outputs);
    }

    let attachments = [];
    if (message.image) {
      const stored = { ...(await this.storeInboundImage(message)), createdAt: Date.now() };
      attachments = [stored];
      if (!message.text) {
        if (pending) {
          attachImage(pending.actions, stored);
          pending.attachments = [stored];
          pending.createdAt = Date.now();
          await this.ctx.storage.put(pendingKey, pending);
          return reply(formatActionProposal("图片已加入这次操作。", pending.actions));
        }
        if (pendingMedia) await this.cleanupAttachments([pendingMedia]);
        await this.ctx.storage.put(mediaKey, stored);
        return reply("图片已保存，30 分钟内继续发送文字或语音说明商品名、数量、进价和售价，创建时会自动设为商品主图。");
      }
    } else if (pendingMedia) {
      attachments = [pendingMedia];
    }

    if (["file", "video"].includes(message.kind) && !message.text) return reply("暂时不能直接读取这个文件，请发送文字或语音说明。");

    const result = await this.callBhs("/api/channel/message", {
      message: message.text,
      sender: message.sender,
      attachments,
      external_id: `wechat-message:${message.id}`,
    });
    const actions = (Array.isArray(result.actions) ? result.actions : []).map((action) => ({ ...action, product: action.product ? { ...action.product } : action.product }));
    if (attachments.length) attachImage(actions, attachments[0]);
    if (!actions.length) return reply(result.reply || "这次没有生成有效回复，请重新描述。", result.outputs);

    if (pending) {
      const reused = new Set(attachmentKeys(attachments));
      await this.cleanupAttachments((pending.attachments || []).filter((item) => !reused.has(item.image_key)));
    }
    await this.ctx.storage.put(pendingKey, { actions, attachments, createdAt: Date.now(), sourceMessageId: message.id });
    if (attachments.length) await this.ctx.storage.delete(mediaKey);
    return reply(formatActionProposal(result.reply, actions), result.outputs);
  }

  async callBhs(path, body) {
    if (!this.env.BHS_CHANNEL_TOKEN) throw new Error("bhs_channel_token_missing");
    const response = await fetch(endpoint(this.env.BHS_BASE_URL || "https://bhsbot.pages.dev", path), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.env.BHS_CHANNEL_TOKEN}` },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`bhs_api_${response.status}:${data.error || "failed"}`);
    return data;
  }

  async maybeHeartbeat() {
    const last = Number((await this.ctx.storage.get("last_heartbeat_ms")) || 0);
    if (Date.now() - last < 4 * 60 * 1000) return;
    await this.callBhs("/api/channel/heartbeat", {});
    await this.callBhs("/api/channel/media/cleanup", { image_keys: [] });
    await this.ctx.storage.put({ last_heartbeat_ms: Date.now(), last_heartbeat_at: new Date().toISOString() });
  }

  async prepareWeixinImage(urlValue, to) {
    const base = new URL(this.env.BHS_BASE_URL || "https://bhsbot.pages.dev");
    const url = new URL(urlValue, base);
    if (url.origin !== base.origin || !url.pathname.startsWith("/media/")) throw new Error("bhs_media_url_invalid");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`bhs_media_fetch_${response.status}`);
    const plaintext = Buffer.from(await response.arrayBuffer());
    if (!plaintext.length || plaintext.length > MAX_IMAGE_BYTES || !imageMime(plaintext)) throw new Error("bhs_media_invalid");
    const aeskey = randomBytes(16);
    const ciphertext = encryptAesEcb(plaintext, aeskey);
    const filekey = randomBytes(16).toString("hex");
    const upload = await this.weixin("ilink/bot/getuploadurl", {
      filekey,
      media_type: 1,
      to_user_id: to,
      rawsize: plaintext.length,
      rawfilemd5: createHash("md5").update(plaintext).digest("hex"),
      filesize: ciphertext.length,
      no_need_thumb: true,
      aeskey: aeskey.toString("hex"),
    }, 15_000);
    if ((upload.ret && upload.ret !== 0) || (upload.errcode && upload.errcode !== 0)) throw new Error(`wechat_upload_url_${upload.errcode || upload.ret}`);
    const cdnBase = this.env.WEIXIN_CDN_BASE_URL || CDN_BASE_URL;
    const uploadUrl = upload.upload_full_url
      ? safeTencentUrl(upload.upload_full_url)
      : safeTencentUrl(`${cdnBase}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param || "")}&filekey=${encodeURIComponent(filekey)}`);
    const uploaded = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(ciphertext) });
    if (!uploaded.ok) throw new Error(`wechat_cdn_upload_${uploaded.status}`);
    const downloadParam = uploaded.headers.get("x-encrypted-param");
    if (!downloadParam) throw new Error("wechat_cdn_param_missing");
    return { downloadParam, aeskey, ciphertextSize: ciphertext.length };
  }

  async sendText(to, contextToken, text) {
    const response = await this.weixin("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: `bhs-wechat-${crypto.randomUUID()}`,
        message_type: BOT_MESSAGE,
        message_state: FINISHED,
        item_list: [{ type: TEXT, text_item: { text: String(text || "").slice(0, 1800) } }],
        context_token: contextToken || undefined,
      },
    }, 15_000);
    if (response.ret && response.ret !== 0) throw new Error(`wechat_send_${response.ret}`);
  }

  async sendImage(to, contextToken, uploaded) {
    const response = await this.weixin("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: `bhs-wechat-image-${crypto.randomUUID()}`,
        message_type: BOT_MESSAGE,
        message_state: FINISHED,
        item_list: [{
          type: IMAGE,
          image_item: {
            media: {
              encrypt_query_param: uploaded.downloadParam,
              aes_key: Buffer.from(uploaded.aeskey.toString("hex"), "utf8").toString("base64"),
              encrypt_type: 1,
            },
            mid_size: uploaded.ciphertextSize,
          },
        }],
        context_token: contextToken || undefined,
      },
    }, 15_000);
    if (response.ret && response.ret !== 0) throw new Error(`wechat_send_image_${response.ret}`);
  }

  async sendReply(to, contextToken, content) {
    const text = String(content?.text || "");
    const media = [...new Set(Array.isArray(content?.media) ? content.media : [])].slice(0, 3);
    if (!media.length) return this.sendText(to, contextToken, text);
    const uploads = [];
    for (const url of media) uploads.push(await this.prepareWeixinImage(url, to));
    if (text) await this.sendText(to, contextToken, text);
    for (const uploaded of uploads) await this.sendImage(to, contextToken, uploaded);
  }
}

function bridge(env) {
  return env.WECHAT_BRIDGE.getByName("primary");
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return json({ ok: true, service: "BHS WeChat Bridge" });
    if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
    if (path === "/status" && request.method === "GET") return bridge(env).fetch("https://bridge.internal/status");
    if (["/start", "/stop"].includes(path) && request.method === "POST") return bridge(env).fetch(`https://bridge.internal${path}`, { method: "POST" });
    if (path === "/seed" && request.method === "POST") return bridge(env).fetch("https://bridge.internal/seed", { method: "POST", body: await request.text() });
    return json({ error: "not_found" }, 404);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(bridge(env).fetch("https://bridge.internal/ensure", { method: "POST" }));
  },
};
