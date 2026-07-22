from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import shutil
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path
from typing import Any

import requests
import zxingcpp
from flask import (
    Flask,
    Response,
    abort,
    flash,
    g,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    stream_with_context,
    url_for,
)
from PIL import Image, ImageOps, UnidentifiedImageError
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.utils import secure_filename


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), value)


ROOT = Path(__file__).resolve().parent
load_env(ROOT / ".env")


def configured_path(name: str, default: Path) -> Path:
    configured = os.environ.get(name, "").strip()
    if not configured:
        return default
    path = Path(configured).expanduser()
    return path if path.is_absolute() else ROOT / path


DATA_DIR = configured_path("BHS_DATA_DIR", ROOT / "data")
UPLOAD_DIR = configured_path("BHS_UPLOAD_DIR", ROOT / "static" / "uploads")
DATABASE = configured_path("BHS_DATABASE", DATA_DIR / "bhs.db")
DATA_DIR.mkdir(parents=True, exist_ok=True)
DATABASE.parent.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)
HTTPS_ONLY = os.environ.get("BHS_HTTPS_ONLY", "").lower() in {"1", "true", "yes", "on"}
TRUST_PROXY_HEADERS = os.environ.get("BHS_TRUST_PROXY_HEADERS", "").lower() in {
    "1", "true", "yes", "on"
}
app.config.update(
    SECRET_KEY=os.environ.get("SECRET_KEY", secrets.token_hex(32)),
    MAX_CONTENT_LENGTH=10 * 1024 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=HTTPS_ONLY,
    PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
)
if TRUST_PROXY_HEADERS:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

ROLE_LABELS = {"boss": "Boss", "admin": "管理员", "staff": "员工"}
ALLOWED_IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp", "gif"}


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        connection = sqlite3.connect(DATABASE, timeout=15)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        g.db = connection
    return g.db


@app.teardown_appcontext
def close_db(_: BaseException | None) -> None:
    connection = g.pop("db", None)
    if connection is not None:
        connection.close()


def init_db() -> None:
    connection = sqlite3.connect(DATABASE)
    connection.executescript(
        """
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            display_name TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('boss', 'admin', 'staff')),
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            created_by INTEGER,
            last_login_at TEXT,
            FOREIGN KEY (created_by) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            sku TEXT,
            barcode TEXT,
            category TEXT,
            brand TEXT,
            specification TEXT,
            unit TEXT NOT NULL DEFAULT '件',
            stock REAL NOT NULL DEFAULT 0,
            low_stock REAL NOT NULL DEFAULT 5,
            cost REAL NOT NULL DEFAULT 0,
            price REAL NOT NULL DEFAULT 0,
            supplier TEXT,
            supplier_contact TEXT,
            location TEXT,
            expiry_date TEXT,
            notes TEXT,
            image_path TEXT,
            archived_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            created_by INTEGER,
            FOREIGN KEY (created_by) REFERENCES users(id)
        );

        CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
        CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
        CREATE INDEX IF NOT EXISTS idx_products_stock ON products(stock, low_stock);

        CREATE TABLE IF NOT EXISTS inventory_movements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER,
            product_name TEXT NOT NULL,
            change_amount REAL NOT NULL,
            before_stock REAL NOT NULL,
            after_stock REAL NOT NULL,
            reason TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'MANUAL',
            user_id INTEGER,
            created_at TEXT NOT NULL,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE INDEX IF NOT EXISTS idx_inventory_movements_product
        ON inventory_movements(product_id, id DESC);

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_key TEXT NOT NULL DEFAULT 'main',
            role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
            content TEXT NOT NULL,
            channel TEXT NOT NULL CHECK (channel IN ('WEB', 'WECHAT', 'SYSTEM')),
            user_id INTEGER,
            sender_name TEXT,
            external_id TEXT UNIQUE,
            created_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE INDEX IF NOT EXISTS idx_messages_conversation
        ON messages(conversation_key, id DESC);

        CREATE TABLE IF NOT EXISTS product_drafts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_key TEXT NOT NULL UNIQUE,
            fields_json TEXT NOT NULL DEFAULT '{}',
            image_path TEXT,
            source_channel TEXT NOT NULL DEFAULT 'WECHAT',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sales (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER,
            sale_date TEXT NOT NULL,
            quantity REAL NOT NULL DEFAULT 0,
            revenue REAL NOT NULL DEFAULT 0,
            cost_amount REAL NOT NULL DEFAULT 0,
            source TEXT NOT NULL DEFAULT 'IMPORT',
            external_id TEXT UNIQUE,
            created_at TEXT NOT NULL,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date);
        CREATE INDEX IF NOT EXISTS idx_sales_product_date ON sales(product_id, sale_date);

        CREATE TABLE IF NOT EXISTS ai_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            action_type TEXT NOT NULL,
            product_id INTEGER,
            payload_json TEXT NOT NULL,
            summary TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired')),
            created_at TEXT NOT NULL,
            confirmed_at TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            action TEXT NOT NULL,
            target_type TEXT,
            target_id INTEGER,
            detail TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS login_attempts (
            attempt_key TEXT PRIMARY KEY,
            failed_count INTEGER NOT NULL DEFAULT 0,
            window_started_at TEXT NOT NULL,
            locked_until TEXT
        );
        """
    )
    product_columns = {
        row[1] for row in connection.execute("PRAGMA table_info(products)").fetchall()
    }
    for column, definition in {
        "brand": "TEXT",
        "specification": "TEXT",
        "archived_at": "TEXT",
    }.items():
        if column not in product_columns:
            connection.execute(f"ALTER TABLE products ADD COLUMN {column} {definition}")
    boss_username = os.environ.get("BOSS_USERNAME", "Dongli").strip() or "Dongli"
    boss = connection.execute(
        "SELECT id, username FROM users WHERE role = 'boss' ORDER BY id LIMIT 1"
    ).fetchone()
    if boss and boss[1].casefold() != boss_username.casefold():
        connection.execute(
            "UPDATE users SET username = ?, display_name = ? WHERE id = ?",
            (boss_username, boss_username, boss[0]),
        )
    if not boss:
        boss_password = os.environ.get("BOSS_INITIAL_PASSWORD")
        if not boss_password:
            raise RuntimeError("首次启动前必须配置 BOSS_INITIAL_PASSWORD。")
        connection.execute(
            """INSERT OR IGNORE INTO users
               (username, password_hash, display_name, role, active, created_at)
               VALUES (?, ?, ?, 'boss', 1, ?)""",
            (
                boss_username,
                generate_password_hash(boss_password, method="scrypt"),
                boss_username,
                now_iso(),
            ),
        )
    connection.commit()
    connection.close()


def audit(action: str, target_type: str = "", target_id: int | None = None, detail: str = "") -> None:
    get_db().execute(
        """INSERT INTO audit_logs
           (user_id, action, target_type, target_id, detail, created_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (session.get("user_id"), action, target_type, target_id, detail[:500], now_iso()),
    )


def record_inventory_movement(
    product_id: int,
    product_name: str,
    before_stock: float,
    after_stock: float,
    reason: str,
    source: str,
    user_id: int | None = None,
) -> None:
    change = round(float(after_stock) - float(before_stock), 2)
    if not change:
        return
    get_db().execute(
        """INSERT INTO inventory_movements
           (product_id, product_name, change_amount, before_stock, after_stock,
            reason, source, user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            product_id,
            product_name[:100],
            change,
            before_stock,
            after_stock,
            reason[:200],
            source[:30],
            user_id if user_id is not None else session.get("user_id"),
            now_iso(),
        ),
    )


@app.before_request
def load_user_and_csrf() -> None:
    g.user = None
    user_id = session.get("user_id")
    if user_id:
        g.user = get_db().execute(
            "SELECT * FROM users WHERE id = ? AND active = 1", (user_id,)
        ).fetchone()
        if g.user is None:
            session.clear()

    if request.endpoint == "healthz":
        return

    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_urlsafe(24)

    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        if request.path.startswith("/api/openai/") or request.path.startswith("/api/channel/"):
            return
        supplied = request.form.get("_csrf") or request.headers.get("X-CSRF-Token", "")
        expected = session.get("csrf_token", "")
        if not supplied or not hmac.compare_digest(supplied, expected):
            abort(400, "请求已过期，请刷新页面后重试。")


@app.context_processor
def template_context() -> dict[str, Any]:
    return {
        "current_user": g.get("user"),
        "csrf_token": session.get("csrf_token"),
        "role_labels": ROLE_LABELS,
    }


@app.after_request
def add_security_headers(response: Response) -> Response:
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(self), microphone=(self)")
    if HTTPS_ONLY:
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000")
    if request.endpoint != "static" and (g.get("user") or request.path.startswith("/api/")):
        response.headers.setdefault("Cache-Control", "no-store")
    return response


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if g.user is None:
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)

    return wrapped


def roles_required(*roles: str):
    def decorator(view):
        @wraps(view)
        @login_required
        def wrapped(*args, **kwargs):
            if g.user["role"] not in roles:
                abort(403)
            return view(*args, **kwargs)

        return wrapped

    return decorator


def channel_authorized() -> bool:
    configured = os.environ.get("BHS_CHANNEL_TOKEN", "")
    supplied = request.headers.get("Authorization", "")
    if supplied.lower().startswith("bearer "):
        supplied = supplied[7:]
    return bool(configured and supplied and hmac.compare_digest(configured, supplied))


def login_attempt_key(username: str) -> str:
    client_ip = request.remote_addr or "unknown"
    raw = f"{client_ip}|{username.strip().lower()}|{app.config['SECRET_KEY']}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def login_is_limited(username: str) -> bool:
    row = get_db().execute(
        "SELECT * FROM login_attempts WHERE attempt_key = ?", (login_attempt_key(username),)
    ).fetchone()
    if not row or not row["locked_until"]:
        return False
    try:
        return datetime.fromisoformat(row["locked_until"]) > datetime.now(timezone.utc)
    except ValueError:
        return False


def register_login_failure(username: str) -> None:
    key = login_attempt_key(username)
    connection = get_db()
    row = connection.execute(
        "SELECT * FROM login_attempts WHERE attempt_key = ?", (key,)
    ).fetchone()
    now = datetime.now(timezone.utc)
    window_seconds = max(int(os.environ.get("BHS_LOGIN_WINDOW_SECONDS", "900")), 60)
    lock_seconds = max(int(os.environ.get("BHS_LOGIN_LOCK_SECONDS", "900")), 60)
    max_attempts = max(int(os.environ.get("BHS_LOGIN_MAX_ATTEMPTS", "8")), 3)
    count = 1
    window_started = now
    if row:
        try:
            previous_window = datetime.fromisoformat(row["window_started_at"])
        except ValueError:
            previous_window = now - timedelta(seconds=window_seconds + 1)
        if now - previous_window <= timedelta(seconds=window_seconds):
            count = int(row["failed_count"]) + 1
            window_started = previous_window
    locked_until = (
        (now + timedelta(seconds=lock_seconds)).replace(microsecond=0).isoformat()
        if count >= max_attempts else None
    )
    connection.execute(
        """INSERT INTO login_attempts
           (attempt_key, failed_count, window_started_at, locked_until)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(attempt_key) DO UPDATE SET
             failed_count = excluded.failed_count,
             window_started_at = excluded.window_started_at,
             locked_until = excluded.locked_until""",
        (key, count, window_started.replace(microsecond=0).isoformat(), locked_until),
    )
    connection.commit()


def clear_login_failures(username: str) -> None:
    get_db().execute(
        "DELETE FROM login_attempts WHERE attempt_key = ?", (login_attempt_key(username),)
    )
    get_db().commit()


def number(value: str | None, default: float = 0) -> float:
    try:
        return round(float(value or default), 2)
    except (TypeError, ValueError):
        return default


def save_image(files) -> str | None:
    upload = files.get("camera_photo") or files.get("gallery_photo") or files.get("photo")
    if not upload or not upload.filename:
        return None
    clean_name = secure_filename(upload.filename)
    extension = clean_name.rsplit(".", 1)[-1].lower() if "." in clean_name else ""
    if extension not in ALLOWED_IMAGE_EXTENSIONS:
        raise ValueError("仅支持 JPG、PNG、WEBP 或 GIF 图片。")
    filename = f"{uuid.uuid4().hex}.{extension}"
    upload.save(UPLOAD_DIR / filename)
    return f"uploads/{filename}"


