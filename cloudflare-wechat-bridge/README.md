# BHS WeChat Bridge

Cloudflare Workers Free + SQLite Durable Object implementation of the BHS personal-WeChat channel.

It keeps `bhsbot.pages.dev` as the only user-facing website. The Worker performs Tencent iLink long polling in the background, forwards authorized text and voice transcripts to BHS, stores pending AI actions, and requires an explicit `确认` before execution.

Supported BHS workflows:

- Receive and decrypt a WeChat product image, keep it for 30 minutes, and bind it to the next create/update action.
- Query live dashboard, product, sales, inventory movement and member data.
- Create/update/archive/restore/purge products, adjust stock, record or void a sale, and manage internal users after confirmation.
- Upload BHS product images back to the Tencent CDN and return them with structured query or execution results.
- Preserve structured query cards in BHS assistant history so website and WeChat records stay aligned.

DeepSeek remains the planning and analysis model. It is text-only, so a received photo is used as the product image while the product fields come from the accompanying text or voice transcript.

Required Worker secrets:

- `WEIXIN_TOKEN`
- `WEIXIN_BASE_URL`
- `WEIXIN_ALLOWED_USER_ID`
- `BHS_CHANNEL_TOKEN`
- `BRIDGE_ADMIN_TOKEN`

The bridge never exposes these values from its health or status endpoints.
