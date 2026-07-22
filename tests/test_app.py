import os
import re
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import Mock, patch

os.environ.setdefault("SECRET_KEY", "bhs-test-secret-key-only-for-unit-tests")
os.environ.setdefault("BHS_CHANNEL_TOKEN", "bhs-test-channel-token-only-for-unit-tests")
os.environ.setdefault("BOSS_USERNAME", "Dongli")
os.environ.setdefault("BOSS_INITIAL_PASSWORD", "bhs-test-boss-password")

import app as bhs


class BhsAppTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        bhs.DATABASE = Path(self.tempdir.name) / "test.db"
        bhs.init_db()
        bhs.app.config.update(TESTING=True)
        self.client = bhs.app.test_client()

    def tearDown(self):
        self.tempdir.cleanup()

    def csrf(self, html):
        match = re.search(r'name="_csrf" value="([^"]+)"', html.decode())
        self.assertIsNotNone(match)
        return match.group(1)

    def login(self):
        response = self.client.get("/login")
        token = self.csrf(response.data)
        return self.client.post(
            "/login",
            data={"_csrf": token, "username": os.environ["BOSS_USERNAME"], "password": os.environ["BOSS_INITIAL_PASSWORD"]},
            follow_redirects=True,
        )

    def test_login_and_core_pages(self):
        response = self.login()
        self.assertEqual(response.status_code, 200)
        self.assertIn("经营总览".encode(), response.data)
        self.assertEqual(self.client.get("/products").status_code, 200)
        self.assertEqual(self.client.get("/sales").status_code, 200)
        self.assertEqual(self.client.get("/assistant").status_code, 200)
        self.assertEqual(self.client.get("/users").status_code, 200)
        self.assertEqual(self.client.get("/integrations").status_code, 200)
        self.assertEqual(self.client.get("/data").status_code, 200)

    def test_create_and_view_product(self):
        self.login()
        response = self.client.get("/products/new")
        token = self.csrf(response.data)
        response = self.client.post(
            "/products/new",
            data={
                "_csrf": token,
                "name": "测试牛奶",
                "sku": "MILK-001",
                "unit": "盒",
                "stock": "12",
                "low_stock": "4",
                "cost": "3.5",
                "price": "5.5",
                "supplier": "测试供应商",
            },
            follow_redirects=True,
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("测试牛奶".encode(), response.data)
        self.assertIn("测试供应商".encode(), response.data)
        connection = bhs.sqlite3.connect(bhs.DATABASE)
        movement = connection.execute(
            "SELECT change_amount, after_stock FROM inventory_movements"
        ).fetchone()
        connection.close()
        self.assertEqual(movement, (12, 12))

    def test_internal_user_creation(self):
        self.login()
        response = self.client.get("/users")
        token = self.csrf(response.data)
        response = self.client.post(
            "/users",
            data={
                "_csrf": token,
                "username": "staff01",
                "display_name": "店员一",
                "password": "staff-pass-01",
                "role": "staff",
            },
            follow_redirects=True,
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("店员一".encode(), response.data)

    def test_channel_requires_token(self):
        self.assertEqual(self.client.get("/api/channel/health").status_code, 401)
        token = bhs.os.environ["BHS_CHANNEL_TOKEN"]
        response = self.client.get(
            "/api/channel/health", headers={"Authorization": f"Bearer {token}"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["ok"])

    def test_public_health_and_security_headers(self):
        response = self.client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["ok"])
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(response.headers["X-Frame-Options"], "DENY")

    def test_login_failures_are_rate_limited(self):
        page = self.client.get("/login")
        token = self.csrf(page.data)
        with patch.dict(bhs.os.environ, {"BHS_LOGIN_MAX_ATTEMPTS": "3"}):
            for _ in range(3):
                response = self.client.post(
                    "/login",
                    data={"_csrf": token, "username": os.environ["BOSS_USERNAME"], "password": "wrong-pass"},
                )
                self.assertEqual(response.status_code, 401)
            limited = self.client.post(
                "/login",
                data={"_csrf": token, "username": os.environ["BOSS_USERNAME"], "password": "wrong-pass"},
            )
        self.assertEqual(limited.status_code, 429)
        self.assertIn("登录尝试过多".encode(), limited.data)

    def test_openclaw_proxy_uses_visible_message_and_filters_runtime_context(self):
        internal_context = """OpenClaw runtime context for the immediately preceding user message.
This context is runtime-generated, not user-authored. Keep internal details private.

<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>
Conversation info (untrusted metadata):
```json
{"message_id":"openclaw-weixin:test-message-1"}
```
<<<END_OPENCLAW_INTERNAL_CONTEXT>>>"""
        upstream = Mock()
        upstream.ok = True
        upstream.status_code = 200
        upstream.json.return_value = {
            "choices": [{"message": {"content": "收到，BHS 同步正常。"}}]
        }
        token = bhs.os.environ["BHS_CHANNEL_TOKEN"]

        with patch.object(bhs, "deepseek_request", return_value=upstream) as mocked:
            response = self.client.post(
                "/api/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "messages": [
                        {"role": "user", "content": "BHS同步测试"},
                        {"role": "user", "content": internal_context},
                    ]
                },
            )

        self.assertEqual(response.status_code, 200)
        forwarded_messages = mocked.call_args.args[0]["messages"]
        self.assertFalse(
            any(
                bhs.is_openclaw_internal_message(message["content"])
                for message in forwarded_messages
            )
        )
        connection = bhs.sqlite3.connect(bhs.DATABASE)
        stored = connection.execute(
            "SELECT content, external_id FROM messages WHERE role = 'user'"
        ).fetchone()
        connection.close()
        self.assertEqual(stored[0], "BHS同步测试")
        self.assertEqual(stored[1], "openclaw-weixin:test-message-1")

    def test_wechat_long_model_reply_is_compacted_and_finishes_normally(self):
        upstream = Mock()
        upstream.ok = True
        upstream.status_code = 200
        upstream.json.return_value = {
            "choices": [
                {
                    "message": {"content": "商品明细\n" + "测试商品，库存正常。\n" * 180},
                    "finish_reason": "length",
                }
            ]
        }
        token = bhs.os.environ["BHS_CHANNEL_TOKEN"]
        with patch.object(bhs, "deepseek_request", return_value=upstream) as mocked:
            response = self.client.post(
                "/api/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "model": "bhs-deepseek",
                    "stream": True,
                    "messages": [{"role": "user", "content": "当前商品"}],
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "text/event-stream")
        body = response.data.decode()
        self.assertIn('"finish_reason": "stop"', body)
        self.assertNotIn('"finish_reason": "length"', body)
        self.assertIn("微信不展开完整清单", body)
        forwarded = mocked.call_args.args[0]
        self.assertFalse(forwarded["stream"])
        self.assertEqual(forwarded["max_tokens"], 900)
        self.assertIn("不超过 600 个中文字符", forwarded["messages"][0]["content"])

    def test_ai_product_draft_returns_only_structured_fields(self):
        self.login()
        form_page = self.client.get("/products/new")
        token = self.csrf(form_page.data)
        upstream = Mock()
        upstream.ok = True
        upstream.json.return_value = {
            "choices": [
                {
                    "message": {
                        "content": '{"name":"可口可乐 500ml","price":3,"cost":2.3,"stock":24,"supplier":"华南食品","barcode":null}'
                    }
                }
            ]
        }

        with patch.object(bhs, "deepseek_request", return_value=upstream) as mocked:
            response = self.client.post(
                "/api/products/ai-draft",
                headers={"X-CSRF-Token": token},
                json={"description": "可口可乐500毫升，进价2块3，卖3块，24瓶，华南食品供货"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json()["draft"],
            {
                "name": "可口可乐 500ml",
                "supplier": "华南食品",
                "stock": 24.0,
                "cost": 2.3,
                "price": 3.0,
            },
        )
        payload = mocked.call_args.args[0]
        self.assertEqual(payload["response_format"], {"type": "json_object"})

    def test_customer_pages_do_not_expose_model_details(self):
        login_page = self.client.get("/login")
        self.assertNotIn(b"DeepSeek", login_page.data)
        self.login()
        connections = self.client.get("/integrations")
        assistant = self.client.get("/assistant")
        self.assertNotIn(b"DeepSeek", connections.data)
        self.assertNotIn(b"OpenClaw", connections.data)
        self.assertNotIn(b"DeepSeek", assistant.data)

    def test_barcode_photo_is_decoded_and_catalog_data_returned(self):
        self.login()
        page = self.client.get("/products")
        token = self.csrf(page.data)
        barcode = bhs.zxingcpp.create_barcode(
            "5901234123457", bhs.zxingcpp.BarcodeFormat.EAN13
        )
        barcode_image = barcode.to_image(size_hint=420, with_quiet_zones=True)
        height, width = barcode_image.shape
        image = bhs.Image.frombytes("L", (width, height), memoryview(barcode_image).tobytes())
        image_bytes = BytesIO()
        image.save(image_bytes, format="PNG")
        image_bytes.seek(0)

        catalog_response = Mock()
        catalog_response.ok = True
        catalog_response.json.return_value = {
            "product": {
                "product_name_zh": "测试矿泉水",
                "brands": "BHS 测试品牌",
                "quantity": "550ml",
                "categories": "饮料,水",
                "image_front_url": "https://images.openfoodfacts.org/test.jpg",
            }
        }
        with patch.object(bhs.requests, "get", return_value=catalog_response):
            response = self.client.post(
                "/api/products/barcode/scan",
                headers={"X-CSRF-Token": token},
                data={"barcode_photo": (image_bytes, "barcode.png")},
                content_type="multipart/form-data",
            )

        self.assertEqual(response.status_code, 200)
        result = response.get_json()
        self.assertEqual(result["barcode"], "5901234123457")
        self.assertTrue(result["found"])
        self.assertEqual(result["product"]["name"], "测试矿泉水")
        self.assertEqual(result["product"]["specification"], "550ml")

    def test_product_csv_export_is_excel_friendly(self):
        self.login()
        response = self.client.get("/products/new?mode=manual")
        token = self.csrf(response.data)
        self.client.post(
            "/products/new",
            data={
                "_csrf": token,
                "name": "导出测试商品",
                "barcode": "6901234567892",
                "brand": "BHS",
                "specification": "500ml",
                "unit": "瓶",
                "stock": "8",
                "low_stock": "2",
                "cost": "1.5",
                "price": "2.5",
                "supplier": "测试供应商",
            },
        )
        export = self.client.get("/data/products.csv")
        self.assertEqual(export.status_code, 200)
        self.assertTrue(export.data.startswith(b"\xef\xbb\xbf"))
        decoded = export.data.decode("utf-8-sig")
        self.assertIn("商品名称,品牌,规格", decoded)
        self.assertIn("导出测试商品,BHS,500ml", decoded)
        self.assertIn("attachment;", export.headers["Content-Disposition"])

    def test_dashboard_aggregates_sales_profit_and_inventory(self):
        self.login()
        with bhs.app.app_context():
            connection = bhs.get_db()
            now = bhs.now_iso()
            product = connection.execute(
                """INSERT INTO products
                   (name, unit, stock, low_stock, cost, price, created_at, updated_at)
                   VALUES ('经营测试商品', '件', 10, 2, 4, 7, ?, ?)""",
                (now, now),
            )
            connection.execute(
                """INSERT INTO sales
                   (product_id, sale_date, quantity, revenue, cost_amount, source, created_at)
                   VALUES (?, ?, 3, 21, 12, 'TEST', ?)""",
                (
                    product.lastrowid,
                    bhs.datetime.now(bhs.timezone.utc).date().isoformat(),
                    now,
                ),
            )
            connection.commit()

        dashboard = self.client.get("/")
        self.assertEqual(dashboard.status_code, 200)
        self.assertIn("今日销售额".encode(), dashboard.data)
        self.assertIn("¥21.00".encode(), dashboard.data)
        self.assertIn("今日毛利".encode(), dashboard.data)
        self.assertIn("¥9.00".encode(), dashboard.data)
        self.assertIn("库存成本".encode(), dashboard.data)

    def test_ai_butler_requires_confirmation_before_adjusting_stock(self):
        login = self.login()
        token = self.csrf(login.data)
        with bhs.app.app_context():
            connection = bhs.get_db()
            now = bhs.now_iso()
            cursor = connection.execute(
                """INSERT INTO products
                   (name, unit, stock, low_stock, cost, price, created_at, updated_at)
                   VALUES ('AI 管理商品', '件', 10, 2, 4, 7, ?, ?)""",
                (now, now),
            )
            product_id = cursor.lastrowid
            connection.commit()

        upstream = Mock()
        upstream.ok = True
        upstream.json.return_value = {
            "choices": [
                {
                    "message": {
                        "content": (
                            '{"reply":"准备增加 5 件库存，请确认。","action":'
                            f'{{"type":"adjust_stock","product_id":{product_id},"delta":5}}}}'
                        )
                    }
                }
            ]
        }
        with patch.object(bhs, "deepseek_request", return_value=upstream):
            proposal = self.client.post(
                "/api/chat",
                headers={"X-CSRF-Token": token},
                json={"message": "给 AI 管理商品增加 5 件库存"},
            )

        self.assertEqual(proposal.status_code, 200)
        action = proposal.get_json()["proposal"]
        self.assertIsNotNone(action)
        with bhs.app.app_context():
            stock_before = bhs.get_db().execute(
                "SELECT stock FROM products WHERE id = ?", (product_id,)
            ).fetchone()[0]
        self.assertEqual(stock_before, 10)

        confirmed = self.client.post(
            f"/api/ai/actions/{action['id']}/confirm",
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(confirmed.status_code, 200)
        with bhs.app.app_context():
            stock_after = bhs.get_db().execute(
                "SELECT stock FROM products WHERE id = ?", (product_id,)
            ).fetchone()[0]
        self.assertEqual(stock_after, 15)

    def test_ai_archive_is_real_only_after_confirmation(self):
        login = self.login()
        token = self.csrf(login.data)
        with bhs.app.app_context():
            connection = bhs.get_db()
            now = bhs.now_iso()
            cursor = connection.execute(
                """INSERT INTO products
                   (name, unit, stock, low_stock, cost, price, created_at, updated_at)
                   VALUES ('待停用商品', '件', 3, 1, 2, 3, ?, ?)""",
                (now, now),
            )
            product_id = cursor.lastrowid
            connection.commit()

        upstream = Mock()
        upstream.ok = True
        upstream.json.return_value = {
            "choices": [
                {
                    "message": {
                        "content": (
                            '{"reply":"已删除商品。","action":'
                            f'{{"type":"archive_product","product_id":{product_id}}}}}'
                        )
                    }
                }
            ]
        }
        with patch.object(bhs, "deepseek_request", return_value=upstream):
            proposal_response = self.client.post(
                "/api/chat",
                headers={"X-CSRF-Token": token},
                json={"message": "删除待停用商品"},
            )

        proposal_data = proposal_response.get_json()
        self.assertEqual(proposal_response.status_code, 200)
        self.assertEqual(proposal_data["proposal"]["type"], "archive_product")
        self.assertIn("确认后才会执行", proposal_data["answer"])
        with bhs.app.app_context():
            before = bhs.get_db().execute(
                "SELECT archived_at FROM products WHERE id = ?", (product_id,)
            ).fetchone()[0]
        self.assertIsNone(before)

        confirmed = self.client.post(
            "/api/chat",
            headers={"X-CSRF-Token": token},
            json={"message": "确认"},
        )
        self.assertEqual(confirmed.status_code, 200)
        self.assertIn("已执行：停用商品", confirmed.get_json()["answer"])
        with bhs.app.app_context():
            product = bhs.get_db().execute(
                "SELECT archived_at FROM products WHERE id = ?", (product_id,)
            ).fetchone()
        self.assertIsNotNone(product)
        self.assertIsNotNone(product["archived_at"])

    def test_ai_can_permanently_delete_an_archived_product_after_confirmation(self):
        login = self.login()
        token = self.csrf(login.data)
        with bhs.app.app_context():
            connection = bhs.get_db()
            now = bhs.now_iso()
            cursor = connection.execute(
                """INSERT INTO products
                   (name, unit, stock, low_stock, cost, price, archived_at, created_at, updated_at)
                   VALUES ('待彻底删除商品', '件', 0, 1, 2, 3, ?, ?, ?)""",
                (now, now, now),
            )
            product_id = cursor.lastrowid
            connection.commit()

        proposal_response = self.client.post(
            "/api/chat",
            headers={"X-CSRF-Token": token},
            json={"message": "永久删除待彻底删除商品"},
        )
        proposal = proposal_response.get_json()["proposal"]
        self.assertEqual(proposal_response.status_code, 200)
        self.assertEqual(proposal["type"], "purge_product")
        with bhs.app.app_context():
            self.assertIsNotNone(
                bhs.get_db().execute("SELECT id FROM products WHERE id = ?", (product_id,)).fetchone()
            )

        confirmed = self.client.post(
            "/api/chat",
            headers={"X-CSRF-Token": token},
            json={"message": "确认"},
        )
        self.assertEqual(confirmed.status_code, 200)
        self.assertIn("已执行：永久删除商品", confirmed.get_json()["answer"])
        with bhs.app.app_context():
            connection = bhs.get_db()
            self.assertIsNone(
                connection.execute("SELECT id FROM products WHERE id = ?", (product_id,)).fetchone()
            )
            action = connection.execute(
                "SELECT status, product_id FROM ai_actions WHERE id = ?", (proposal["id"],)
            ).fetchone()
        self.assertEqual(tuple(action), ("confirmed", None))

    def test_ai_failure_is_returned_and_persisted_as_an_assistant_message(self):
        login = self.login()
        token = self.csrf(login.data)
        with patch.object(bhs, "ai_butler_response", side_effect=RuntimeError("AI 管家暂时不可用，请稍后重试。")):
            response = self.client.post(
                "/api/chat",
                headers={"X-CSRF-Token": token},
                json={"message": "分析今天的经营情况"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["failed"])
        self.assertIn("这次没有执行", response.get_json()["answer"])
        with bhs.app.app_context():
            latest = bhs.get_db().execute(
                "SELECT role, channel, content FROM messages ORDER BY id DESC LIMIT 1"
            ).fetchone()
        self.assertEqual(latest["role"], "assistant")
        self.assertEqual(latest["channel"], "SYSTEM")
        self.assertIn("暂时不可用", latest["content"])

    def test_business_context_keeps_archived_products_visible_to_ai(self):
        self.login()
        with bhs.app.app_context():
            connection = bhs.get_db()
            now = bhs.now_iso()
            connection.execute(
                """INSERT INTO products
                   (name, unit, stock, low_stock, cost, price, archived_at, created_at, updated_at)
                   VALUES ('AI 可见的停用商品', '件', 0, 1, 2, 3, ?, ?, ?)""",
                (now, now, now),
            )
            connection.commit()
            context = bhs.business_context()
        self.assertIn("名称:AI 可见的停用商品", context)
        self.assertIn("状态:已停用", context)

    def test_ai_cannot_claim_an_unrecorded_action_succeeded(self):
        login = self.login()
        token = self.csrf(login.data)
        upstream = Mock()
        upstream.ok = True
        upstream.json.return_value = {
            "choices": [
                {"message": {"content": '{"reply":"已经删除完成。","action":null}'}}
            ]
        }
        with patch.object(bhs, "deepseek_request", return_value=upstream):
            response = self.client.post(
                "/api/chat",
                headers={"X-CSRF-Token": token},
                json={"message": "确认"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertIn("尚未执行", response.get_json()["answer"])

    def test_product_pagination_and_bulk_archive(self):
        login = self.login()
        token = self.csrf(login.data)
        with bhs.app.app_context():
            connection = bhs.get_db()
            product_ids = []
            for index in range(35):
                timestamp = f"2026-07-21T00:{index:02d}:00+00:00"
                cursor = connection.execute(
                    """INSERT INTO products
                       (name, unit, stock, low_stock, cost, price, created_at, updated_at)
                       VALUES (?, '件', 5, 1, 2, 3, ?, ?)""",
                    (f"批量商品{index + 1:02d}", timestamp, timestamp),
                )
                product_ids.append(cursor.lastrowid)
            connection.commit()

        second_page = self.client.get("/products?page=2")
        self.assertEqual(second_page.status_code, 200)
        self.assertIn(b"2 / 2", second_page.data)
        self.assertEqual(second_page.data.count(b'role="listitem"'), 5)

        archived = self.client.post(
            "/products/bulk-status",
            data={
                "_csrf": token,
                "operation": "archive",
                "product_ids": [str(product_ids[0]), str(product_ids[1])],
            },
            follow_redirects=True,
        )
        self.assertEqual(archived.status_code, 200)
        self.assertIn("已停用 2 件商品".encode(), archived.data)
        with bhs.app.app_context():
            count = bhs.get_db().execute(
                "SELECT COUNT(*) FROM products WHERE archived_at IS NOT NULL"
            ).fetchone()[0]
        self.assertEqual(count, 2)

        purged = self.client.post(
            "/products/bulk-status",
            data={
                "_csrf": token,
                "operation": "purge",
                "product_ids": [str(product_ids[0]), str(product_ids[1])],
            },
            follow_redirects=True,
        )
        self.assertEqual(purged.status_code, 200)
        self.assertIn("已永久删除 2 件商品".encode(), purged.data)
        with bhs.app.app_context():
            count = bhs.get_db().execute(
                "SELECT COUNT(*) FROM products WHERE id IN (?, ?)",
                (product_ids[0], product_ids[1]),
            ).fetchone()[0]
        self.assertEqual(count, 0)

    def test_stock_adjustment_creates_auditable_movement(self):
        login = self.login()
        token = self.csrf(login.data)
        with bhs.app.app_context():
            connection = bhs.get_db()
            now = bhs.now_iso()
            cursor = connection.execute(
                """INSERT INTO products
                   (name, unit, stock, low_stock, cost, price, created_at, updated_at)
                   VALUES ('入库测试商品', '箱', 4, 1, 10, 15, ?, ?)""",
                (now, now),
            )
            product_id = cursor.lastrowid
            connection.commit()
        response = self.client.post(
            f"/products/{product_id}/stock-adjust",
            data={
                "_csrf": token,
                "stock_operation": "in",
                "quantity": "6",
                "reason": "供应商到货",
            },
            follow_redirects=True,
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("库存已更新".encode(), response.data)
        with bhs.app.app_context():
            connection = bhs.get_db()
            stock = connection.execute(
                "SELECT stock FROM products WHERE id = ?", (product_id,)
            ).fetchone()[0]
            movement = connection.execute(
                """SELECT change_amount, before_stock, after_stock, reason
                   FROM inventory_movements WHERE product_id = ?""",
                (product_id,),
            ).fetchone()
        self.assertEqual(stock, 10)
        self.assertEqual(tuple(movement), (6, 4, 10, "供应商到货"))

    def test_sales_and_inventory_exports_are_available(self):
        self.login()
        sales = self.client.get("/data/sales.csv")
        movements = self.client.get("/data/inventory-movements.csv")
        self.assertEqual(sales.status_code, 200)
        self.assertEqual(movements.status_code, 200)
        self.assertTrue(sales.data.startswith(b"\xef\xbb\xbf"))
        self.assertIn("销售日期,商品ID,商品名称".encode(), sales.data)
        self.assertIn("变动数量,变动前,变动后".encode(), movements.data)

    def test_wechat_photo_voice_draft_requires_confirmation_before_insert(self):
        upload_dir = Path(self.tempdir.name) / "uploads"
        upload_dir.mkdir()
        token = bhs.os.environ["BHS_CHANNEL_TOKEN"]

        def runtime_context(message_id):
            return f'''OpenClaw runtime context for the immediately preceding user message.
<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>
{{"chat_id":"wechat-test-user","message_id":"{message_id}"}}
<<<END_OPENCLAW_INTERNAL_CONTEXT>>>'''

        with patch.object(bhs, "UPLOAD_DIR", upload_dir):
            photo_response = self.client.post(
                "/api/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "model": "bhs-deepseek",
                    "stream": True,
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "image_url",
                                    "image_url": {"url": "data:image/png;base64,aGVsbG8="},
                                }
                            ],
                        },
                        {"role": "user", "content": runtime_context("photo-1")},
                    ],
                },
            )
            self.assertEqual(photo_response.status_code, 200)
            self.assertEqual(photo_response.mimetype, "text/event-stream")
            self.assertIn("照片已收到", photo_response.data.decode())

            with patch.object(
                bhs,
                "product_draft_from_text",
                return_value={
                    "name": "测试可乐",
                    "stock": 12,
                    "cost": 2.2,
                    "price": 3.5,
                    "unit": "瓶",
                },
            ):
                draft_response = self.client.post(
                    "/api/openai/v1/chat/completions",
                    headers={"Authorization": f"Bearer {token}"},
                    json={
                        "messages": [
                            {"role": "user", "content": "测试可乐，12瓶，卖3块5"},
                            {"role": "user", "content": runtime_context("voice-1")},
                        ]
                    },
                )
            self.assertIn("确认添加", draft_response.get_json()["choices"][0]["message"]["content"])

            connection = bhs.sqlite3.connect(bhs.DATABASE)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM products").fetchone()[0], 0)
            connection.close()

            confirm_response = self.client.post(
                "/api/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "messages": [
                        {"role": "user", "content": "确认添加"},
                        {"role": "user", "content": runtime_context("confirm-1")},
                    ]
                },
            )
            self.assertIn("已添加", confirm_response.get_json()["choices"][0]["message"]["content"])

        connection = bhs.sqlite3.connect(bhs.DATABASE)
        product = connection.execute(
            "SELECT name, stock, price, unit, image_path FROM products"
        ).fetchone()
        draft_count = connection.execute("SELECT COUNT(*) FROM product_drafts").fetchone()[0]
        connection.close()
        self.assertEqual(product[:4], ("测试可乐", 12.0, 3.5, "瓶"))
        self.assertTrue(product[4].startswith("uploads/"))
        self.assertEqual(draft_count, 0)

    def test_wechat_stock_in_matches_existing_product_and_uses_weighted_cost(self):
        token = bhs.os.environ["BHS_CHANNEL_TOKEN"]
        with bhs.app.app_context():
            connection = bhs.get_db()
            now = bhs.now_iso()
            cursor = connection.execute(
                """INSERT INTO products
                   (name, unit, stock, low_stock, cost, price, supplier, created_at, updated_at)
                   VALUES ('可口可乐 500ml', '瓶', 10, 3, 2, 3.5, '原供应商', ?, ?)""",
                (now, now),
            )
            product_id = cursor.lastrowid
            connection.commit()

        def runtime_context(message_id):
            return f'''OpenClaw runtime context for the immediately preceding user message.
<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>
{{"chat_id":"wechat-stock-user","message_id":"{message_id}"}}
<<<END_OPENCLAW_INTERNAL_CONTEXT>>>'''

        with patch.object(
            bhs,
            "product_draft_from_text",
            return_value={
                "name": "可口可乐 500ml",
                "stock": 6,
                "cost": 3,
                "unit": "瓶",
                "supplier": "华南食品",
            },
        ):
            draft_response = self.client.post(
                "/api/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "messages": [
                        {"role": "user", "content": "今天进了可口可乐 500ml 货，6瓶，进价3元，华南食品送的"},
                        {"role": "user", "content": runtime_context("stock-1")},
                    ]
                },
            )
        draft_answer = draft_response.get_json()["choices"][0]["message"]["content"]
        self.assertIn("已整理入库单", draft_answer)
        self.assertIn("匹配商品：可口可乐 500ml", draft_answer)
        self.assertIn("确认入库", draft_answer)

        confirm_response = self.client.post(
            "/api/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "messages": [
                    {"role": "user", "content": "确认入库"},
                    {"role": "user", "content": runtime_context("stock-2")},
                ]
            },
        )
        confirm_answer = confirm_response.get_json()["choices"][0]["message"]["content"]
        self.assertIn("库存 10 → 16", confirm_answer)
        self.assertIn("加权进价 ¥2.38", confirm_answer)

        connection = bhs.sqlite3.connect(bhs.DATABASE)
        product = connection.execute(
            "SELECT stock, cost, supplier FROM products WHERE id = ?", (product_id,)
        ).fetchone()
        movement = connection.execute(
            "SELECT change_amount, source, reason FROM inventory_movements WHERE product_id = ?",
            (product_id,),
        ).fetchone()
        draft_count = connection.execute("SELECT COUNT(*) FROM product_drafts").fetchone()[0]
        connection.close()
        self.assertEqual(product, (16.0, 2.38, "华南食品"))
        self.assertEqual(movement[0], 6.0)
        self.assertEqual(movement[1], "WECHAT")
        self.assertIn("进价 ¥3", movement[2])
        self.assertEqual(draft_count, 0)

    def test_wechat_new_stock_item_asks_for_missing_sale_price(self):
        token = bhs.os.environ["BHS_CHANNEL_TOKEN"]

        def runtime_context(message_id):
            return f'''OpenClaw runtime context for the immediately preceding user message.
<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>
{{"chat_id":"wechat-new-item","message_id":"{message_id}"}}
<<<END_OPENCLAW_INTERNAL_CONTEXT>>>'''

        with patch.object(
            bhs,
            "product_draft_from_text",
            side_effect=[
                {"name": "新品苏打水", "stock": 10, "cost": 20, "unit": "箱"},
                {"price": 30},
            ],
        ):
            missing_response = self.client.post(
                "/api/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "messages": [
                        {"role": "user", "content": "今天进了新品苏打水货，10箱，进价20"},
                        {"role": "user", "content": runtime_context("new-1")},
                    ]
                },
            )
            missing_answer = missing_response.get_json()["choices"][0]["message"]["content"]
            self.assertIn("还缺：售价", missing_answer)
            self.assertNotIn("信息已完整", missing_answer)

            complete_response = self.client.post(
                "/api/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "messages": [
                        {"role": "user", "content": "售价30"},
                        {"role": "user", "content": runtime_context("new-2")},
                    ]
                },
            )
        complete_answer = complete_response.get_json()["choices"][0]["message"]["content"]
        self.assertIn("信息已完整", complete_answer)
        self.assertIn("确认添加", complete_answer)

        connection = bhs.sqlite3.connect(bhs.DATABASE)
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM products").fetchone()[0], 0)
        connection.close()

    def test_wechat_write_requires_authorized_chat_when_allowlist_is_configured(self):
        token = bhs.os.environ["BHS_CHANNEL_TOKEN"]
        runtime_context = '''OpenClaw runtime context for the immediately preceding user message.
<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>
{"chat_id":"wechat-unapproved","message_id":"blocked-1"}
<<<END_OPENCLAW_INTERNAL_CONTEXT>>>'''

        with patch.dict(
            bhs.os.environ,
            {"BHS_WECHAT_ALLOWED_CHAT_IDS": "wechat-approved"},
        ), patch.object(bhs, "product_draft_from_text") as parse_draft:
            response = self.client.post(
                "/api/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "messages": [
                        {"role": "user", "content": "今天进了测试牛奶货，10箱，进价20"},
                        {"role": "user", "content": runtime_context},
                    ]
                },
            )

        answer = response.get_json()["choices"][0]["message"]["content"]
        self.assertIn("没有商品或库存写入权限", answer)
        parse_draft.assert_not_called()
        connection = bhs.sqlite3.connect(bhs.DATABASE)
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM product_drafts").fetchone()[0], 0)
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM products").fetchone()[0], 0)
        connection.close()


if __name__ == "__main__":
    unittest.main()