def normalize_barcode(value: Any) -> str:
    code = re.sub(r"\s+", "", str(value or ""))
    if not re.fullmatch(r"[0-9A-Za-z._/-]{4,80}", code):
        return ""
    return code


def decode_barcode_upload(upload) -> str:
    if not upload or not upload.filename:
        raise ValueError("请拍摄或选择一张条码图片。")
    raw = upload.read(app.config["MAX_CONTENT_LENGTH"] + 1)
    if not raw or len(raw) > app.config["MAX_CONTENT_LENGTH"]:
        raise ValueError("条码图片不能超过 10MB。")
    try:
        image = Image.open(io.BytesIO(raw))
        image.load()
        image = ImageOps.exif_transpose(image)
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ValueError("无法读取这张图片，请重新拍摄。") from exc
    if image.width * image.height > 36_000_000:
        raise ValueError("图片尺寸过大，请重新拍摄。")
    if image.mode not in {"L", "RGB"}:
        image = image.convert("RGB")
    results = zxingcpp.read_barcodes(image, try_rotate=True, try_downscale=True)
    for result in results:
        code = normalize_barcode(result.text)
        if code:
            return code
    raise ValueError("没有识别到条码，请让条码占满画面并保持清晰。")


def lookup_barcode_product(code: str) -> dict[str, Any]:
    code = normalize_barcode(code)
    if not code:
        raise ValueError("条码格式不正确。")
    existing = get_db().execute(
        """SELECT id, name, brand, specification, category, barcode, image_path
           FROM products WHERE barcode = ? AND archived_at IS NULL LIMIT 1""",
        (code,),
    ).fetchone()
    if existing:
        return {
            "barcode": code,
            "found": True,
            "exists": True,
            "product": dict(existing),
            "detail_url": url_for("product_detail", product_id=existing["id"]),
        }

    result: dict[str, Any] = {
        "barcode": code,
        "found": False,
        "exists": False,
        "product": {"barcode": code},
        "new_url": url_for("product_new", barcode=code),
    }
    if not code.isdigit() or len(code) not in {8, 12, 13, 14}:
        return result
    fields = ",".join(
        [
            "code",
            "product_name",
            "product_name_zh",
            "brands",
            "quantity",
            "categories",
            "image_front_url",
        ]
    )
    try:
        response = requests.get(
            f"https://world.openfoodfacts.org/api/v3/product/{code}.json",
            params={"fields": fields, "product_type": "all"},
            headers={"User-Agent": "BHS-Market/1.0 (local supermarket inventory system)"},
            timeout=(5, 12),
        )
        data = response.json() if response.ok else {}
    except (requests.RequestException, ValueError):
        return result
    product = data.get("product") if isinstance(data, dict) else None
    if not isinstance(product, dict):
        return result
    name = str(product.get("product_name_zh") or product.get("product_name") or "").strip()
    brand = str(product.get("brands") or "").split(",")[0].strip()
    specification = str(product.get("quantity") or "").strip()
    category = str(product.get("categories") or "").split(",")[0].strip()
    image_url = str(product.get("image_front_url") or "").strip()
    cleaned = {
        "barcode": code,
        "name": name[:100],
        "brand": brand[:100],
        "specification": specification[:100],
        "category": category[:80],
        "catalog_image_url": image_url if image_url.startswith("https://") else "",
    }
    result.update(
        {
            "found": bool(name or brand),
            "product": cleaned,
            "new_url": url_for("product_new", barcode=code),
        }
    )
    return result


def remove_image(image_path: str | None) -> None:
    if not image_path:
        return
    target = (ROOT / "static" / image_path).resolve()
    if target.parent == UPLOAD_DIR.resolve() and target.exists():
        target.unlink()


def insert_message(
    role: str,
    content: str,
    channel: str,
    sender_name: str,
    user_id: int | None = None,
    external_id: str | None = None,
) -> int:
    cursor = get_db().execute(
        """INSERT OR IGNORE INTO messages
           (conversation_key, role, content, channel, user_id, sender_name, external_id, created_at)
           VALUES ('main', ?, ?, ?, ?, ?, ?, ?)""",
        (role, content.strip(), channel, user_id, sender_name, external_id, now_iso()),
    )
    get_db().commit()
    return cursor.lastrowid or 0


def business_context() -> str:
    connection = get_db()
    today = datetime.now(timezone.utc).date().isoformat()
    totals = connection.execute(
        """SELECT COUNT(*) AS product_count,
                  COALESCE(SUM(stock), 0) AS total_stock,
                  COALESCE(SUM(stock * cost), 0) AS inventory_cost,
                  COALESCE(SUM(stock * price), 0) AS inventory_retail,
                  COALESCE(SUM(CASE WHEN stock <= low_stock THEN 1 ELSE 0 END), 0) AS low_count
           FROM products WHERE archived_at IS NULL"""
    ).fetchone()
    sales = connection.execute(
        """SELECT COALESCE(SUM(CASE WHEN sale_date = ? THEN revenue ELSE 0 END), 0) AS today_revenue,
                  COALESCE(SUM(CASE WHEN sale_date = ? THEN revenue - cost_amount ELSE 0 END), 0) AS today_profit,
                  COALESCE(SUM(CASE WHEN sale_date >= date(?, '-6 days') THEN revenue ELSE 0 END), 0) AS week_revenue,
                  COALESCE(SUM(CASE WHEN sale_date >= date(?, '-29 days') THEN revenue ELSE 0 END), 0) AS month_revenue
           FROM sales""",
        (today, today, today, today),
    ).fetchone()
    products = connection.execute(
        """SELECT id, name, sku, barcode, category, brand, specification, unit, stock, low_stock,
                  cost, price, supplier, supplier_contact, location, expiry_date, archived_at
           FROM products ORDER BY archived_at IS NOT NULL, updated_at DESC LIMIT 300"""
    ).fetchall()
    product_lines = [
        " | ".join(
            [
                f"ID:{row['id']}",
                f"名称:{row['name']}",
                f"状态:{'已停用' if row['archived_at'] else '在售'}",
                f"SKU:{row['sku'] or '-'}",
                f"条码:{row['barcode'] or '-'}",
                f"分类:{row['category'] or '-'}",
                f"品牌:{row['brand'] or '-'}",
                f"规格:{row['specification'] or '-'}",
                f"库存:{row['stock']:g}{row['unit']}",
                f"预警:{row['low_stock']:g}",
                f"进价:{row['cost']:.2f}",
                f"售价:{row['price']:.2f}",
                f"供应商:{row['supplier'] or '-'}",
                f"联系方式:{row['supplier_contact'] or '-'}",
                f"货位:{row['location'] or '-'}",
                f"保质期:{row['expiry_date'] or '-'}",
            ]
        )
        for row in products
    ]
    return (
        "你是 BHS 超市的经营管家。只根据下面的实时业务数据回答，语言简洁、直接。"
        "没有的数据明确说系统里暂无记录，不要编造。涉及修改时只能提出待确认方案，不能声称已经执行。\n"
        f"商品数:{totals['product_count']}；库存总量:{totals['total_stock']:g}；"
        f"库存成本:{totals['inventory_cost']:.2f}；库存零售额:{totals['inventory_retail']:.2f}；"
        f"低库存商品:{totals['low_count']}；今日销售额:{sales['today_revenue']:.2f}；"
        f"今日毛利:{sales['today_profit']:.2f}；近7日销售额:{sales['week_revenue']:.2f}；"
        f"近30日销售额:{sales['month_revenue']:.2f}。\n"
        "商品明细：\n" + ("\n".join(product_lines) if product_lines else "暂无商品。")
    )


def text_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if not isinstance(item, dict):
                continue
            value = item.get("text") or item.get("content")
            if item.get("type") in {"text", "input_text", "output_text"} and isinstance(value, str):
                parts.append(value)
        return "\n".join(parts)
    return ""


OPENCLAW_INTERNAL_PREFIX = (
    "OpenClaw runtime context for the immediately preceding user message."
)


def is_openclaw_internal_message(content: str) -> bool:
    stripped = content.lstrip()
    return stripped.startswith(OPENCLAW_INTERNAL_PREFIX) or (
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>" in stripped
        and "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>" in stripped
    )


def visible_user_turn(messages: list[dict[str, Any]]) -> dict[str, Any] | None:
    for message in reversed(messages):
        if message.get("role") != "user":
            continue
        content = text_content(message.get("content")).strip()
        if not is_openclaw_internal_message(content):
            return message
    return None


def visible_user_message(messages: list[dict[str, Any]]) -> str:
    message = visible_user_turn(messages)
    return text_content(message.get("content")).strip() if message else ""


def openclaw_external_id(messages: list[dict[str, Any]]) -> str | None:
    for message in reversed(messages):
        content = text_content(message.get("content"))
        if not is_openclaw_internal_message(content):
            continue
        match = re.search(r'"message_id"\s*:\s*"([^"\\]{1,240})"', content)
        if match:
            return match.group(1)
    return None


def openclaw_chat_id(messages: list[dict[str, Any]]) -> str | None:
    for message in reversed(messages):
        content = text_content(message.get("content"))
        if not is_openclaw_internal_message(content):
            continue
        match = re.search(r'"chat_id"\s*:\s*"([^"\\]{1,240})"', content)
        if match:
            return match.group(1)
    return None


def openai_image_references(messages: list[dict[str, Any]]) -> list[str]:
    references: list[str] = []
    for message in messages:
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for item in content:
            if not isinstance(item, dict) or item.get("type") not in {
                "image_url",
                "input_image",
                "image",
            }:
                continue
            value = item.get("image_url") or item.get("url") or item.get("source")
            if isinstance(value, dict):
                value = value.get("url") or value.get("data")
            if isinstance(value, str) and value.strip():
                references.append(value.strip())
    return references


def save_openai_image(messages: list[dict[str, Any]]) -> str | None:
    references = openai_image_references(messages)
    if not references:
        return None
    reference = references[-1]
    extension = ""
    image_bytes: bytes | None = None
    source_path: Path | None = None

    data_match = re.fullmatch(
        r"data:image/(jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/=\s]+)",
        reference,
        re.IGNORECASE,
    )
    if data_match:
        extension = "jpg" if data_match.group(1).lower() in {"jpeg", "jpg"} else data_match.group(1).lower()
        try:
            image_bytes = base64.b64decode(data_match.group(2), validate=True)
        except (ValueError, TypeError):
            return None
        if not image_bytes or len(image_bytes) > app.config["MAX_CONTENT_LENGTH"]:
            return None
    else:
        raw_path = reference[7:] if reference.startswith("file://") else reference
        if raw_path.startswith("/home/node/.openclaw/"):
            relative = raw_path.removeprefix("/home/node/.openclaw/")
            source_path = (ROOT / "openclaw" / "config" / relative).resolve()
        elif raw_path.startswith(str(ROOT / "openclaw" / "config")):
            source_path = Path(raw_path).resolve()
        if source_path is None:
            return None
        allowed_root = (ROOT / "openclaw" / "config").resolve()
        if allowed_root not in source_path.parents or not source_path.is_file():
            return None
        extension = source_path.suffix.lower().lstrip(".")
        if extension not in ALLOWED_IMAGE_EXTENSIONS or source_path.stat().st_size > app.config["MAX_CONTENT_LENGTH"]:
            return None

    filename = f"{uuid.uuid4().hex}.{extension}"
    target = UPLOAD_DIR / filename
    if image_bytes is not None:
        target.write_bytes(image_bytes)
    elif source_path is not None:
        shutil.copyfile(source_path, target)
    return f"uploads/{filename}"


