#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
QMT/miniQMT sidecar —— ashare-trader 与券商通道之间的唯一桥梁。

设计（与 docs/COMPLIANCE.md 一致）：
  - 只监听 127.0.0.1，本机进程间通信，不对局域网开放；
  - 三档模式，默认 mock，绝不"顺手"升级到真实委托：
      mock  : 完全不 import xtquant，只做记录与应答（开发/测试用）
      dry   : 尝试 import xtquant 并连接行情/交易，但**不下单**，只应答"将要做什么"
      live  : 真实委托。必须同时满足：--mode=live 且环境变量 QMT_CONFIRM=I-KNOW-THIS-IS-REAL
  - 所有委托有本地台账（data 同目录 qmt_orders.jsonl），可审计；
  - 单笔金额上限 QMT_MAX_ORDER_CNY（默认 20000 元），超限直接拒绝。

用法（在装了 miniQMT 的机器上）：
  python qmt_bridge.py                       # mock
  python qmt_bridge.py --mode=dry            # 连 miniQMT 但不下单
  QMT_CONFIRM=I-KNOW-THIS-IS-REAL python qmt_bridge.py --mode=live --account=123456789

HTTP API：
  GET  /status  → {mode, xtquant, connected, account}
  POST /order   → body {signalId, code:"600000.SH", side:"buy", price, qty, remark}
  GET  /orders  → 本地委托台账
