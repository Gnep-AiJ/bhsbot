#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sqlite3
from pathlib import Path

from werkzeug.security import check_password_hash


ROOT = Path(__file__).resolve().parents[1]


def load_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def main() -> int:
    parser = argparse.ArgumentParser(description="Check BHS deployment prerequisites without printing secrets.")
    parser.add_argument("--production", action="store_true", help="Require HTTPS/proxy production settings")
    args = parser.parse_args()
    env = {**load_env(ROOT / ".env"), **os.environ}
    failures: list[str] = []
    warnings: list[str] = []

    for key, minimum in (("SECRET_KEY", 32), ("DEEPSEEK_API_KEY", 20), ("BHS_CHANNEL_TOKEN", 32)):
        value = env.get(key, "")
        if len(value) < minimum or "replace-with" in value:
            failures.append(f"{key} 未配置或强度不足")
    if not env.get("BOSS_INITIAL_PASSWORD"):
        failures.append("BOSS_INITIAL_PASSWORD 未配置")

    if args.production:
        if env.get("BHS_HTTPS_ONLY", "").lower() not in {"1", "true", "yes", "on"}:
            failures.append("生产模式必须设置 BHS_HTTPS_ONLY=1")
        if env.get("BHS_TRUST_PROXY_HEADERS", "").lower() not in {"1", "true", "yes", "on"}:
            failures.append("Tunnel 模式必须设置 BHS_TRUST_PROXY_HEADERS=1")
        if not env.get("BHS_WECHAT_ALLOWED_CHAT_IDS", "").strip():
            failures.append("生产模式必须配置 BHS_WECHAT_ALLOWED_CHAT_IDS")
        if env.get("BHS_SECRETS_ROTATED", "").lower() not in {"1", "true", "yes", "on"}:
            failures.append("轮换全部已暴露密钥后必须设置 BHS_SECRETS_ROTATED=1")

    database = ROOT / "data" / "bhs.db"
    if not database.exists():
        failures.append("data/bhs.db 不存在")
    else:
        connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        foreign_key_errors = connection.execute("PRAGMA foreign_key_check").fetchall()
        bosses = connection.execute(
            "SELECT password_hash FROM users WHERE role = 'boss' AND active = 1"
        ).fetchall()
        connection.close()
        if integrity != "ok":
            failures.append(f"SQLite 完整性检查失败：{integrity}")
        if foreign_key_errors:
            failures.append(f"SQLite 存在 {len(foreign_key_errors)} 条外键错误")
        if len(bosses) != 1:
            failures.append(f"应有且仅有 1 个启用 Boss，当前为 {len(bosses)}")
        elif env.get("BOSS_INITIAL_PASSWORD") and check_password_hash(
            bosses[0][0], env["BOSS_INITIAL_PASSWORD"]
        ):
            message = "Boss 仍在使用初始密码"
            (failures if args.production else warnings).append(message)

    if (ROOT / "openclaw" / "workspace" / "BOOTSTRAP.md").exists():
        failures.append("OpenClaw 仍处于首次启动引导状态")
    if not (ROOT / "openclaw" / "workspace" / "skills" / "bhs-store-operator" / "SKILL.md").exists():
        failures.append("bhs-store-operator Skill 不存在")
    gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
    if "!openclaw/config/openclaw.json" in gitignore:
        failures.append("openclaw.json 仍可能被提交，里面可能包含令牌")

    for item in warnings:
        print(f"WARN  {item}")
    for item in failures:
        print(f"FAIL  {item}")
    if failures:
        print(f"RESULT NOT READY ({len(failures)} failed, {len(warnings)} warning)")
        return 1
    print(f"RESULT READY ({len(warnings)} warning)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