def deepseek_payload(messages: list[dict[str, Any]], requested: dict[str, Any] | None = None) -> dict[str, Any]:
    requested = requested or {}
    clean_messages = []
    for message in messages[-30:]:
        role = message.get("role")
        content = text_content(message.get("content"))
        if (
            role in {"user", "assistant", "system"}
            and content.strip()
            and not is_openclaw_internal_message(content)
        ):
            clean_messages.append({"role": role, "content": content[:12000]})
    return {
        "model": os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        "messages": [{"role": "system", "content": business_context()}] + clean_messages,
        "temperature": 0.2,
        "max_tokens": min(int(requested.get("max_tokens") or 1400), 4000),
        "thinking": {"type": "disabled"},
        "stream": bool(requested.get("stream", False)),
    }


def deepseek_request(payload: dict[str, Any], stream: bool = False):
    api_key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not api_key:
        raise RuntimeError("DeepSeek API 密钥尚未配置。")
    base_url = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
    return requests.post(
        f"{base_url}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        timeout=(10, 120),
        stream=stream,
    )


def call_deepseek(messages: list[dict[str, Any]]) -> tuple[str, dict[str, Any]]:
    payload = deepseek_payload(messages)
    try:
        response = deepseek_request(payload)
    except requests.RequestException as exc:
        raise RuntimeError("AI 服务网络连接失败，请稍后重试。") from exc
    try:
        data = response.json()
    except ValueError:
        data = {}
    if not response.ok:
        error = data.get("error", {}) if isinstance(data, dict) else {}
        detail = error.get("message") if isinstance(error, dict) else ""
        raise RuntimeError(f"AI 服务暂时不可用（{response.status_code}）{('：' + detail[:160]) if detail else ''}")
    try:
        answer = data["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError, AttributeError) as exc:
        raise RuntimeError("AI 服务返回了无法识别的结果。") from exc
    return answer, data


PRODUCT_DRAFT_TEXT_FIELDS = {
    "name": 100,
    "sku": 80,
    "barcode": 80,
    "category": 80,
    "brand": 100,
    "specification": 100,
    "unit": 20,
    "supplier": 120,
    "supplier_contact": 120,
    "location": 120,
    "expiry_date": 20,
    "notes": 2000,
}
PRODUCT_DRAFT_NUMBER_FIELDS = {"stock", "low_stock", "cost", "price"}


def product_draft_from_text(description: str) -> dict[str, Any]:
    schema = {
        "name": None,
        "sku": None,
        "barcode": None,
        "category": None,
        "brand": None,
        "specification": None,
        "unit": None,
        "stock": None,
        "low_stock": None,
        "cost": None,
        "price": None,
        "supplier": None,
        "supplier_contact": None,
        "location": None,
        "expiry_date": None,
        "notes": None,
    }
    payload = {
        "model": os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        "messages": [
            {
                "role": "system",
                "content": (
                    "你负责把超市员工的口述整理为商品资料。必须输出一个 json 对象，"
                    "字段与给定模板完全一致。没有明确提到的信息使用 null，绝不猜测价格、库存、"
                    "条码、日期或联系方式。金额只输出数字；日期格式为 YYYY-MM-DD；"
                    "保留员工口述中的规格信息。员工说进货、到货或入库时，stock 表示本次到货数量，"
                    "不是入库后的总库存。json 模板：" + json.dumps(schema, ensure_ascii=False)
                ),
            },
            {
                "role": "user",
                "content": f"请将下面内容整理为商品资料并输出 json：\n{description[:3000]}",
            },
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0,
        "max_tokens": 1000,
        "thinking": {"type": "disabled"},
        "stream": False,
    }
    try:
        response = deepseek_request(payload)
        data = response.json()
    except (requests.RequestException, ValueError) as exc:
        raise RuntimeError("AI 整理暂时不可用，请稍后重试。") from exc
    if not response.ok:
        raise RuntimeError("AI 整理暂时不可用，请稍后重试。")
    try:
        content = data["choices"][0]["message"]["content"].strip()
        raw_draft = json.loads(content)
    except (KeyError, IndexError, TypeError, AttributeError, json.JSONDecodeError) as exc:
        raise RuntimeError("AI 没有正确整理这段信息，请换一种说法。") from exc
    if not isinstance(raw_draft, dict):
        raise RuntimeError("AI 没有正确整理这段信息，请换一种说法。")

    draft: dict[str, Any] = {}
    for field, limit in PRODUCT_DRAFT_TEXT_FIELDS.items():
        value = raw_draft.get(field)
        if value is not None and str(value).strip():
            cleaned = str(value).strip()[:limit]
            if field != "expiry_date" or re.fullmatch(r"\d{4}-\d{2}-\d{2}", cleaned):
                draft[field] = cleaned
    for field in PRODUCT_DRAFT_NUMBER_FIELDS:
        value = raw_draft.get(field)
        if value is None or value == "":
            continue
        try:
            draft[field] = max(round(float(value), 2), 0)
        except (TypeError, ValueError):
            continue
    return draft


AI_EDITABLE_TEXT_FIELDS = {
    "name", "sku", "barcode", "category", "brand", "specification", "unit",
    "supplier", "supplier_contact", "location", "expiry_date", "notes",
}
AI_EDITABLE_NUMBER_FIELDS = {"stock", "low_stock", "cost", "price"}
AI_FIELD_LABELS = {
    "name": "名称", "sku": "SKU", "barcode": "条码", "category": "分类",
    "brand": "品牌", "specification": "规格", "unit": "单位", "stock": "库存",
    "low_stock": "预警库存", "cost": "进价", "price": "售价", "supplier": "供应商",
    "supplier_contact": "联系方式", "location": "货位", "expiry_date": "到期日期",
    "notes": "备注",
}


def create_ai_action(raw_action: Any) -> dict[str, Any] | None:
    if not isinstance(raw_action, dict):
        return None
    action_type = str(raw_action.get("type", "")).strip()
    if action_type == "delete_product":
        action_type = "archive_product"
    connection = get_db()
    product_id: int | None = None
    payload: dict[str, Any] = {}
    summary = ""

    if action_type in {"update_product", "adjust_stock", "archive_product", "purge_product"}:
        try:
            product_id = int(raw_action.get("product_id"))
        except (TypeError, ValueError):
            return None
        product = connection.execute(
            "SELECT id, name, stock FROM products WHERE id = ?", (product_id,)
        ).fetchone()
        if not product:
            return None
    else:
        product = None

    if action_type in {"create_product", "update_product"}:
        raw_fields = raw_action.get("fields")
        if not isinstance(raw_fields, dict):
            return None
        for field in AI_EDITABLE_TEXT_FIELDS:
            value = raw_fields.get(field)
            if value is None:
                continue
            limit = PRODUCT_DRAFT_TEXT_FIELDS.get(field, 120)
            cleaned = str(value).strip()[:limit]
            if field == "expiry_date" and cleaned and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", cleaned):
                continue
            payload[field] = cleaned
        for field in AI_EDITABLE_NUMBER_FIELDS:
            value = raw_fields.get(field)
            if value is None or value == "":
                continue
            try:
                payload[field] = max(round(float(value), 2), 0)
            except (TypeError, ValueError):
                continue
        if action_type == "create_product":
            if not payload.get("name"):
                return None
            payload.setdefault("unit", "件")
            payload.setdefault("stock", 0)
            payload.setdefault("low_stock", 5)
            payload.setdefault("cost", 0)
            payload.setdefault("price", 0)
            summary = f"新增商品：{payload['name']}"
        else:
            if not payload:
                return None
            details = "、".join(
                f"{AI_FIELD_LABELS.get(key, key)}改为 {value}" for key, value in payload.items()
            )
            summary = f"更新 {product['name']}：{details}"
    elif action_type == "adjust_stock":
        try:
            delta = round(float(raw_action.get("delta")), 2)
        except (TypeError, ValueError):
            return None
        if not delta:
            return None
        payload = {"delta": delta}
        sign = "+" if delta > 0 else ""
        summary = f"调整 {product['name']} 库存：{sign}{delta:g}"
    elif action_type == "archive_product":
        if g.user["role"] not in {"boss", "admin"}:
            return None
        payload = {"name": product["name"]}
        summary = f"停用商品：{product['name']}（保留历史数据）"
    elif action_type == "purge_product":
        if g.user["role"] not in {"boss", "admin"}:
            return None
        payload = {"name": product["name"]}
        summary = f"永久删除商品：{product['name']}（不可恢复）"
    else:
        return None

    cursor = connection.execute(
        """INSERT INTO ai_actions
           (user_id, action_type, product_id, payload_json, summary, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)""",
        (
            g.user["id"], action_type, product_id,
            json.dumps(payload, ensure_ascii=False), summary[:500], now_iso(),
        ),
    )
    connection.commit()
    return {"id": cursor.lastrowid, "type": action_type, "summary": summary}


def deterministic_product_action(content: str) -> tuple[str, dict[str, Any] | None] | None:
    """Handle destructive product intent without leaving target/action semantics to an LLM."""
    compact = re.sub(r"\s+", "", content)
    permanent = bool(
        re.search(r"(?:彻底|永久).{0,5}(?:删除|移除|清除)", compact)
        or re.search(r"(?:删除|移除|清除).{0,5}(?:彻底|永久)", compact)
    )
    destructive = permanent or bool(re.search(r"删除|删掉|移除|停用|下架", compact))
    if not destructive or not re.search(r"商品|货品|产品|删除|删掉|移除|停用|下架", compact):
        return None
    if g.user["role"] not in {"boss", "admin"}:
        return "当前账号没有停用或删除商品的权限。", None

    products = get_db().execute(
        "SELECT id, name, archived_at FROM products ORDER BY length(name) DESC, id DESC"
    ).fetchall()
    product = None
    id_match = re.search(r"(?:商品)?(?:ID|id|#)[：:]?(\d+)", content)
    if id_match:
        target_id = int(id_match.group(1))
        product = next((row for row in products if row["id"] == target_id), None)
    if product is None:
        product = next((row for row in products if row["name"] and row["name"] in content), None)
    if product is None and len(products) == 1:
        product = products[0]
    if product is None:
        action_name = "永久删除" if permanent else "停用"
        return f"可以{action_name}。请告诉我商品名称或 ID，我会生成待确认操作。", None

    if not permanent and product["archived_at"]:
        return f"{product['name']}已经停用。需要彻底移除时，请说“永久删除 {product['name']}”。", None
    action_type = "purge_product" if permanent else "archive_product"
    proposal = create_ai_action({"type": action_type, "product_id": product["id"]})
    if not proposal:
        return "没有生成操作，请确认商品是否仍然存在。", None
    return "我已生成待确认操作。请核对内容，确认后才会执行。", proposal


def ai_butler_response(history: list[dict[str, Any]]) -> tuple[str, dict[str, Any] | None]:
    payload = deepseek_payload(history)
    payload["messages"][0]["content"] += (
        "\n你正在网页经营管家中工作。必须只输出 JSON 对象，格式为："
        '{"reply":"给用户的简洁回答","action":null}。'
        "如果用户明确要求修改数据，可把 action 设为以下五种之一："
        '{"type":"adjust_stock","product_id":商品ID,"delta":增减数量}；'
        '{"type":"update_product","product_id":商品ID,"fields":{"price":数值等}}；'
        '{"type":"create_product","fields":{"name":"名称"等}}。'
        '{"type":"archive_product","product_id":商品ID}。用户说删除商品时使用 archive_product，停用后从在售列表隐藏但保留历史。'
        '{"type":"purge_product","product_id":商品ID}。仅当用户明确说永久删除或彻底删除时使用，且必须再次确认。'
        "fields 只允许商品数据中的已有字段。商品不明确、信息不足、只是分析查询时 action 必须为 null。"
        "绝不声称操作已经完成，只说明需要用户确认。"
    )
    payload["response_format"] = {"type": "json_object"}
    payload["temperature"] = 0
    payload["max_tokens"] = 1800
    try:
        response = deepseek_request(payload)
        data = response.json()
    except (requests.RequestException, ValueError) as exc:
        raise RuntimeError("AI 管家暂时不可用，请稍后重试。") from exc
    if not response.ok:
        raise RuntimeError("AI 管家暂时不可用，请稍后重试。")
    try:
        content = data["choices"][0]["message"]["content"].strip()
        result = json.loads(content)
        reply = str(result.get("reply", "")).strip()
    except (KeyError, IndexError, TypeError, AttributeError, json.JSONDecodeError) as exc:
        raise RuntimeError("AI 管家没有正确返回结果，请重试。") from exc
    if not reply:
        raise RuntimeError("AI 管家没有返回有效内容，请重试。")
    raw_action = result.get("action")
    proposal = create_ai_action(raw_action)
    if proposal:
        reply = "我已生成待确认操作。请核对内容，确认后才会执行。"
    elif isinstance(raw_action, dict) and raw_action.get("type") in {"delete_product", "archive_product", "purge_product"} and g.user["role"] not in {"boss", "admin"}:
        reply = "当前账号没有删除商品权限。"
    elif re.search(r"(?:已|已经)(?:确认)?(?:删除|执行|修改|新增|调整|完成)", reply):
        reply = "这项操作尚未执行。请重新说明目标，我会生成待确认操作。"
    return reply, proposal


def confirm_ai_action(action_id: int) -> tuple[str, int | None]:
    connection = get_db()
    action = connection.execute(
        "SELECT * FROM ai_actions WHERE id = ? AND user_id = ?",
        (action_id, g.user["id"]),
    ).fetchone()
    if not action or action["status"] != "pending":
        raise ValueError("这项操作已处理或不存在。")
    created_at = datetime.fromisoformat(action["created_at"])
    if datetime.now(timezone.utc) - created_at > timedelta(minutes=30):
        connection.execute("UPDATE ai_actions SET status = 'expired' WHERE id = ?", (action_id,))
        connection.commit()
        raise ValueError("这项操作已过期，请让 AI 重新生成。")
    payload = json.loads(action["payload_json"])
    product_id = action["product_id"]
    current = now_iso()

    if action["action_type"] == "create_product":
        fields = dict(payload)
        columns = ", ".join(fields.keys())
        placeholders = ", ".join("?" for _ in fields)
        cursor = connection.execute(
            f"""INSERT INTO products
                ({columns}, created_at, updated_at, created_by)
                VALUES ({placeholders}, ?, ?, ?)""",
            (*fields.values(), current, current, g.user["id"]),
        )
        product_id = cursor.lastrowid
        record_inventory_movement(
            product_id, fields["name"], 0, float(fields.get("stock", 0)),
            "AI 新增商品初始库存", "AI", g.user["id"],
        )
        audit("ai_create", "product", product_id, action["summary"])
    elif action["action_type"] == "update_product":
        product_before = connection.execute(
            "SELECT name, stock FROM products WHERE id = ?", (product_id,)
        ).fetchone()
        assignments = ", ".join(f"{field} = ?" for field in payload)
        connection.execute(
            f"UPDATE products SET {assignments}, updated_at = ? WHERE id = ?",
            (*payload.values(), current, product_id),
        )
        if product_before and "stock" in payload:
            record_inventory_movement(
                product_id,
                str(payload.get("name") or product_before["name"]),
                product_before["stock"],
                payload["stock"],
                "AI 修改商品库存",
                "AI",
                g.user["id"],
            )
        audit("ai_update", "product", product_id, action["summary"])
    elif action["action_type"] == "adjust_stock":
        product_before = connection.execute(
            "SELECT name, stock FROM products WHERE id = ?", (product_id,)
        ).fetchone()
        if not product_before:
            raise ValueError("商品已不存在。")
        after_stock = max(0, float(product_before["stock"]) + float(payload["delta"]))
        connection.execute(
            "UPDATE products SET stock = ?, updated_at = ? WHERE id = ?",
            (after_stock, current, product_id),
        )
        record_inventory_movement(
            product_id, product_before["name"], product_before["stock"], after_stock,
            "AI 调整库存", "AI", g.user["id"],
        )
        audit("ai_adjust_stock", "product", product_id, action["summary"])
    elif action["action_type"] == "archive_product":
        if g.user["role"] not in {"boss", "admin"}:
            raise ValueError("当前账号没有停用商品权限。")
        product = connection.execute(
            "SELECT name FROM products WHERE id = ? AND archived_at IS NULL", (product_id,)
        ).fetchone()
        if not product:
            raise ValueError("商品已停用或不存在。")
        connection.execute(
            "UPDATE products SET archived_at = ?, updated_at = ? WHERE id = ?",
            (current, current, product_id),
        )
        audit("ai_archive", "product", product_id, action["summary"])
    elif action["action_type"] == "purge_product":
        if g.user["role"] not in {"boss", "admin"}:
            raise ValueError("当前账号没有永久删除商品权限。")
        product = connection.execute(
            "SELECT name, image_path FROM products WHERE id = ?", (product_id,)
        ).fetchone()
        if not product:
            raise ValueError("商品已不存在。")
        image_path = product["image_path"]
        connection.execute("UPDATE ai_actions SET product_id = NULL WHERE product_id = ?", (product_id,))
        connection.execute("DELETE FROM products WHERE id = ?", (product_id,))
        audit("ai_purge", "product", product_id, action["summary"])
        product_id = None
    else:
        raise ValueError("不支持这项操作。")

    connection.execute(
        "UPDATE ai_actions SET status = 'confirmed', confirmed_at = ? WHERE id = ?",
        (current, action_id),
    )
    connection.commit()
    if action["action_type"] == "purge_product":
        remove_image(image_path)
    return action["summary"], product_id


def get_product_draft(conversation_key: str) -> sqlite3.Row | None:
    return get_db().execute(
        "SELECT * FROM product_drafts WHERE conversation_key = ?",
        (conversation_key,),
    ).fetchone()


def upsert_product_draft(
    conversation_key: str,
    fields: dict[str, Any] | None = None,
    image_path: str | None = None,
) -> sqlite3.Row:
    current = get_product_draft(conversation_key)
    merged_fields: dict[str, Any] = {}
    if current:
        try:
            saved_fields = json.loads(current["fields_json"])
            if isinstance(saved_fields, dict):
                merged_fields.update(saved_fields)
        except (TypeError, json.JSONDecodeError):
            pass
    if fields:
        merged_fields.update(fields)
    previous_image = current["image_path"] if current else None
    final_image = image_path or previous_image
    current_time = now_iso()
    get_db().execute(
        """INSERT INTO product_drafts
           (conversation_key, fields_json, image_path, source_channel, created_at, updated_at)
           VALUES (?, ?, ?, 'WECHAT', ?, ?)
           ON CONFLICT(conversation_key) DO UPDATE SET
             fields_json = excluded.fields_json,
             image_path = excluded.image_path,
             updated_at = excluded.updated_at""",
        (
            conversation_key,
            json.dumps(merged_fields, ensure_ascii=False),
            final_image,
            current["created_at"] if current else current_time,
            current_time,
        ),
    )
    get_db().commit()
    if image_path and previous_image and previous_image != image_path:
        remove_image(previous_image)
    return get_product_draft(conversation_key)


def draft_fields(row: sqlite3.Row) -> dict[str, Any]:
    try:
        value = json.loads(row["fields_json"])
    except (TypeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def draft_intent(row: sqlite3.Row) -> str:
    return str(draft_fields(row).get("_intent") or "create_product")


def missing_draft_fields(row: sqlite3.Row) -> list[str]:
    fields = draft_fields(row)
    missing: list[str] = []
    if draft_intent(row) == "stock_in":
        if not fields.get("_product_id"):
            missing.append("要入库的商品")
        if number(str(fields.get("stock") or 0)) <= 0:
            missing.append("本次到货数量")
        if number(str(fields.get("cost") or 0)) <= 0:
            missing.append("本次进价")
        return missing
    if not str(fields.get("name") or "").strip():
        missing.append("商品名称")
    if number(str(fields.get("stock") or 0)) <= 0:
        missing.append("初始库存")
    if number(str(fields.get("cost") or 0)) <= 0:
        missing.append("进价")
    if number(str(fields.get("price") or 0)) <= 0:
        missing.append("售价")
    return missing


def recommended_draft_fields(row: sqlite3.Row) -> list[str]:
    fields = draft_fields(row)
    recommended: list[str] = []
    if not fields.get("supplier"):
        recommended.append("供应商")
    identity = "".join(
        str(fields.get(key) or "") for key in ("name", "category", "specification")
    )
    if re.search(r"食品|饮料|牛奶|乳|酸奶|冷藏|生鲜|面包|熟食|肉|蛋", identity) and not fields.get("expiry_date"):
        recommended.append("到期日期")
    return recommended


def draft_confirmation_phrase(row: sqlite3.Row) -> str:
    return "确认入库" if draft_intent(row) == "stock_in" else "确认添加"


def format_product_draft(row: sqlite3.Row) -> str:
    fields = draft_fields(row)
    is_stock_in = draft_intent(row) == "stock_in"
    labels = [
        ("name", "名称"),
        ("brand", "品牌"),
        ("specification", "规格"),
        ("category", "分类"),
        ("unit", "单位"),
        ("stock", "本次入库" if is_stock_in else "初始库存"),
        ("low_stock", "预警库存"),
        ("cost", "进价"),
        ("price", "售价"),
        ("supplier", "供应商"),
        ("supplier_contact", "联系方式"),
        ("location", "货位"),
        ("expiry_date", "到期日期"),
        ("notes", "备注"),
    ]
    lines = [f"{label}：{fields[key]}" for key, label in labels if fields.get(key) not in {None, ""}]
    if is_stock_in and fields.get("_product_name"):
        lines.insert(0, f"匹配商品：{fields['_product_name']}")
    if row["image_path"]:
        lines.append("照片：已保存")
    title = "已整理入库单：" if is_stock_in else "已整理新商品："
    result = title + "\n" + ("\n".join(lines) or "暂无可用字段")
    missing = missing_draft_fields(row)
    if missing:
        result += "\n\n还缺：" + "、".join(missing) + "。请直接补充。"
        return result
    recommended = recommended_draft_fields(row)
    if recommended:
        result += "\n\n建议补充：" + "、".join(recommended) + "（不影响确认）。"
    return result + f"\n\n信息已完整，回复“{draft_confirmation_phrase(row)}”后执行。"


def create_product_from_draft(row: sqlite3.Row) -> int:
    fields = draft_fields(row)
    missing = missing_draft_fields(row)
    if missing:
        raise ValueError("暂不能添加，还缺：" + "、".join(missing) + "。")
    values = {
        "name": str(fields.get("name", ""))[:100],
        "sku": str(fields.get("sku") or "")[:80],
        "barcode": str(fields.get("barcode") or "")[:80],
        "category": str(fields.get("category") or "")[:80],
        "brand": str(fields.get("brand") or "")[:100],
        "specification": str(fields.get("specification") or "")[:100],
        "unit": str(fields.get("unit") or "件")[:20],
        "stock": max(number(str(fields.get("stock") or 0)), 0),
        "low_stock": max(number(str(fields.get("low_stock") or 5), 5), 0),
        "cost": max(number(str(fields.get("cost") or 0)), 0),
        "price": max(number(str(fields.get("price") or 0)), 0),
        "supplier": str(fields.get("supplier") or "")[:120],
        "supplier_contact": str(fields.get("supplier_contact") or "")[:120],
        "location": str(fields.get("location") or "")[:120],
        "expiry_date": str(fields.get("expiry_date") or "")[:20],
        "notes": str(fields.get("notes") or "")[:2000],
    }
    current = now_iso()
    columns = ", ".join(values.keys())
    placeholders = ", ".join("?" for _ in values)
    cursor = get_db().execute(
        f"""INSERT INTO products
            ({columns}, image_path, created_at, updated_at, created_by)
            VALUES ({placeholders}, ?, ?, ?, NULL)""",
        (*values.values(), row["image_path"], current, current),
    )
    record_inventory_movement(
        cursor.lastrowid, values["name"], 0, values["stock"],
        "微信录入初始库存", "WECHAT", None,
    )
    get_db().execute("DELETE FROM product_drafts WHERE id = ?", (row["id"],))
    audit("create_wechat", "product", cursor.lastrowid, values["name"])
    get_db().commit()
    return cursor.lastrowid


def find_wechat_product(content: str, fields: dict[str, Any]) -> sqlite3.Row | None:
    connection = get_db()
    barcode = normalize_barcode(fields.get("barcode"))
    if barcode:
        product = connection.execute(
            "SELECT * FROM products WHERE barcode = ? AND archived_at IS NULL ORDER BY id DESC LIMIT 1",
            (barcode,),
        ).fetchone()
        if product:
            return product
    sku = str(fields.get("sku") or "").strip()
    if sku:
        product = connection.execute(
            "SELECT * FROM products WHERE sku = ? AND archived_at IS NULL ORDER BY id DESC LIMIT 1",
            (sku,),
        ).fetchone()
        if product:
            return product

    compact_content = re.sub(r"\s+", "", content).lower()
    parsed_name = re.sub(r"\s+", "", str(fields.get("name") or "")).lower()
    products = connection.execute(
        "SELECT * FROM products WHERE archived_at IS NULL ORDER BY length(name) DESC, id DESC"
    ).fetchall()
    exact = [
        product for product in products
        if parsed_name and re.sub(r"\s+", "", product["name"]).lower() == parsed_name
    ]
    if exact:
        return exact[0]
    return next(
        (
            product for product in products
            if re.sub(r"\s+", "", product["name"]).lower() in compact_content
        ),
        None,
    )


def wechat_product_intent(content: str) -> str | None:
    compact = re.sub(r"\s+", "", content)
    if not re.search(r"建议|分析|哪些|是否需要|要不要|怎么", compact):
        if (
            ("进了" in compact and "货" in compact)
            or re.search(r"进货|到货|已入库|入库了|收货了|采购了|补了.{0,40}货", compact)
        ):
            return "stock_in"
    if any(word in compact for word in ("添加商品", "新增商品", "录入商品", "商品建档")):
        return "create_product"
    return None


def wechat_write_authorized(conversation_key: str) -> bool:
    configured = os.environ.get("BHS_WECHAT_ALLOWED_CHAT_IDS", "").strip()
    if not configured:
        return True
    allowed = {value.strip() for value in configured.split(",") if value.strip()}
    return conversation_key in allowed


def receive_stock_from_draft(row: sqlite3.Row) -> tuple[int, float, float, float]:
    fields = draft_fields(row)
    missing = missing_draft_fields(row)
    if missing:
        raise ValueError("暂不能入库，还缺：" + "、".join(missing) + "。")
    product_id = int(fields["_product_id"])
    connection = get_db()
    product = connection.execute(
        "SELECT * FROM products WHERE id = ? AND archived_at IS NULL", (product_id,)
    ).fetchone()
    if not product:
        raise ValueError("匹配的商品已停用或不存在，请重新说明商品名称。")
    quantity = number(str(fields["stock"]))
    inbound_cost = number(str(fields["cost"]))
    before_stock = float(product["stock"])
    after_stock = round(before_stock + quantity, 2)
    previous_value = max(before_stock, 0) * max(float(product["cost"]), 0)
    weighted_cost = round((previous_value + quantity * inbound_cost) / after_stock, 2)
    updates: dict[str, Any] = {
        "stock": after_stock,
        "cost": weighted_cost,
        "updated_at": now_iso(),
    }
    for field in ("supplier", "supplier_contact", "location"):
        if fields.get(field):
            updates[field] = str(fields[field])[:PRODUCT_DRAFT_TEXT_FIELDS[field]]
    if fields.get("price"):
        updates["price"] = number(str(fields["price"]))
    incoming_expiry = str(fields.get("expiry_date") or "")
    current_expiry = str(product["expiry_date"] or "")
    if incoming_expiry and re.fullmatch(r"\d{4}-\d{2}-\d{2}", incoming_expiry):
        updates["expiry_date"] = min(value for value in (incoming_expiry, current_expiry) if value)
    assignments = ", ".join(f"{field} = ?" for field in updates)
    connection.execute(
        f"UPDATE products SET {assignments} WHERE id = ?",
        (*updates.values(), product_id),
    )
    reason_parts = [f"微信入库，进价 ¥{inbound_cost:g}"]
    if fields.get("supplier"):
        reason_parts.append(f"供应商 {str(fields['supplier'])[:80]}")
    record_inventory_movement(
        product_id,
        product["name"],
        before_stock,
        after_stock,
        "；".join(reason_parts),
        "WECHAT",
        None,
    )
    connection.execute("DELETE FROM product_drafts WHERE id = ?", (row["id"],))
    audit("stock_in_wechat", "product", product_id, "；".join(reason_parts))
    connection.commit()
    return product_id, before_stock, after_stock, weighted_cost


def handle_wechat_product_flow(
    conversation_key: str,
    content: str,
    image_path: str | None,
) -> str | None:
    current = get_product_draft(conversation_key)
    normalized = re.sub(r"[\s，。！？,.!?]", "", content).lower()
    if not wechat_write_authorized(conversation_key):
        if image_path:
            remove_image(image_path)
        if image_path or current or wechat_product_intent(content):
            return "此微信会话没有商品或库存写入权限。请让 Boss 在 BHS 中授权。"
        return None
    if image_path:
        upsert_product_draft(conversation_key, image_path=image_path)
        return "商品照片已收到。请继续发送语音或文字，告诉我名称、进价、售价、库存、供应商等信息。"
    if not current:
        intent = wechat_product_intent(content)
        if not intent:
            return None
        fields = product_draft_from_text(content)
        if intent == "stock_in":
            product = find_wechat_product(content, fields)
            if product:
                fields.update(
                    {
                        "_intent": "stock_in",
                        "_product_id": product["id"],
                        "_product_name": product["name"],
                    }
                )
            else:
                fields["_intent"] = "create_product"
                fields["_started_as_stock_in"] = True
        else:
            fields["_intent"] = "create_product"
        current = upsert_product_draft(conversation_key, fields=fields)
        return format_product_draft(current)
    if normalized in {"取消", "取消添加", "取消录入", "放弃"}:
        if current["image_path"]:
            remove_image(current["image_path"])
        get_db().execute("DELETE FROM product_drafts WHERE id = ?", (current["id"],))
        get_db().commit()
        return "已取消这次商品录入。"
    if normalized in {"确认", "确认添加", "确认入库", "保存", "保存商品"}:
        missing = missing_draft_fields(current)
        if missing:
            return "暂不能执行，还缺：" + "、".join(missing) + "。请直接补充。"
        if draft_intent(current) == "stock_in":
            try:
                _, before_stock, after_stock, weighted_cost = receive_stock_from_draft(current)
            except ValueError as exc:
                return str(exc)
            fields = draft_fields(current)
            return (
                f"已入库：{fields['_product_name']}，库存 {before_stock:g} → {after_stock:g}，"
                f"当前加权进价 ¥{weighted_cost:.2f}。网页库存与流水已同步。"
            )
        try:
            product_id = create_product_from_draft(current)
        except ValueError as exc:
            return str(exc)
        fields = draft_fields(current)
        return f"商品“{fields['name']}”已添加，编号 {product_id}。网页商品列表已同步更新。"
    fields = product_draft_from_text(content)
    current = upsert_product_draft(conversation_key, fields=fields)
    saved_fields = draft_fields(current)
    if saved_fields.get("_started_as_stock_in") and draft_intent(current) != "stock_in":
        product = find_wechat_product(content, saved_fields)
        if product:
            current = upsert_product_draft(
                conversation_key,
                fields={
                    "_intent": "stock_in",
                    "_product_id": product["id"],
                    "_product_name": product["name"],
                },
            )
    return format_product_draft(current)


@app.get("/login")
def login():
    if g.user:
        return redirect(url_for("dashboard"))
    return render_template("login.html", title="登录")


@app.post("/login")
def login_post():
    username = request.form.get("username", "").strip()
    password = request.form.get("password", "")
    if login_is_limited(username):
        flash("登录尝试过多，请 15 分钟后再试。", "error")
        return render_template("login.html", title="登录"), 429
    user = get_db().execute(
        "SELECT * FROM users WHERE username = ? COLLATE NOCASE", (username,)
    ).fetchone()
    if not user or not user["active"] or not check_password_hash(user["password_hash"], password):
        register_login_failure(username)
        flash("账号或密码不正确。", "error")
        return render_template("login.html", title="登录"), 401
    clear_login_failures(username)
    session.clear()
    session.permanent = True
    session["user_id"] = user["id"]
    session["csrf_token"] = secrets.token_urlsafe(24)
    get_db().execute("UPDATE users SET last_login_at = ? WHERE id = ?", (now_iso(), user["id"]))
    audit("login", "user", user["id"])
    get_db().commit()
    return redirect(url_for("dashboard"))


@app.get("/healthz")
def healthz():
    try:
        get_db().execute("SELECT 1").fetchone()
    except sqlite3.Error:
        return jsonify({"ok": False}), 503
    return jsonify({"ok": True, "service": "BHS"})


@app.post("/logout")
@login_required
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.get("/")
@login_required
def dashboard():
    connection = get_db()
    today = datetime.now(timezone.utc).date()
    today_text = today.isoformat()
    inventory = connection.execute(
        """SELECT COUNT(*) AS products,
                  COALESCE(SUM(stock), 0) AS stock,
                  COALESCE(SUM(stock * cost), 0) AS cost_value,
                  COALESCE(SUM(stock * price), 0) AS retail_value,
                  COALESCE(SUM(CASE WHEN stock <= low_stock THEN 1 ELSE 0 END), 0) AS low_count,
                  COALESCE(SUM(CASE WHEN stock <= 0 THEN 1 ELSE 0 END), 0) AS out_count,
                  COALESCE(SUM(CASE WHEN cost <= 0 OR price <= 0 THEN 1 ELSE 0 END), 0) AS missing_price_count,
                  COALESCE(SUM(CASE WHEN price > 0 AND price < cost THEN 1 ELSE 0 END), 0) AS negative_margin_count,
                  COALESCE(SUM(CASE WHEN expiry_date <> '' AND date(expiry_date) BETWEEN date(?) AND date(?, '+30 days') THEN 1 ELSE 0 END), 0) AS expiring_count
           FROM products WHERE archived_at IS NULL""",
        (today_text, today_text),
    ).fetchone()
    sales = connection.execute(
        """SELECT COUNT(*) AS records,
                  COALESCE(SUM(CASE WHEN sale_date = ? THEN revenue ELSE 0 END), 0) AS today_revenue,
                  COALESCE(SUM(CASE WHEN sale_date = ? THEN cost_amount ELSE 0 END), 0) AS today_cost,
                  COALESCE(SUM(CASE WHEN sale_date >= date(?, '-6 days') THEN revenue ELSE 0 END), 0) AS week_revenue,
                  COALESCE(SUM(CASE WHEN sale_date >= date(?, '-29 days') THEN revenue ELSE 0 END), 0) AS month_revenue
           FROM sales""",
        (today_text, today_text, today_text, today_text),
    ).fetchone()
    sales_by_day = {
        row["sale_date"]: float(row["revenue"])
        for row in connection.execute(
            """SELECT sale_date, COALESCE(SUM(revenue), 0) AS revenue
               FROM sales WHERE sale_date >= date(?, '-6 days')
               GROUP BY sale_date ORDER BY sale_date""",
            (today_text,),
        ).fetchall()
    }
    sales_trend = []
    for offset in range(6, -1, -1):
        day = today - timedelta(days=offset)
        sales_trend.append(
            {
                "date": day.isoformat(),
                "label": f"{day.month}/{day.day}",
                "value": sales_by_day.get(day.isoformat(), 0),
            }
        )
    peak = max((item["value"] for item in sales_trend), default=0) or 1
    chart_points = " ".join(
        f"{index * 16.6667:.2f},{86 - (item['value'] / peak * 68):.2f}"
        for index, item in enumerate(sales_trend)
    )
    stats = dict(inventory)
    stats.update(
        {
            "today_revenue": float(sales["today_revenue"]),
            "today_profit": float(sales["today_revenue"] - sales["today_cost"]),
            "week_revenue": float(sales["week_revenue"]),
            "month_revenue": float(sales["month_revenue"]),
            "potential_profit": float(inventory["retail_value"] - inventory["cost_value"]),
            "has_sales": bool(sales["records"]),
        }
    )
    recent_movements = connection.execute(
        """SELECT * FROM inventory_movements
           ORDER BY id DESC LIMIT 8"""
    ).fetchall()
    return render_template(
        "dashboard.html",
        title="总览",
        stats=stats,
        sales_trend=sales_trend,
        chart_points=chart_points,
        recent_movements=recent_movements,
    )


@app.get("/sales")
@login_required
def sales_center():
    connection = get_db()
    today = datetime.now(timezone.utc).date()
    today_text = today.isoformat()
    stats = connection.execute(
        """SELECT COALESCE(SUM(CASE WHEN sale_date = ? THEN revenue ELSE 0 END), 0) AS today_revenue,
                  COALESCE(SUM(CASE WHEN sale_date = ? THEN quantity ELSE 0 END), 0) AS today_quantity,
                  COALESCE(SUM(CASE WHEN sale_date = ? THEN revenue - cost_amount ELSE 0 END), 0) AS today_profit,
                  COALESCE(SUM(CASE WHEN sale_date >= date(?, '-6 days') THEN revenue ELSE 0 END), 0) AS week_revenue,
                  COALESCE(SUM(CASE WHEN sale_date >= date(?, '-29 days') THEN revenue ELSE 0 END), 0) AS month_revenue,
                  COUNT(*) AS records
           FROM sales""",
        (today_text, today_text, today_text, today_text, today_text),
    ).fetchone()
    sales_by_day = {
        row["sale_date"]: float(row["revenue"])
        for row in connection.execute(
            """SELECT sale_date, SUM(revenue) AS revenue FROM sales
               WHERE sale_date >= date(?, '-6 days') GROUP BY sale_date""",
            (today_text,),
        ).fetchall()
    }
    trend = []
    for offset in range(6, -1, -1):
        day = today - timedelta(days=offset)
        trend.append(
            {"label": f"{day.month}/{day.day}", "value": sales_by_day.get(day.isoformat(), 0)}
        )
    peak = max((item["value"] for item in trend), default=0) or 1
    chart_points = " ".join(
        f"{index * 16.6667:.2f},{86 - (item['value'] / peak * 68):.2f}"
        for index, item in enumerate(trend)
    )
    top_products = connection.execute(
        """SELECT COALESCE(p.name, '历史商品') AS name, SUM(s.quantity) AS quantity,
                  SUM(s.revenue) AS revenue
           FROM sales s LEFT JOIN products p ON p.id = s.product_id
           WHERE s.sale_date >= date(?, '-29 days')
           GROUP BY s.product_id, p.name ORDER BY revenue DESC LIMIT 10""",
        (today_text,),
    ).fetchall()
    recent_sales = connection.execute(
        """SELECT s.*, COALESCE(p.name, '历史商品') AS product_name
           FROM sales s LEFT JOIN products p ON p.id = s.product_id
           ORDER BY s.id DESC LIMIT 30"""
    ).fetchall()
    return render_template(
        "sales.html",
        title="销售",
        stats=stats,
        trend=trend,
        chart_points=chart_points,
        top_products=top_products,
        recent_sales=recent_sales,
    )


@app.get("/products")
@login_required
def products():
    query = request.args.get("q", "").strip()
    status = request.args.get("status", "all")
    if status not in {"all", "low", "archived"}:
        status = "all"
    issue = request.args.get("issue", "").strip()
    if issue not in {"", "out", "pricing", "margin", "expiry"}:
        issue = ""
    page = max(request.args.get("page", type=int) or 1, 1)
    page_size = 30
    sql = "SELECT * FROM products WHERE archived_at IS {}".format(
        "NOT NULL" if status == "archived" else "NULL"
    )
    params: list[Any] = []
    if query:
        sql += " AND (name LIKE ? OR brand LIKE ? OR sku LIKE ? OR barcode LIKE ? OR supplier LIKE ?)"
        term = f"%{query}%"
        params.extend([term, term, term, term, term])
    if status == "low":
        sql += " AND stock <= low_stock"
    if status != "archived":
        if issue == "out":
            sql += " AND stock <= 0"
        elif issue == "pricing":
            sql += " AND (cost <= 0 OR price <= 0)"
        elif issue == "margin":
            sql += " AND price > 0 AND price < cost"
        elif issue == "expiry":
            today = datetime.now(timezone.utc).date().isoformat()
            sql += " AND expiry_date <> '' AND date(expiry_date) BETWEEN date(?) AND date(?, '+30 days')"
            params.extend([today, today])
    total = get_db().execute(
        f"SELECT COUNT(*) FROM ({sql}) AS filtered_products", params
    ).fetchone()[0]
    pages = max((total + page_size - 1) // page_size, 1)
    page = min(page, pages)
    sql += " ORDER BY updated_at DESC LIMIT ? OFFSET ?"
    rows = get_db().execute(sql, (*params, page_size, (page - 1) * page_size)).fetchall()
    return render_template(
        "products.html",
        title="商品",
        products=rows,
        query=query,
        status=status,
        issue=issue,
        total=total,
        page=page,
        pages=pages,
    )


def csv_cell(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, (int, float)):
        return value
    text = str(value)
    if text.startswith(("=", "+", "-", "@")):
        return "'" + text
    return text


@app.get("/data")
@roles_required("boss", "admin")
def data_center():
    connection = get_db()
    product_count = connection.execute("SELECT COUNT(*) FROM products").fetchone()[0]
    sales_count = connection.execute("SELECT COUNT(*) FROM sales").fetchone()[0]
    movement_count = connection.execute("SELECT COUNT(*) FROM inventory_movements").fetchone()[0]
    return render_template(
        "data.html",
        title="数据",
        product_count=product_count,
        sales_count=sales_count,
        movement_count=movement_count,
    )


@app.get("/data/products.csv")
@roles_required("boss", "admin")
def export_products_csv():
    rows = get_db().execute("SELECT * FROM products ORDER BY id ASC").fetchall()
    columns = [
        ("id", "ID"),
        ("barcode", "条码"),
        ("sku", "SKU"),
        ("name", "商品名称"),
        ("brand", "品牌"),
        ("specification", "规格"),
        ("category", "分类"),
        ("unit", "单位"),
        ("stock", "当前库存"),
        ("low_stock", "预警库存"),
        ("cost", "进价"),
        ("price", "售价"),
        ("supplier", "供应商"),
        ("supplier_contact", "联系方式"),
        ("location", "货位"),
        ("expiry_date", "到期日期"),
        ("notes", "备注"),
        ("created_at", "创建时间"),
        ("updated_at", "更新时间"),
        ("_status", "状态"),
    ]
    output = io.StringIO()
    writer = csv.writer(output, lineterminator="\r\n")
    writer.writerow([label for _, label in columns])
    for row in rows:
        writer.writerow(
            [
                "已停用" if key == "_status" and row["archived_at"] else
                "在售" if key == "_status" else csv_cell(row[key])
                for key, _ in columns
            ]
        )
    audit("export", "products", detail=f"{len(rows)} rows")
    get_db().commit()
    filename = datetime.now(timezone.utc).strftime("BHS-products-%Y%m%d.csv")
    return Response(
        "\ufeff" + output.getvalue(),
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        content_type="text/csv; charset=utf-8",
    )


@app.get("/data/sales.csv")
@roles_required("boss", "admin")
def export_sales_csv():
    rows = get_db().execute(
        """SELECT s.*, COALESCE(p.name, '历史商品') AS product_name
           FROM sales s LEFT JOIN products p ON p.id = s.product_id ORDER BY s.id ASC"""
    ).fetchall()
    columns = [
        ("id", "ID"), ("sale_date", "销售日期"), ("product_id", "商品ID"),
        ("product_name", "商品名称"), ("quantity", "销量"), ("revenue", "销售额"),
        ("cost_amount", "销售成本"), ("source", "来源"), ("external_id", "外部编号"),
        ("created_at", "写入时间"),
    ]
    output = io.StringIO()
    writer = csv.writer(output, lineterminator="\r\n")
    writer.writerow([label for _, label in columns])
    for row in rows:
        writer.writerow([csv_cell(row[key]) for key, _ in columns])
    audit("export", "sales", detail=f"{len(rows)} rows")
    get_db().commit()
    filename = datetime.now(timezone.utc).strftime("BHS-sales-%Y%m%d.csv")
    return Response(
        "\ufeff" + output.getvalue(),
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        content_type="text/csv; charset=utf-8",
    )


@app.get("/data/inventory-movements.csv")
@roles_required("boss", "admin")
def export_inventory_movements_csv():
    rows = get_db().execute(
        "SELECT * FROM inventory_movements ORDER BY id ASC"
    ).fetchall()
    columns = [
        ("id", "ID"), ("product_id", "商品ID"), ("product_name", "商品名称"),
        ("change_amount", "变动数量"), ("before_stock", "变动前"),
        ("after_stock", "变动后"), ("reason", "原因"), ("source", "来源"),
        ("created_at", "时间"),
    ]
    output = io.StringIO()
    writer = csv.writer(output, lineterminator="\r\n")
    writer.writerow([label for _, label in columns])
    for row in rows:
        writer.writerow([csv_cell(row[key]) for key, _ in columns])
    audit("export", "inventory_movements", detail=f"{len(rows)} rows")
    get_db().commit()
    filename = datetime.now(timezone.utc).strftime("BHS-inventory-%Y%m%d.csv")
    return Response(
        "\ufeff" + output.getvalue(),
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        content_type="text/csv; charset=utf-8",
    )


def product_values(form) -> dict[str, Any]:
    name = form.get("name", "").strip()
    if not name:
        raise ValueError("请填写商品名称。")
    return {
        "name": name[:100],
        "sku": form.get("sku", "").strip()[:80],
        "barcode": form.get("barcode", "").strip()[:80],
        "category": form.get("category", "").strip()[:80],
        "brand": form.get("brand", "").strip()[:100],
        "specification": form.get("specification", "").strip()[:100],
        "unit": form.get("unit", "").strip()[:20] or "件",
        "stock": max(number(form.get("stock")), 0),
        "low_stock": max(number(form.get("low_stock"), 5), 0),
        "cost": max(number(form.get("cost")), 0),
        "price": max(number(form.get("price")), 0),
        "supplier": form.get("supplier", "").strip()[:120],
        "supplier_contact": form.get("supplier_contact", "").strip()[:120],
        "location": form.get("location", "").strip()[:120],
        "expiry_date": form.get("expiry_date", "").strip()[:20],
        "notes": form.get("notes", "").strip()[:2000],
    }


@app.route("/products/new", methods=["GET", "POST"])
@login_required
def product_new():
    if request.method == "GET":
        mode = request.args.get("mode", "ai")
        product = None
        title = "AI 录入" if mode != "manual" else "手动录入"
        barcode = normalize_barcode(request.args.get("barcode"))
        if barcode:
            mode = "barcode"
            title = "条码建档"
            try:
                catalog = lookup_barcode_product(barcode)
            except ValueError:
                catalog = {"product": {"barcode": barcode}, "exists": False}
            if catalog.get("exists"):
                return redirect(catalog["detail_url"])
            product = catalog.get("product") or {"barcode": barcode}
        return render_template(
            "product_form.html",
            title=title,
            product=product,
            entry_mode=mode,
        )
    try:
        values = product_values(request.form)
        image_path = save_image(request.files)
    except ValueError as exc:
        flash(str(exc), "error")
        return render_template(
            "product_form.html",
            title="添加商品",
            product=request.form,
            entry_mode=request.args.get("mode", "ai"),
        ), 400
    current = now_iso()
    columns = ", ".join(values.keys())
    placeholders = ", ".join("?" for _ in values)
    cursor = get_db().execute(
        f"""INSERT INTO products
            ({columns}, image_path, created_at, updated_at, created_by)
            VALUES ({placeholders}, ?, ?, ?, ?)""",
        (*values.values(), image_path, current, current, g.user["id"]),
    )
    record_inventory_movement(
        cursor.lastrowid, values["name"], 0, values["stock"],
        "新增商品初始库存", "MANUAL", g.user["id"],
    )
    audit("create", "product", cursor.lastrowid, values["name"])
    get_db().commit()
    flash("商品已添加。", "success")
    return redirect(url_for("product_detail", product_id=cursor.lastrowid))


@app.get("/products/<int:product_id>")
@login_required
def product_detail(product_id: int):
    connection = get_db()
    product = connection.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    if not product:
        abort(404)
    today = datetime.now(timezone.utc).date().isoformat()
    sales = connection.execute(
        """SELECT COALESCE(SUM(CASE WHEN sale_date = ? THEN quantity ELSE 0 END), 0) AS today_quantity,
                  COALESCE(SUM(CASE WHEN sale_date = ? THEN revenue ELSE 0 END), 0) AS today_revenue,
                  COALESCE(SUM(CASE WHEN sale_date >= date(?, '-29 days') THEN quantity ELSE 0 END), 0) AS month_quantity,
                  COALESCE(SUM(CASE WHEN sale_date >= date(?, '-29 days') THEN revenue ELSE 0 END), 0) AS month_revenue
           FROM sales WHERE product_id = ?""",
        (today, today, today, today, product_id),
    ).fetchone()
    movements = connection.execute(
        """SELECT * FROM inventory_movements
           WHERE product_id = ? ORDER BY id DESC LIMIT 30""",
        (product_id,),
    ).fetchall()
    return render_template(
        "product_detail.html",
        title=product["name"],
        product=product,
        sales=sales,
        movements=movements,
    )


@app.route("/products/<int:product_id>/edit", methods=["GET", "POST"])
@login_required
def product_edit(product_id: int):
    product = get_db().execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    if not product:
        abort(404)
    if request.method == "GET":
        return render_template("product_form.html", title="编辑商品", product=product)
    try:
        values = product_values(request.form)
        image_path = save_image(request.files)
    except ValueError as exc:
        flash(str(exc), "error")
        return render_template("product_form.html", title="编辑商品", product=product), 400
    if image_path:
        remove_image(product["image_path"])
    else:
        image_path = product["image_path"]
    assignments = ", ".join(f"{key} = ?" for key in values)
    get_db().execute(
        f"UPDATE products SET {assignments}, image_path = ?, updated_at = ? WHERE id = ?",
        (*values.values(), image_path, now_iso(), product_id),
    )
    record_inventory_movement(
        product_id, values["name"], product["stock"], values["stock"],
        "编辑商品库存", "MANUAL", g.user["id"],
    )
    audit("update", "product", product_id, values["name"])
    get_db().commit()
    flash("商品资料已保存。", "success")
    return redirect(url_for("product_detail", product_id=product_id))


@app.post("/products/<int:product_id>/stock-adjust")
@login_required
def product_stock_adjust(product_id: int):
    product = get_db().execute(
        "SELECT * FROM products WHERE id = ? AND archived_at IS NULL", (product_id,)
    ).fetchone()
    if not product:
        abort(404)
    operation = request.form.get("stock_operation", "in")
    if operation not in {"in", "out", "set"}:
        abort(400)
    quantity = number(request.form.get("quantity"), -1)
    if quantity < 0 or (operation in {"in", "out"} and quantity == 0):
        flash("请输入有效数量。", "error")
        return redirect(url_for("product_detail", product_id=product_id))
    reason = request.form.get("reason", "").strip()[:200]
    if not reason:
        flash("请填写库存变动原因。", "error")
        return redirect(url_for("product_detail", product_id=product_id))
    before_stock = float(product["stock"])
    if operation == "in":
        after_stock = before_stock + quantity
    elif operation == "out":
        after_stock = max(0, before_stock - quantity)
    else:
        after_stock = quantity
    get_db().execute(
        "UPDATE products SET stock = ?, updated_at = ? WHERE id = ?",
        (after_stock, now_iso(), product_id),
    )
    record_inventory_movement(
        product_id, product["name"], before_stock, after_stock, reason,
        "MANUAL", g.user["id"],
    )
    audit("adjust_stock", "product", product_id, f"{before_stock:g} -> {after_stock:g}; {reason}")
    get_db().commit()
    flash("库存已更新。", "success")
    return redirect(url_for("product_detail", product_id=product_id))


@app.post("/products/<int:product_id>/delete")
@roles_required("boss", "admin")
def product_delete(product_id: int):
    product = get_db().execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    if not product:
        abort(404)
    get_db().execute(
        "UPDATE products SET archived_at = ?, updated_at = ? WHERE id = ?",
        (now_iso(), now_iso(), product_id),
    )
    audit("archive", "product", product_id, product["name"])
    get_db().commit()
    flash("商品已停用，历史数据已保留。", "success")
    return redirect(url_for("products"))


@app.post("/products/<int:product_id>/restore")
@roles_required("boss", "admin")
def product_restore(product_id: int):
    product = get_db().execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    if not product:
        abort(404)
    get_db().execute(
        "UPDATE products SET archived_at = NULL, updated_at = ? WHERE id = ?",
        (now_iso(), product_id),
    )
    audit("restore", "product", product_id, product["name"])
    get_db().commit()
    flash("商品已恢复。", "success")
    return redirect(url_for("product_detail", product_id=product_id))


@app.post("/products/<int:product_id>/purge")
@roles_required("boss", "admin")
def product_purge(product_id: int):
    connection = get_db()
    product = connection.execute(
        "SELECT * FROM products WHERE id = ? AND archived_at IS NOT NULL", (product_id,)
    ).fetchone()
    if not product:
        flash("请先停用商品，再执行永久删除。", "error")
        return redirect(url_for("product_detail", product_id=product_id))
    connection.execute("UPDATE ai_actions SET product_id = NULL WHERE product_id = ?", (product_id,))
    connection.execute("DELETE FROM products WHERE id = ?", (product_id,))
    audit("purge", "product", product_id, product["name"])
    connection.commit()
    remove_image(product["image_path"])
    flash("商品已永久删除，销售与库存历史仍保留。", "success")
    return redirect(url_for("products", status="archived"))


@app.post("/products/bulk-status")
@roles_required("boss", "admin")
def products_bulk_status():
    raw_ids = request.form.getlist("product_ids")[:200]
    product_ids = []
    for value in raw_ids:
        try:
            product_id = int(value)
        except (TypeError, ValueError):
            continue
        if product_id > 0 and product_id not in product_ids:
            product_ids.append(product_id)
    if not product_ids:
        flash("请先选择商品。", "error")
        return redirect(url_for("products"))
    operation = request.form.get("operation", "archive")
    if operation not in {"archive", "restore", "purge"}:
        abort(400)
    placeholders = ",".join("?" for _ in product_ids)
    rows = get_db().execute(
        f"SELECT id, name, image_path, archived_at FROM products WHERE id IN ({placeholders})", product_ids
    ).fetchall()
    if operation == "archive":
        get_db().execute(
            f"UPDATE products SET archived_at = ?, updated_at = ? WHERE id IN ({placeholders})",
            (now_iso(), now_iso(), *product_ids),
        )
        action = "bulk_archive"
        message = f"已停用 {len(rows)} 件商品。"
    elif operation == "restore":
        get_db().execute(
            f"UPDATE products SET archived_at = NULL, updated_at = ? WHERE id IN ({placeholders})",
            (now_iso(), *product_ids),
        )
        action = "bulk_restore"
        message = f"已恢复 {len(rows)} 件商品。"
    else:
        archived_rows = [row for row in rows if row["archived_at"]]
        if not archived_rows:
            flash("永久删除只适用于已停用商品。", "error")
            return redirect(url_for("products", status="archived"))
        archived_ids = [row["id"] for row in archived_rows]
        archived_placeholders = ",".join("?" for _ in archived_ids)
        get_db().execute(
            f"UPDATE ai_actions SET product_id = NULL WHERE product_id IN ({archived_placeholders})",
            archived_ids,
        )
        get_db().execute(
            f"DELETE FROM products WHERE id IN ({archived_placeholders})", archived_ids
        )
        rows = archived_rows
        action = "bulk_purge"
        message = f"已永久删除 {len(rows)} 件商品。"
    audit(action, "product", None, "、".join(row["name"] for row in rows)[:500])
    get_db().commit()
    if operation == "purge":
        for row in rows:
            remove_image(row["image_path"])
    flash(message, "success")
    return redirect(url_for("products", status="archived" if operation in {"archive", "purge"} else "all"))


@app.get("/users")
@roles_required("boss", "admin")
def users():
    rows = get_db().execute("SELECT * FROM users ORDER BY id ASC").fetchall()
    return render_template("users.html", title="成员", users=rows)


@app.post("/users")
@roles_required("boss", "admin")
def user_create():
    username = request.form.get("username", "").strip()
    display_name = request.form.get("display_name", "").strip() or username
    password = request.form.get("password", "")
    role = request.form.get("role", "staff")
    allowed_roles = {"staff", "admin"} if g.user["role"] == "boss" else {"staff"}
    if role not in allowed_roles:
        abort(403)
    if len(username) < 2 or len(password) < 8:
        flash("账号至少 2 个字符，密码至少 8 个字符。", "error")
        return redirect(url_for("users"))
    try:
        cursor = get_db().execute(
            """INSERT INTO users
               (username, password_hash, display_name, role, active, created_at, created_by)
               VALUES (?, ?, ?, ?, 1, ?, ?)""",
            (
                username[:50],
                generate_password_hash(password, method="scrypt"),
                display_name[:60],
                role,
                now_iso(),
                g.user["id"],
            ),
        )
    except sqlite3.IntegrityError:
        flash("该账号已存在。", "error")
        return redirect(url_for("users"))
    audit("create", "user", cursor.lastrowid, f"{username}:{role}")
    get_db().commit()
    flash("成员账号已创建。", "success")
    return redirect(url_for("users"))


@app.post("/users/<int:user_id>/toggle")
@roles_required("boss", "admin")
def user_toggle(user_id: int):
    target = get_db().execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if not target:
        abort(404)
    if target["role"] == "boss" or target["id"] == g.user["id"]:
        flash("Boss 或当前登录账号不能在这里停用。", "error")
        return redirect(url_for("users"))
    if g.user["role"] == "admin" and target["role"] != "staff":
        abort(403)
    active = 0 if target["active"] else 1
    get_db().execute("UPDATE users SET active = ? WHERE id = ?", (active, user_id))
    audit("activate" if active else "deactivate", "user", user_id, target["username"])
    get_db().commit()
    flash("账号状态已更新。", "success")
    return redirect(url_for("users"))


@app.get("/assistant")
@login_required
def assistant():
    rows = get_db().execute(
        "SELECT * FROM messages WHERE conversation_key = 'main' ORDER BY id DESC LIMIT 60"
    ).fetchall()
    prefill = request.args.get("ask", "").strip()[:1000]
    return render_template(
        "assistant.html", title="BHS AI", messages=list(reversed(rows)), prefill=prefill
    )


@app.get("/api/messages")
@login_required
def api_messages():
    after = request.args.get("after", type=int) or 0
    rows = get_db().execute(
        """SELECT id, role, content, channel, sender_name, created_at
           FROM messages WHERE conversation_key = 'main' AND id > ?
           ORDER BY id ASC LIMIT 100""",
        (after,),
    ).fetchall()
    return jsonify([dict(row) for row in rows])


@app.post("/api/chat")
@login_required
def api_chat():
    body = request.get_json(silent=True) or {}
    content = str(body.get("message", "")).strip()
    if not content or len(content) > 4000:
        return jsonify({"error": "请输入 1–4000 字的问题。"}), 400
    insert_message("user", content, "WEB", g.user["display_name"], g.user["id"])
    normalized = re.sub(r"[\s，。！？,.!?]", "", content)
    confirmation_words = {"确认", "确认执行", "执行", "同意", "确定"}
    cancellation_words = {"取消", "取消操作", "不要执行", "不执行"}
    if normalized in confirmation_words | cancellation_words:
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=30)).replace(microsecond=0).isoformat()
        get_db().execute(
            """UPDATE ai_actions SET status = 'expired'
               WHERE user_id = ? AND status = 'pending' AND created_at < ?""",
            (g.user["id"], cutoff),
        )
        pending = get_db().execute(
            """SELECT id FROM ai_actions
               WHERE user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 2""",
            (g.user["id"],),
        ).fetchall()
        get_db().commit()
        if len(pending) == 1:
            if normalized in confirmation_words:
                try:
                    summary, product_id = confirm_ai_action(pending[0]["id"])
                except ValueError as exc:
                    answer = str(exc)
                else:
                    answer = f"已执行：{summary}"
            else:
                get_db().execute(
                    "UPDATE ai_actions SET status = 'cancelled' WHERE id = ?",
                    (pending[0]["id"],),
                )
                get_db().commit()
                product_id = None
                answer = "已取消这项操作。"
            message_id = insert_message("assistant", answer, "WEB", "BHS AI")
            return jsonify(
                {
                    "id": message_id,
                    "answer": answer,
                    "proposal": None,
                    "detail_url": url_for("product_detail", product_id=product_id) if product_id else None,
                }
            )
        if len(pending) > 1:
            answer = "目前有多项待确认操作，请点击对应操作卡确认。"
            message_id = insert_message("assistant", answer, "WEB", "BHS AI")
            return jsonify({"id": message_id, "answer": answer, "proposal": None})
    deterministic = deterministic_product_action(content)
    if deterministic:
        answer, proposal = deterministic
        message_id = insert_message("assistant", answer, "WEB", "BHS AI")
        return jsonify({"id": message_id, "answer": answer, "proposal": proposal})
    history = get_db().execute(
        """SELECT role, content FROM messages
           WHERE conversation_key = 'main' AND role IN ('user', 'assistant')
           ORDER BY id DESC LIMIT 24"""
    ).fetchall()
    try:
        answer, proposal = ai_butler_response([dict(row) for row in reversed(history)])
    except RuntimeError as exc:
        answer = f"这次没有执行：{exc}"
        message_id = insert_message("assistant", answer, "SYSTEM", "BHS AI")
        return jsonify({"id": message_id, "answer": answer, "proposal": None, "failed": True})
    message_id = insert_message("assistant", answer, "WEB", "BHS AI")
    return jsonify({"id": message_id, "answer": answer, "proposal": proposal})


@app.post("/api/ai/actions/<int:action_id>/confirm")
@login_required
def api_ai_action_confirm(action_id: int):
    try:
        summary, product_id = confirm_ai_action(action_id)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 409
    return jsonify(
        {
            "ok": True,
            "message": "已执行",
            "summary": summary,
            "detail_url": url_for("product_detail", product_id=product_id) if product_id else None,
        }
    )


@app.post("/api/ai/actions/<int:action_id>/cancel")
@login_required
def api_ai_action_cancel(action_id: int):
    cursor = get_db().execute(
        """UPDATE ai_actions SET status = 'cancelled'
           WHERE id = ? AND user_id = ? AND status = 'pending'""",
        (action_id, g.user["id"]),
    )
    get_db().commit()
    if not cursor.rowcount:
        return jsonify({"error": "这项操作已处理或不存在。"}), 409
    return jsonify({"ok": True, "message": "已取消"})


@app.post("/api/products/ai-draft")
@login_required
def api_product_ai_draft():
    body = request.get_json(silent=True) or {}
    description = str(body.get("description", "")).strip()
    if not description or len(description) > 3000:
        return jsonify({"error": "请用 1–3000 字描述商品信息。"}), 400
    try:
        draft = product_draft_from_text(description)
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 502
    if not draft:
        return jsonify({"error": "没有识别到商品信息，请说得更具体一些。"}), 422
    return jsonify({"draft": draft})


@app.get("/api/products/barcode/<code>")
@login_required
def api_barcode_lookup(code: str):
    try:
        result = lookup_barcode_product(code)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify(result)


@app.post("/api/products/barcode/scan")
@login_required
def api_barcode_scan():
    try:
        code = decode_barcode_upload(request.files.get("barcode_photo"))
        result = lookup_barcode_product(code)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 422
    return jsonify(result)


@app.get("/integrations")
@roles_required("boss", "admin")
def integrations():
    last_wechat = get_db().execute(
        "SELECT created_at FROM messages WHERE channel = 'WECHAT' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return render_template(
        "integrations.html",
        title="连接",
        last_wechat=last_wechat["created_at"] if last_wechat else None,
    )


@app.get("/api/channel/health")
def api_channel_health():
    if not channel_authorized():
        return jsonify({"error": "unauthorized"}), 401
    return jsonify({"ok": True, "service": "BHS", "time": now_iso()})


@app.post("/api/channel/message")
def api_channel_message():
    if not channel_authorized():
        return jsonify({"error": "unauthorized"}), 401
    body = request.get_json(silent=True) or {}
    content = str(body.get("message", "")).strip()
    sender = str(body.get("sender", "ClawBot")).strip()[:80] or "ClawBot"
    external_id = str(body.get("id", "")).strip() or None
    if not content:
        return jsonify({"error": "message is required"}), 400
    insert_message("user", content, "WECHAT", sender, external_id=external_id)
    history = get_db().execute(
        """SELECT role, content FROM messages
           WHERE conversation_key = 'main' AND role IN ('user', 'assistant')
           ORDER BY id DESC LIMIT 24"""
    ).fetchall()
    try:
        answer, _ = call_deepseek([dict(row) for row in reversed(history)])
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 502
    insert_message("assistant", answer, "WECHAT", "BHS AI")
    return jsonify({"reply": answer})


@app.get("/api/openai/v1/models")
def openai_models():
    if not channel_authorized():
        return jsonify({"error": {"message": "Unauthorized", "type": "auth_error"}}), 401
    return jsonify(
        {
            "object": "list",
            "data": [{"id": "bhs-deepseek", "object": "model", "owned_by": "BHS"}],
        }
    )


def local_openai_completion(answer: str, body: dict[str, Any], channel: str) -> Response:
    insert_message("assistant", answer, channel, "BHS AI")
    completion_id = f"chatcmpl-bhs-{uuid.uuid4().hex}"
    model = str(body.get("model") or "bhs-deepseek")
    if not body.get("stream"):
        return jsonify(
            {
                "id": completion_id,
                "object": "chat.completion",
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": answer},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            }
        )

    def generate_local():
        first = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "delta": {"role": "assistant", "content": answer},
                    "finish_reason": None,
                }
            ],
        }
        final = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "model": model,
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        }
        yield f"data: {json.dumps(first, ensure_ascii=False)}\n\n"
        yield f"data: {json.dumps(final, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

    return Response(generate_local(), content_type="text/event-stream")


