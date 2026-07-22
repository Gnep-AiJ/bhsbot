# BHS

BHS 是一个手机优先的内部超市管理系统。网站、AI 管家和个人微信机器人共用同一套 Cloudflare D1 数据，AI 可以查询经营数据，并在用户确认后执行商品、库存、销售和成员管理操作。

## 当前架构

```text
手机 / 电脑 ── bhsbot.pages.dev ── Pages Worker ── D1
                                      │
个人微信 ── WeChat Bridge Worker ─────┤
                                      └── DeepSeek API
```

- 网站：Cloudflare Pages，入口为 `https://bhsbot.pages.dev`
- 数据与商品图片：Cloudflare D1
- 微信桥接：Cloudflare Worker + SQLite Durable Object
- AI：DeepSeek，仅通过服务端密钥调用
- 本机不是线上运行依赖；根目录 Flask 版本保留作本地开发和回退参考

## 已实现

- Boss、管理员、员工三级内部账号，无公开注册
- 商品详情、图片、条码、供应商、库存、成本与售价管理
- 销售、撤销销售、库存流水和经营总览
- CSV 导入、导出和外部销售系统预留入口
- AI 查询及商品、库存、销售、成员的增删改查
- 所有 AI 写操作先生成摘要，明确确认后执行并写入审计记录
- 微信图片、文字和语音转文字可组合建档，执行结果可返回商品图片
- 手机端响应式界面

## 目录

| 路径 | 用途 |
| --- | --- |
| `cloudflare/` | 当前线上网站、Pages Worker、D1 迁移与线上验收脚本 |
| `cloudflare-wechat-bridge/` | 个人微信长轮询、媒体加解密、确认队列与回图 |
| `openclaw/workspace/skills/` | 可复用的 BHS 门店操作 Skill |
| `app.py`、`templates/`、`static/` | 本地 Flask 参考实现 |
| `tests/` | Flask 与响应式界面测试 |
| `docs/` | 部署和运维说明 |

## 本地检查

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
.venv/bin/python -m unittest tests/test_app.py

cd cloudflare
npm run check

cd ../cloudflare-wechat-bridge
npm run check
```

## Cloudflare 部署

```bash
cd cloudflare
npx wrangler d1 migrations apply bhsbot-db --remote
npm run deploy

cd ../cloudflare-wechat-bridge
npm run deploy
```

部署前需在 Cloudflare 中配置 Pages/Worker Secrets。完整说明见 [Cloudflare 部署文档](docs/cloudflare-deployment.md)。

## 安全

- `.env`、`.dev.vars`、D1/SQLite 数据库、OpenClaw 会话和 Wrangler 本地状态均被 Git 忽略。
- 不在源码中保存 DeepSeek Key、微信令牌、渠道令牌或真实账号密码。
- 生产写操作必须经过身份验证、权限检查、明确确认和审计记录。
- 已在聊天或日志中暴露过的密钥应在继续公开使用前轮换。
