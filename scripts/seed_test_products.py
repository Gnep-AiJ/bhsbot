from __future__ import annotations

import random
import sqlite3
import sys
from datetime import date, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import app as bhs


CATALOG = [
    ("饮料", "冰露矿泉水", "可口可乐", "550ml", "瓶", 0.75),
    ("饮料", "东方树叶茉莉花茶", "农夫山泉", "500ml", "瓶", 3.2),
    ("饮料", "无糖可乐", "可口可乐", "500ml", "瓶", 2.4),
    ("饮料", "椰子水", "椰树", "245ml", "罐", 3.1),
    ("饮料", "维生素饮料", "脉动", "600ml", "瓶", 3.8),
    ("乳品", "纯牛奶", "伊利", "250ml×12", "箱", 39.0),
    ("乳品", "风味酸奶", "蒙牛", "200g", "杯", 3.0),
    ("乳品", "高钙低脂奶", "光明", "250ml×6", "提", 19.0),
    ("乳品", "原味酸奶", "简爱", "135g", "杯", 6.5),
    ("乳品", "儿童成长牛奶", "旺仔", "125ml×4", "提", 10.5),
    ("零食", "薯片原味", "乐事", "70g", "袋", 4.2),
    ("零食", "每日坚果", "沃隆", "25g", "袋", 3.5),
    ("零食", "海盐苏打饼干", "太平", "100g", "包", 3.0),
    ("零食", "牛肉干", "棒棒娃", "80g", "袋", 13.0),
    ("零食", "黑巧克力", "德芙", "43g", "块", 6.2),
    ("方便食品", "红烧牛肉面", "康师傅", "105g", "桶", 3.6),
    ("方便食品", "酸辣粉", "白家陈记", "108g", "桶", 5.0),
    ("方便食品", "自热米饭", "莫小仙", "275g", "盒", 11.5),
    ("方便食品", "火腿肠", "双汇", "40g×8", "袋", 8.0),
    ("方便食品", "紫菜蛋花汤", "苏伯", "8g×10", "盒", 9.5),
    ("粮油", "五常大米", "十月稻田", "5kg", "袋", 38.0),
    ("粮油", "花生油", "鲁花", "5L", "桶", 118.0),
    ("粮油", "高筋小麦粉", "金沙河", "2.5kg", "袋", 15.0),
    ("粮油", "东北小米", "燕之坊", "1kg", "袋", 13.0),
    ("粮油", "玉米胚芽油", "西王", "4L", "桶", 63.0),
    ("调味品", "生抽酱油", "海天", "500ml", "瓶", 5.2),
    ("调味品", "香醋", "恒顺", "500ml", "瓶", 5.0),
    ("调味品", "精制食用盐", "中盐", "400g", "袋", 1.3),
    ("调味品", "火锅底料", "海底捞", "200g", "袋", 11.0),
    ("调味品", "番茄沙司", "亨氏", "320g", "瓶", 7.0),
    ("清洁", "洗衣液", "蓝月亮", "2kg", "瓶", 28.0),
    ("清洁", "洗洁精", "立白", "1kg", "瓶", 8.0),
    ("清洁", "抽取式垃圾袋", "妙洁", "45只", "卷", 8.5),
    ("清洁", "厨房湿巾", "心相印", "40片", "包", 9.5),
    ("清洁", "洁厕液", "威猛先生", "500g", "瓶", 8.0),
    ("个护", "清爽牙膏", "云南白药", "100g", "支", 18.0),
    ("个护", "软毛牙刷", "高露洁", "2支", "卡", 9.0),
    ("个护", "去屑洗发水", "海飞丝", "400ml", "瓶", 31.0),
    ("个护", "沐浴露", "舒肤佳", "400ml", "瓶", 22.0),
    ("个护", "棉柔卫生巾", "苏菲", "10片", "包", 8.5),
    ("纸品", "无芯卷纸", "维达", "12卷", "提", 22.0),
    ("纸品", "抽纸", "清风", "3层×6包", "提", 14.0),
    ("纸品", "厨房纸巾", "洁柔", "2卷", "提", 9.0),
    ("纸品", "湿厕纸", "得宝", "40片", "包", 11.0),
    ("纸品", "手帕纸", "妮飘", "10包", "条", 7.0),
    ("冷藏", "鲜鸡蛋", "正大", "10枚", "盒", 10.0),
    ("冷藏", "手工水饺", "湾仔码头", "600g", "袋", 20.0),
    ("冷藏", "原味吐司", "桃李", "400g", "袋", 7.0),
    ("冷藏", "即食鸡胸肉", "优形", "100g", "袋", 7.5),
    ("冷藏", "速冻汤圆", "三全", "500g", "袋", 10.0),
]