def compact_wechat_answer(answer: str, finish_reason: str = "stop") -> str:
    """Keep a WeChat answer complete and readable instead of forwarding a truncated model turn."""
    cleaned = answer.strip()
    truncated = finish_reason == "length" or len(cleaned) > 1600
    if len(cleaned) > 1500:
        candidate = cleaned[:1500]
        boundary = max(candidate.rfind("\n"), candidate.rfind("。"), candidate.rfind("；"))
        cleaned = candidate[: boundary + 1] if boundary >= 900 else candidate.rstrip()
    if truncated:
        cleaned = cleaned.rstrip("|,，、；;：: ")
        cleaned += "\n\n商品较多，微信不展开完整清单。请按分类、库存状态或商品名称继续查询。"
    return cleaned or "这次没有生成有效回复，请重新描述要查询的范围。"


def wechat_ai_completion(
    payload: dict[str, Any], body: dict[str, Any], channel: str
) -> Response:
    payload["stream"] = False
    payload["max_tokens"] = min(int(payload.get("max_tokens") or 900), 900)
    payload["messages"][0]["content"] += (
        "\n这是微信对话。回复必须适合手机阅读，不超过 600 个中文字符。"
        "商品较多时只给汇总和最需要关注的 5 条，不要输出完整清单或大型 Markdown 表格；"
        "提示用户按分类、库存状态或商品名称继续查询。"
    )
    try:
        response = deepseek_request(payload)
        data = response.json()
    except (requests.RequestException, ValueError) as exc:
        return jsonify({"error": {"message": str(exc), "type": "upstream_error"}}), 502
    if not response.ok:
        return jsonify(data), response.status_code
    try:
        choice = data["choices"][0]
        answer = compact_wechat_answer(
            str(choice["message"]["content"]), str(choice.get("finish_reason") or "stop")
        )
    except (KeyError, IndexError, TypeError):
        return jsonify(
            {"error": {"message": "AI 没有返回有效内容", "type": "upstream_error"}}
        ), 502
    return local_openai_completion(answer, body, channel)


