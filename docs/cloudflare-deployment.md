# BHS Cloudflare 部署

## 线上组成

| 组件 | Cloudflare 产品 | 作用 |
| --- | --- | --- |
| `bhsbot` | Pages + Advanced Mode Worker | 网站、登录、API、AI 管家 |
| `bhsbot-db` | D1 | 用户、商品、图片、库存、销售、对话与审计 |
| `bhs-wechat-bridge` | Worker + SQLite Durable Object | 个人微信轮询、待确认操作、图片收发 |
| DeepSeek | 外部 API | 意图整理、查询总结和操作规划 |

当前线上版本完全运行在 Cloudflare，不依赖本机 Flask、Cloudflare Tunnel 或本地 OpenClaw。`openclaw/` 仅保留为可选接入和 Skill 参考。

## 首次准备

1. 安装 Node.js 22 和 Wrangler，并执行 `wrangler login`。
2. 创建 D1 数据库。`cloudflare/wrangler.jsonc` 里的 `database_id` 是占位符；用 `npx wrangler d1 create bhsbot-db` 或控制台中的真实 ID 替换它，再把绑定指向目标数据库。真实 ID 放在本地或 CI 配置中，不要提交回公开仓库。
3. 为 Pages 项目配置：
   - `SESSION_SECRET`
   - `BOSS_USERNAME`
   - `BOSS_INITIAL_PASSWORD`
   - `DEEPSEEK_API_KEY`
   - `BHS_CHANNEL_TOKEN`
4. 为微信 Worker 配置：
   - `WEIXIN_TOKEN`
   - `WEIXIN_BASE_URL`
   - `WEIXIN_ALLOWED_USER_ID`
   - `BHS_CHANNEL_TOKEN`
   - `BRIDGE_ADMIN_TOKEN`
5. 不要将实际 Secret 写入 `wrangler.jsonc`、`.env.example` 或 Git。

## 发布网站与数据库

```bash
cd cloudflare
npx wrangler d1 migrations apply bhsbot-db --remote
npm run check
npm run deploy
```

迁移按编号顺序执行。发布后至少验证：健康检查、登录、总览、商品列表、商品详情、AI 对话、CSV 导出和手机端导航。

## 发布微信桥接

```bash
cd cloudflare-wechat-bridge
npm run check
npm run deploy
```

桥接器通过 Durable Object 保存游标、待处理消息、待确认操作和暂存图片。部署新版本不会清空这些状态。图片消息使用腾讯要求的 AES-128-ECB 加解密；文字或语音信息不足时只追问，不直接写库。

## 验收标准

- `/api/health` 返回正常，网站可登录。
- 微信桥接 `running=true`、队列为 `0`、`last_error` 为空。
- 微信发送图片后，D1 的 `channel_media` 出现暂存记录。
- 补充商品信息后，机器人返回待执行摘要，不提前写入商品。
- 回复确认后，商品、图片和审计记录同时落库，微信收到执行结果。
- 查询商品时可返回真实商品数据和商品图片。
- 网站和微信不依赖当前服务器进程。

## 回滚与故障定位

- Pages 与 Worker 都保留 Cloudflare 部署版本，可在控制台回滚代码。
- D1 迁移是前向操作；生产迁移前先导出数据库，避免把代码回滚当成数据库回滚。
- “机器人已回复”不等于“业务已执行”：最终以 D1 商品/库存/销售记录和审计记录为准。
- 区分测试问题与系统问题：未发送确认属于流程未完成；队列错误、API 错误或数据未落库才属于系统故障。