SUPPLIERS = [
    ("华南食品供应链", "13800001001"),
    ("晨光乳品配送", "13800001002"),
    ("丰源粮油商贸", "13800001003"),
    ("百洁日化配送", "13800001004"),
    ("优鲜冷链", "13800001005"),
]


def ean13(seed: int) -> str:
    first_twelve = f"697{seed:09d}"[-12:]
    checksum = (10 - sum((3 if index % 2 else 1) * int(value) for index, value in enumerate(first_twelve)) % 10) % 10
    return first_twelve + str(checksum)


def main() -> None:
    rng = random.Random(20260721)
    connection = sqlite3.connect(bhs.DATABASE)
    connection.execute("PRAGMA foreign_keys = ON")
    boss = connection.execute("SELECT id FROM users WHERE role = 'boss' ORDER BY id LIMIT 1").fetchone()
    created_by = boss[0] if boss else None
    current = bhs.now_iso()
    added = 0
    for index, (category, name, brand, specification, unit, base_cost) in enumerate(CATALOG, 1):
        marked_name = f"测试·{name}"
        if connection.execute("SELECT 1 FROM products WHERE name = ?", (marked_name,)).fetchone():
            continue
        low_stock = rng.choice([4, 5, 6, 8, 10])
        stock = 0 if index in {4, 21, 39} else rng.randint(2, 80)
        if index in {8, 18, 33, 47}:
            stock = max(1, low_stock - 1)
        cost = round(base_cost * rng.uniform(.94, 1.06), 2)
        price = round(cost * rng.uniform(1.18, 1.55), 2)
        if index in {14, 34}:
            price = round(cost * .92, 2)
        supplier, contact = SUPPLIERS[(index - 1) % len(SUPPLIERS)]
        expiry = ""
        if category in {"乳品", "冷藏", "饮料", "零食", "方便食品", "调味品"}:
            days = rng.randint(70, 360)
            if index in {2, 7, 46, 48}:
                days = rng.randint(7, 25)
            expiry = (date.today() + timedelta(days=days)).isoformat()
        cursor = connection.execute(
            """INSERT INTO products
               (name, sku, barcode, category, brand, specification, unit, stock, low_stock,
                cost, price, supplier, supplier_contact, location, expiry_date, notes,
                created_at, updated_at, created_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                marked_name, f"TEST-{index:03d}", ean13(index), category, brand,
                specification, unit, stock, low_stock, cost, price, supplier, contact,
                f"{chr(65 + (index - 1) % 5)}-{(index - 1) // 5 + 1:02d}", expiry,
                "模拟测试数据，可在已停用列表中批量永久删除。", current, current, created_by,
            ),
        )
        if stock:
            connection.execute(
                """INSERT INTO inventory_movements
                   (product_id, product_name, change_amount, before_stock, after_stock,
                    reason, source, user_id, created_at)
                   VALUES (?, ?, ?, 0, ?, '模拟测试初始库存', 'TEST', ?, ?)""",
                (cursor.lastrowid, marked_name, stock, stock, created_by, current),
            )
        added += 1
    connection.commit()
    total = connection.execute("SELECT COUNT(*) FROM products WHERE name LIKE '测试·%'").fetchone()[0]
    connection.close()
    print(f"added={added} test_total={total}")


if __name__ == "__main__":
    main()