@app.post("/api/openai/v1/chat/completions")
def openai_chat_completions():
    if not channel_authorized():
        return jsonify({"error": {"message": "Unauthorized", "type": "auth_error"}}), 401
    body = request.get_json(silent=True) or {}
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        return jsonify({"error": {"message": "messages is required", "type": "invalid_request_error"}}), 400
    sender = request.headers.get("X-BHS-Sender", "ClawBot")[:80]
    channel = request.headers.get("X-BHS-Channel", "WECHAT").upper()
    if channel not in {"WEB", "WECHAT"}:
        channel = "WECHAT"
    visible_turn = visible_user_turn(messages)
    last_user_content = visible_user_message(messages)
    image_path = save_openai_image([visible_turn]) if visible_turn else None
    display_content = last_user_content or ("发送了一张商品照片" if image_path else "")
    if display_content:
        insert_message(
            "user",
            display_content,
            channel,
            sender,
            external_id=(
                request.headers.get("X-BHS-Message-Id")
                or openclaw_external_id(messages)
                or None
            ),
        )
    conversation_key = openclaw_chat_id(messages)
    if channel == "WECHAT" and conversation_key:
        try:
            local_answer = handle_wechat_product_flow(
                conversation_key,
                last_user_content,
                image_path,
            )
        except RuntimeError as exc:
            local_answer = str(exc)
        if local_answer:
            return local_openai_completion(local_answer, body, channel)
    payload = deepseek_payload(messages, body)
    stream = bool(payload["stream"])
    if channel == "WECHAT":
        return wechat_ai_completion(payload, body, channel)
    if not stream:
        try:
            response = deepseek_request(payload)
            data = response.json()
        except (requests.RequestException, ValueError) as exc:
            return jsonify({"error": {"message": str(exc), "type": "upstream_error"}}), 502
        if not response.ok:
            return jsonify(data), response.status_code
        try:
            answer = data["choices"][0]["message"]["content"]
            insert_message("assistant", answer, channel, "BHS AI")
        except (KeyError, IndexError, TypeError):
            pass
        return jsonify(data)

    try:
        upstream = deepseek_request(payload, stream=True)
    except requests.RequestException as exc:
        return jsonify({"error": {"message": str(exc), "type": "upstream_error"}}), 502
    if not upstream.ok:
        return Response(upstream.content, status=upstream.status_code, content_type="application/json")

    @stream_with_context
    def generate():
        answer_parts: list[str] = []
        for raw_line in upstream.iter_lines(decode_unicode=True):
            if not raw_line:
                continue
            yield raw_line + "\n\n"
            if raw_line.startswith("data: ") and raw_line != "data: [DONE]":
                try:
                    chunk = json.loads(raw_line[6:])
                    part = chunk["choices"][0]["delta"].get("content")
                    if part:
                        answer_parts.append(part)
                except (ValueError, KeyError, IndexError, TypeError):
                    pass
        if answer_parts:
            with app.app_context():
                insert_message("assistant", "".join(answer_parts), channel, "BHS AI")
        upstream.close()

    return Response(generate(), content_type="text/event-stream")


@app.errorhandler(413)
def too_large(_):
    return render_template("error.html", title="图片过大", message="单张图片不能超过 10MB。"), 413


@app.errorhandler(403)
def forbidden(_):
    return render_template("error.html", title="没有权限", message="当前账号不能执行这个操作。"), 403


@app.errorhandler(404)
def not_found(_):
    return render_template("error.html", title="找不到页面", message="该内容可能已被删除。"), 404


init_db()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5173")), debug=False)