鉴权：请求头 x-auth 必须等于 QMT_TOKEN（默认为空则不校验 —— 仅建议本机使用）。
"""

import argparse
import json
import os
import threading
import time
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_ORDER_CNY = float(os.environ.get("QMT_MAX_ORDER_CNY", "20000"))
TOKEN = os.environ.get("QMT_TOKEN", "")
CONFIRM_PHRASE = "I-KNOW-THIS-IS-REAL"

state_lock = threading.Lock()
orders_ledger = []  # 本地台账（追加写 qmt_orders.jsonl）

xt = None          # xtquant.xttrader / xtconstant 相关，仅 live/dry 且可用时装载
xt_account = None
xt_trader = None


def log(*a):
    print(f"[{datetime.now().strftime('%H:%M:%S')}]".ljust(11), *a, flush=True)


def ledger_path():
    return Path(__file__).resolve().parent / "qmt_orders.jsonl"


def append_ledger(entry):
    with state_lock:
        orders_ledger.append(entry)
        with ledger_path().open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def try_connect_xtquant(account_id):
    """dry/live 模式下尝试装载 xtquant 并连接 miniQMT 客户端。失败不抛异常，只标记 connected=False。"""
    global xt, xt_account, xt_trader
    try:
        from xtquant import xtconstant  # noqa: F401
        from xtquant import xttrader
        from xtquant.xttype import StockAccount

        session_id = int(time.time()) % 100000000
        trader = xttrader.XtQuantTrader(os.environ.get("QMT_MINI_PATH", ""), session_id)
        trader.start()
        ok = trader.connect()
        if ok != 0:
            log("xtquant connect 失败 code=", ok, "—— miniQMT 客户端没登录？")
            return
        acc = StockAccount(account_id)
        trader.subscribe(acc)
        xt, xt_account, xt_trader = xtconstant, acc, trader
        log("xtquant 已连接，账户", account_id)
    except Exception as e:  # noqa: BLE001 —— 任何导入/连接失败都保持"未连接"状态
        log("xtquant 不可用：", e)


def submit_live(code, side, price, qty):
    """真实委托。只有 live 模式会走到这里。"""
    side_const = xt.STOCK_BUY if side == "buy" else xt.STOCK_SELL
    price_type = xt.FIX_PRICE
    return xt_trader.order_stock(xt_account, code, side_const, qty, price_type, price, "ashare-trader", "remark")


def validate(body):
    """两侧互不信任的第二道校验。返回 (error, code, side, price, qty)。"""
    code = str(body.get("code", "")).strip().upper()
    if not code.endswith(".SH") and not code.endswith(".SZ"):
        return "code 必须是 600000.SH / 000001.SZ 形式", None, None, None, None
    side = str(body.get("side", "")).lower()
    if side not in ("buy", "sell"):
        return "side 只能是 buy/sell", None, None, None, None
    try:
        price = float(body.get("price", 0))
        qty = int(body.get("qty", 0))
    except (TypeError, ValueError):
        return "price/qty 非法", None, None, None, None
    if price <= 0:
        return "price 必须为正", None, None, None, None
    if qty <= 0 or qty % 100 != 0:
        return "qty 必须是 100 的正整数倍", None, None, None, None
    if price * qty > MAX_ORDER_CNY:
        return f"单笔 {price*qty:.0f} 元超过上限 {MAX_ORDER_CNY:.0f} 元（QMT_MAX_ORDER_CNY）", None, None, None, None
    return None, code, side, price, qty


class Handler(BaseHTTPRequestHandler):
    def _send(self, obj, status=200):
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _authed(self):
        return (not TOKEN) or self.headers.get("x-auth") == TOKEN

    def do_GET(self):
        if not self._authed():
            return self._send({"error": "x-auth 不匹配"}, 401)
        if self.path == "/status":
            return self._send({
                "mode": MODE,
                "xtquant": xt is not None or MODE == "mock",
                "connected": xt_trader is not None,
                "account": ACCOUNT or None,
                "maxOrderCny": MAX_ORDER_CNY,
            })
        if self.path == "/orders":
            with state_lock:
                return self._send({"orders": orders_ledger[-200:]})
        return self._send({"error": "not found"}, 404)

    def do_POST(self):
        if not self._authed():
            return self._send({"error": "x-auth 不匹配"}, 401)
        if self.path != "/order":
            return self._send({"error": "not found"}, 404)
        try:
            length = int(self.headers.get("content-length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._send({"error": "body 必须是 JSON"}, 400)

        err, code, side, price, qty = validate(body)
        if err:
            return self._send({"accepted": False, "mode": MODE, "error": err}, 400)

        entry = {
            "ts": datetime.now().isoformat(timespec="seconds"),
            "signalId": str(body.get("signalId", "")),
            "code": code,
            "side": side,
            "price": price,
            "qty": qty,
            "remark": str(body.get("remark", "")),
            "mode": MODE,
        }

        if MODE == "live":
            if not xt_trader:
                return self._send({"accepted": False, "mode": MODE, "error": "xtquant 未连接，拒绝委托"}, 503)
            seq = submit_live(code, side, price, qty)
            entry["brokerOrderId"] = str(seq)
            append_ledger(entry)
            log("LIVE 委托已提交", code, side, qty, "@", price, "seq=", seq)
            return self._send({"accepted": True, "mode": MODE, "brokerOrderId": str(seq)})

        # mock / dry：记录并应答，绝不下单
        entry["brokerOrderId"] = f"{MODE.upper()}-{uuid.uuid4().hex[:8]}"
        append_ledger(entry)
        log(f"{MODE} 记录委托（不下单）", code, side, qty, "@", price, "signalId=", entry["signalId"])
        return self._send({"accepted": True, "mode": MODE, "brokerOrderId": entry["brokerOrderId"]})

    def log_message(self, *a):  # 静默默认访问日志，自己打更干净的
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["mock", "dry", "live"], default="mock")
    ap.add_argument("--account", default=os.environ.get("QMT_ACCOUNT", ""))
    ap.add_argument("--port", type=int, default=int(os.environ.get("QMT_SIDECAR_PORT", "3011")))
    args = ap.parse_args()
    MODE = args.mode
    ACCOUNT = args.account

    if MODE == "live" and os.environ.get("QMT_CONFIRM") != CONFIRM_PHRASE:
        log("拒绝启动 live：需要环境变量 QMT_CONFIRM=I-KNOW-THIS-IS-REAL")
        raise SystemExit(2)
    if MODE in ("dry", "live"):
        try_connect_xtquant(ACCOUNT)

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    log(f"sidecar up mode={MODE} :{args.port} 上限={MAX_ORDER_CNY:.0f}元/笔 台账={ledger_path()}")
    server.serve_forever()
