import test from "node:test";
import assert from "node:assert/strict";
import {
  decryptAesEcb,
  encryptAesEcb,
  extractInbound,
  formatActionProposal,
  formatExecution,
  isCancellation,
  isConfirmation,
  outputMediaUrls,
} from "../src/index.js";

test("round-trips Tencent-compatible AES-128-ECB media", () => {
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const original = Buffer.from("BHS WeChat image payload");
  const encrypted = encryptAesEcb(original, key);
  assert.notDeepEqual(encrypted, original);
  assert.deepEqual(decryptAesEcb(encrypted, key), original);
});

test("extracts text and voice transcript", () => {
  assert.equal(extractInbound({ message_id: 1, from_user_id: "u", item_list: [{ type: 1, text_item: { text: "今天进货" } }] }).text, "今天进货");
  assert.equal(extractInbound({ message_id: 2, from_user_id: "u", item_list: [{ type: 3, voice_item: { text: "进价三元" } }] }).text, "进价三元");
});

test("keeps image metadata together with a text caption", () => {
  const inbound = extractInbound({ message_id: 3, from_user_id: "u", item_list: [
    { type: 2, image_item: { media: { full_url: "https://example.invalid/a" }, aeskey: "00".repeat(16) } },
    { type: 1, text_item: { text: "可乐十瓶" } },
  ] });
  assert.equal(inbound.kind, "image");
  assert.equal(inbound.text, "可乐十瓶");
  assert.equal(inbound.image.aeskey.length, 32);
});

test("recognizes explicit confirmation and cancellation only", () => {
  assert.equal(isConfirmation("确认执行"), true);
  assert.equal(isConfirmation("看看库存"), false);
  assert.equal(isCancellation("取消。"), true);
});

test("formats proposals and execution result for mobile", () => {
  assert.match(formatActionProposal("已整理", [{ summary: "新增可乐 10 罐" }]), /回复“确认”执行/);
  assert.equal(formatExecution({ results: [{ ok: true }, { ok: true }] }), "已执行 2 项操作，数据已同步到 BHS。");
});

test("collects unique product images from structured results", () => {
  assert.deepEqual(outputMediaUrls([
    { type: "products", items: [{ image_url: "/media/a" }, { image_url: "/media/b" }] },
    { type: "product", item: { image_url: "/media/a" } },
  ]), ["/media/a", "/media/b"]);
});
