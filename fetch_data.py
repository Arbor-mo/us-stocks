# -*- coding: utf-8 -*-
"""
Growth Rings 数据管线
====================
数据源：
  1. 席勒百年数据 ie_data.xls（1871-2023.09 月度价格/股息/盈利/CAPE/CPI）—— 稳定、权威
  2. FRED 免 key CSV（标普500每日、VIX、GDP、WALCL 等）—— 官方、可实时，但有严格限流
  3. yfinance（纳指100、七巨头、风格ETF）—— 备用，常被限流

设计原则：
  * 核心历史面板（走势/年回报/回撤/席勒PE/EPS/牛熊/滚动收益率）完全由席勒数据驱动，永远可用
  * 实时数据（最新点位/VIX）优先 FRED，失败则回退到本地缓存，绝不因限流而整体失败
  * 每次运行把结果写成 data/*.json，前端离线渲染
"""
import os
import json
import time
import sqlite3
import datetime as dt

import numpy as np
import pandas as pd
import requests

# ---------------------------------------------------------------------------
# 常量与路径
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
RAW_DIR = os.path.join(BASE_DIR, "data", "raw")
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(RAW_DIR, exist_ok=True)

SHILLER_URL = "http://www.econ.yale.edu/~shiller/data/ie_data.xls"
SHILLER_PATH = os.path.join(RAW_DIR, "ie_data.xls")
DAILY_CSV = os.path.join(RAW_DIR, "gspc_daily.csv")

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

# 参考网站（Big Picture）数据源：直接抓取其打包好的 JSON，失败时回退到原始源
REF_BASE = "https://laoqianritan-create-github-io.pages.dev"
REF_VIX_URL = REF_BASE + "/data/sp500_vix.json"
REF_PE_URL = REF_BASE + "/data/sp500_pe.json"
REF_EPS_URL = REF_BASE + "/data/sp500_eps.json"
DB_PATH = os.path.join(DATA_DIR, "history.db")

# 代理配置（Yahoo 对大陆地域封锁，走本地代理绕过）
PROXY_URL = "http://127.0.0.1:7897"


def enable_proxy():
    """本地代理可选：探测端口可通才启用，否则直连。
    云端 runner（GitHub Actions）没有本地代理，必须直连。"""
    if not PROXY_URL:
        return
    import socket
    from urllib.parse import urlparse

    u = urlparse(PROXY_URL)
    try:
        with socket.create_connection((u.hostname, u.port or 80), timeout=2):
            pass
    except OSError:
        print(f"  [info] 代理 {PROXY_URL} 不可通，改用直连")
        return
    os.environ["HTTP_PROXY"] = PROXY_URL
    os.environ["HTTPS_PROXY"] = PROXY_URL
    os.environ["http_proxy"] = PROXY_URL
    os.environ["https_proxy"] = PROXY_URL


# ---------------------------------------------------------------------------
# 通用工具
# ---------------------------------------------------------------------------
def fetch(url, timeout=40, retries=3):
    """带重试的 GET，返回 Response 或 None。"""
    last = None
    for i in range(retries):
        try:
            r = requests.get(url, timeout=timeout, headers=HEADERS)
            if r.status_code == 200:
                return r
            last = r
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(3 * (i + 1))
    print(f"  [warn] fetch failed: {url[:80]} -> {last}")
    return None


def fred_series(series_id, fallback=None):
    """
    拉取 FRED 序列（免 key 的 fredgraph.csv）。
    返回 (pd.Series, last_date) 或 (fallback, None)。
    数据可能带缺口，转成数值。
    """
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
    r = fetch(url)
    if r is None:
        return fallback, None
    try:
        df = pd.read_csv(
            pd.io.common.BytesIO(r.content),
            parse_dates=["observation_date"],
        )
        s = df.set_index("observation_date").iloc[:, 0]
        s = pd.to_numeric(s, errors="coerce").dropna()
        s = s[~s.index.duplicated(keep="last")].sort_index()
        return s, s.index[-1]
    except Exception as e:  # noqa: BLE001
        print(f"  [warn] fred_series parse fail {series_id}: {e}")
        return fallback, None


def multpl_series(url):
    """
    拉取 multpl.com 的标普500 估值序列（PE / PB）。
    返回按日期升序的 Series，可能为空。
    """
    import re
    r = fetch(url, timeout=40)
    if r is None:
        return pd.Series(dtype=float)
    txt = r.text
    tds = re.findall(r"<td[^>]*>(.*?)</td>", txt, re.S)
    pairs = []
    for td in tds:
        # 去掉 <abbr> 等嵌套标签，只留纯文本
        clean = re.sub(r"<[^>]+>", "", td)
        clean = clean.replace("&#x2002;", "").replace("&nbsp;", "").strip()
        if re.match(r"^[A-Z][a-z]{2} \d{1,2}, \d{4}$", clean):
            pairs.append([clean, None])
        elif pairs and pairs[-1][1] is None:
            # 值可能带 † 号（估算标记），剥掉非数字字符
            val = re.sub(r"[^0-9.\-]", "", clean)
            try:
                pairs[-1][1] = float(val)
            except ValueError:
                pass
    data = {}
    for d, v in pairs:
        if v is not None:
            try:
                data[pd.to_datetime(d)] = v
            except Exception:  # noqa: BLE001
                pass
    return pd.Series(data).sort_index()


def fetch_reference_vix():
    """
    抓取参考网站的 VIX 日频数据（2000 至今）。
    返回 (series_dict, last_date, last_value)；失败返回 (None, None, None)。
    """
    r = fetch(REF_VIX_URL, timeout=40)
    if r is None:
        return None, None, None
    try:
        j = r.json()
        series = j.get("series", [])
        data = {str(item["date"]): round(float(item["value"]), 2) for item in series}
        latest = j.get("latest") or {}
        last_date = latest.get("date")
        last_value = latest.get("value")
        if not data:
            return None, None, None
        if last_date is None:
            last_date = list(data.keys())[-1]
            last_value = list(data.values())[-1]
        return data, str(last_date), round(float(last_value), 2)
    except Exception as e:  # noqa: BLE001
        print(f"  [warn] fetch_reference_vix parse fail: {e}")
        return None, None, None


def fetch_reference_cape():
    """
    抓取参考网站的席勒市盈率 CAPE（1871 至今，月度）。
    返回 (series_dict, last_date, last_value)；失败返回 (None, None, None)。
    """
    r = fetch(REF_PE_URL, timeout=40)
    if r is None:
        return None, None, None
    try:
        j = r.json()
        cape = j.get("cape", [])
        data = {str(item["date"]): round(float(item["value"]), 2) for item in cape}
        if not data:
            return None, None, None
        last_date = list(data.keys())[-1]
        last_value = list(data.values())[-1]
        return data, last_date, round(float(last_value), 2)
    except Exception as e:  # noqa: BLE001
        print(f"  [warn] fetch_reference_cape parse fail: {e}")
        return None, None, None


def fetch_vix_with_fallback():
    """VIX：优先参考网站，失败回退 FRED VIXCLS。返回 (dict, last_date, last_value, source)。"""
    data, last_date, last_value = fetch_reference_vix()
    if data:
        return data, last_date, last_value, "reference"
    s, s_date = fred_series("VIXCLS")
    if s is not None and len(s) > 0:
        data = {str(d.date()): round(float(v), 2) for d, v in s.items()}
        last_date = str(s_date.date()) if s_date is not None else str(s.index[-1].date())
        return data, last_date, round(float(s.iloc[-1]), 2), "fred"
    return None, None, None, None


def fetch_cape_with_fallback():
    """CAPE：优先参考网站，失败回退 multpl Shiller PE。返回 (dict, last_date, last_value, source)。"""
    data, last_date, last_value = fetch_reference_cape()
    if data:
        return data, last_date, last_value, "reference"
    s = multpl_series("https://www.multpl.com/shiller-pe/table/by-month")
    if s is not None and len(s) > 0:
        data = {str(d.date()): round(float(v), 2) for d, v in s.items()}
        return data, str(s.index[-1].date()), round(float(s.iloc[-1]), 2), "multpl"
    return None, None, None, None


def fetch_reference_eps():
    """
    抓取参考网站的标普500 EPS（TTM，1871 至今，年频→季频）。
    返回 (series_dict, last_date, last_value)；失败返回 (None, None, None)。
    """
    r = fetch(REF_EPS_URL, timeout=40)
    if r is None:
        return None, None, None
    try:
        j = r.json()
        series = j.get("series", [])
        data = {str(item["date"]): round(float(item["value"]), 2) for item in series}
        if not data:
            return None, None, None
        last_date = list(data.keys())[-1]
        last_value = list(data.values())[-1]
        return data, last_date, round(float(last_value), 2)
    except Exception as e:  # noqa: BLE001
        print(f"  [warn] fetch_reference_eps parse fail: {e}")
        return None, None, None


def fetch_eps_with_fallback():
    """EPS：优先参考网站，失败回退席勒 xls 的 E 列（月度）。返回 (dict, last_date, last_value, source)。"""
    data, last_date, last_value = fetch_reference_eps()
    if data:
        return data, last_date, last_value, "reference"
    return None, None, None, None


def save_snapshot(vix_info, cape_info, eps_info):
    """把本次抓取的 VIX/CAPE/EPS 快照写入 SQLite，供追溯历史。"""
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.execute("""CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fetched_at TEXT,
            vix_last REAL, vix_last_date TEXT, vix_count INTEGER, vix_source TEXT,
            cape_last REAL, cape_last_date TEXT, cape_count INTEGER, cape_source TEXT
        )""")
        # 迁移：为旧表补齐 eps 列
        cols = {r[1] for r in conn.execute("PRAGMA table_info(snapshots)")}
        for col, typ in [("eps_last", "REAL"), ("eps_last_date", "TEXT"),
                         ("eps_count", "INTEGER"), ("eps_source", "TEXT")]:
            if col not in cols:
                conn.execute(f"ALTER TABLE snapshots ADD COLUMN {col} {typ}")
        conn.execute(
            "INSERT INTO snapshots (fetched_at, vix_last, vix_last_date, vix_count, vix_source, "
            "cape_last, cape_last_date, cape_count, cape_source, "
            "eps_last, eps_last_date, eps_count, eps_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (dt.datetime.now().isoformat(timespec="seconds"),
             vix_info["last"], vix_info["last_date"], vix_info["count"], vix_info["source"],
             cape_info["last"], cape_info["last_date"], cape_info["count"], cape_info["source"],
             eps_info["last"], eps_info["last_date"], eps_info["count"], eps_info["source"]),
        )
        conn.commit()
        conn.close()
    except Exception as e:  # noqa: BLE001
        print(f"  [warn] save_snapshot fail: {e}")


def load_shiller():
    """下载/加载席勒数据，返回清理后的月度 DataFrame。"""
    if not os.path.exists(SHILLER_PATH):
        r = fetch(SHILLER_URL, timeout=90)
        if r is None:
            raise RuntimeError("无法下载席勒数据 ie_data.xls")
        with open(SHILLER_PATH, "wb") as f:
            f.write(r.content)
    raw = pd.read_excel(SHILLER_PATH, sheet_name="Data", header=7)
    df = raw.dropna(subset=["Date"]).copy()
    df["Date"] = pd.to_numeric(df["Date"], errors="coerce")
    df = df.dropna(subset=["Date"])
    # Date 形如 1871.01，拆成年月。小数部分就是月份（1871.10 = 10 月），
    # 用 *100 而非 *12；round 消除浮点误差后再取整。
    year = df["Date"].astype(int)
    month = ((df["Date"] - year) * 100).round().astype(int)
    df["dt"] = pd.to_datetime(dict(year=year, month=month, day=1))
    for col in ["P", "D", "E", "CPI", "CAPE", "Rate GS10"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.sort_values("dt").reset_index(drop=True)
    return df


# ---------------------------------------------------------------------------
# 各类指标计算（全部基于席勒月度数据，保证百年历史）
# ---------------------------------------------------------------------------
def build_price_series(df):
    """标普500 名义价格 + 实际价格(通胀调整) + 等权近似(无，这里用对数)"""
    s = df.set_index("dt")["P"].dropna()
    return s


def build_annual_returns(price):
    """年度涨跌幅（价格口径）。键为纯年份。"""
    yearly = price.resample("YE").last()
    ret = yearly.pct_change().dropna() * 100
    return {y.year: round(float(v), 2) for y, v in ret.items()}


def build_annual_distribution(annual):
    """把每一年按涨幅装进区间，返回计数。"""
    bins = [(-100, -40), (-40, -20), (-20, -10), (-10, 0), (0, 10),
            (10, 20), (20, 30), (30, 40), (40, 50), (50, 100), (100, 9999)]
    labels = ["<-40%", "-40~-20", "-20~-10", "-10~0", "0~10",
              "10~20", "20~30", "30~40", "40~50", "50~100", ">100%"]
    counts = {lab: 0 for lab in labels}
    years = []
    for y, v in annual.items():
        years.append(y)
        for (lo, hi), lab in zip(bins, labels):
            if lo <= v < hi:
                counts[lab] += 1
                break
    return counts, labels


def build_annualized_matrix(price):
    """跨年持有年化收益率矩阵（年末点位）。"""
    yearly = price.resample("YE").last().dropna()
    years = [int(y) for y in yearly.index.year]
    vals = yearly.values
    n = len(years)
    mat = []
    for i in range(n):  # 买入年
        row = []
        for j in range(n):  # 卖出年
            if j <= i:
                row.append(None)
            else:
                yrs = years[j] - years[i]
                cagr = (vals[j] / vals[i]) ** (1.0 / yrs) - 1
                row.append(round(cagr * 100, 2))
        mat.append(row)
    return years, mat


def build_drawdown(price):
    """自历史高点回撤序列（月度）。"""
    running_max = price.cummax()
    dd = (price / running_max - 1) * 100
    return dd


def build_drawdown_events(price):
    """
    回撤 >= 10% 的重大事件。
    以「价格重新创新高」为事件边界：每个 running_max 的台阶（新高）作为一个峰值，
    在台阶区间内找最低点，跌幅 = 最低 / 峰值 - 1。中途的短暂反弹不会截断谷底。
    """
    running_max = price.cummax()
    n = len(price)
    idx = price.index
    events = []

    # running_max 创新高的位置（台阶起点）
    steps = running_max.diff() > 0
    step_dates = steps.index[steps].tolist()

    for k in range(len(step_dates)):
        start = step_dates[k]
        end = step_dates[k + 1] if k + 1 < len(step_dates) else idx[-1]
        peak = running_max.loc[start]
        seg = price.loc[start:end]
        trough = seg.min()
        trough_date = seg.idxmin()
        decline = (trough / peak - 1) * 100
        if decline > -10:
            continue
        # 找恢复：从谷底往后找价格重新 >= 峰值的日期
        after = price.loc[trough_date:]
        rec = after[after >= peak]
        recovered = len(rec) > 0
        rec_date = rec.index[0] if recovered else None
        events.append({
            "peak_date": str(start.date()),
            "trough_date": str(trough_date.date()),
            "peak": round(float(peak), 1),
            "trough": round(float(trough), 1),
            "decline": round(float(decline), 1),
            "trough_days": int((trough_date - start).days),
            "recovery_days": int((rec_date - start).days) if recovered else None,
            "recovered": recovered,
        })
    return events


def build_volatility(price, freq="monthly"):
    """20日/60日年化波动率。freq 决定年化因子：daily 用 √252，monthly 用 √12。"""
    ret = price.pct_change()
    if freq == "daily":
        vol20 = ret.rolling(20).std() * np.sqrt(252) * 100
        vol60 = ret.rolling(60).std() * np.sqrt(252) * 100
    else:
        vol20 = ret.rolling(20).std() * np.sqrt(12) * 100
        vol60 = ret.rolling(60).std() * np.sqrt(12) * 100
    return vol20, vol60


def build_cape(df):
    s = df.set_index("dt")["CAPE"].dropna()
    return s


def build_eps(df):
    s = df.set_index("dt")["E"].dropna()
    return s


def build_bull_bear(price):
    """
    以 ±20% 划分牛熊（月度粒度）。
    牛市 = 从上一个谷底涨到峰值；熊市 = 从上一个峰值跌到谷底。
    """
    phases = []
    state = "bull"
    peak = price.iloc[0]
    peak_date = price.index[0]
    trough = price.iloc[0]
    trough_date = price.index[0]
    cur_start_val = price.iloc[0]
    cur_start_date = price.index[0]

    for d, v in price.items():
        if state == "bull":
            if v > peak:
                peak = v
                peak_date = d
            if v <= peak * 0.80:  # 从峰值回落 20% → 转熊
                phases.append({"type": "bull", "start": str(cur_start_date.date()),
                               "end": str(peak_date.date()),
                               "ret": round((peak / cur_start_val - 1) * 100, 1)})
                state = "bear"
                trough = v
                trough_date = d
                cur_start_val = peak
                cur_start_date = peak_date
        else:
            if v < trough:
                trough = v
                trough_date = d
            if v >= trough * 1.20:  # 从谷底反弹 20% → 转牛
                phases.append({"type": "bear", "start": str(cur_start_date.date()),
                               "end": str(trough_date.date()),
                               "ret": round((trough / cur_start_val - 1) * 100, 1)})
                state = "bull"
                peak = v
                peak_date = d
                cur_start_val = trough
                cur_start_date = trough_date

    last = price.iloc[-1]
    phases.append({"type": state, "start": str(cur_start_date.date()),
                   "end": str(price.index[-1].date()),
                   "ret": round((last / cur_start_val - 1) * 100, 1)})
    return phases


def build_rolling_returns(price, freq="monthly"):
    """
    任意时点往回看 N 年的年化回报。
    freq="daily" 按交易日回看（1年≈252交易日），"monthly" 按月回看。
    """
    out = {}
    per_year = 252 if freq == "daily" else 12
    for ny in [1, 5, 7, 10, 20]:
        shift_n = ny * per_year
        shifted = price.shift(shift_n)
        cagr = (price / shifted) ** (1.0 / ny) - 1
        cagr = cagr.dropna() * 100
        out[str(ny)] = {str(d.date()): round(float(v), 2) for d, v in cagr.items()}
    return out


def build_total_return(price, dividend):
    """
    总回报指数（含股息再投资）。逐月累乘：
    index[t] = index[t-1] * (P[t] + D[t]/12) / P[t-1]
    股息按当年总额除以 12 摊到每月，近似"按月再投资"。
    """
    # 对齐到同一索引
    df = pd.DataFrame({"price": price, "div": dividend}).dropna()
    # 月股息 = 年股息 / 12
    monthly_div = df["div"] / 12.0
    # 总回报指数（基期 100）
    ratio = (df["price"] + monthly_div) / df["price"].shift(1)
    ratio.iloc[0] = 1.0
    tr_index = ratio.cumprod() * 100.0
    return tr_index


def build_intrayear_drawdown(price):
    """
    每年"峰到谷"的最大回撤，以及当年全年涨跌幅、创新高次数。
    返回 {year: {peak_date, trough_date, dd_pct, return_pct, new_highs}}。
    用日历年内最高点 vs 之后的最低点。
    """
    out = {}
    yearly = price.resample("YE")
    for year_ts, year_series in price.groupby(price.index.year):
        if len(year_series) < 2:
            continue
        running_max = year_series.cummax()
        dd = (year_series / running_max - 1) * 100
        trough_idx = dd.idxmin()
        peak_val = running_max.loc[trough_idx]
        peak_idx = year_series[year_series >= peak_val].index[0] if (year_series >= peak_val).any() else year_series.index[0]
        # 全年涨跌幅
        first = year_series.iloc[0]
        last = year_series.iloc[-1]
        ret = (last / first - 1) * 100
        # 创新高次数（严格高于之前所有值）
        new_highs = 0
        mx = -np.inf
        for v in year_series:
            if v > mx:
                mx = v
                new_highs += 1
        out[year_ts] = {
            "peak_date": str(peak_idx.date()),
            "trough_date": str(trough_idx.date()),
            "dd": round(float(dd.loc[trough_idx]), 2),
            "ret": round(float(ret), 2),
            "new_highs": int(new_highs),
        }
    return out


def build_dividend_yield(price, dividend):
    """股息率 = 年股息 / 价格。返回月度 Series（%）。"""
    df = pd.DataFrame({"price": price, "div": dividend}).dropna()
    return df["div"] / df["price"] * 100.0


def build_recessions():
    """从 FRED 拉 NBER 衰退区间，返回 [[start, end], ...]（YYYY-MM-DD 字符串）。"""
    s, _ = fred_series("USRECD")
    if s is None or len(s) == 0:
        return []
    periods = []
    in_rec = False
    start = None
    for d, v in s.items():
        if v == 1 and not in_rec:
            start = d
            in_rec = True
        elif v == 0 and in_rec:
            periods.append([str(start.date()), str(d.date())])
            in_rec = False
    if in_rec:
        periods.append([str(start.date()), str(s.index[-1].date())])
    return periods


def build_treasury_yield():
    """10 年期国债收益率：FRED DGS10 日频，失败回退席勒 GS10 月度。返回 dict。"""
    s, _ = fred_series("DGS10")
    if s is not None and len(s) > 0:
        return {str(d.date()): round(float(v), 2) for d, v in s.items()}
    return None


def fetch_dividend_yield():
    """
    标普500 股息率：优先 multpl 月度（1871 至今），失败回退席勒 D/P（仅到 2023.06）。
    返回月度 Series（%，索引为月初）。
    """
    s = multpl_series("https://www.multpl.com/s-p-500-dividend-yield/table/by-month")
    if s is not None and len(s) > 0:
        return s, "multpl"
    return None, None


def build_total_return_from_yield(price, div_yield):
    """
    用股息率（月度，%）重建总回报指数（含股息再投资）。
    股息率索引可能是月末（multpl），先按 YYYY-MM 归一到月初与 price 对齐。
    index[t] = index[t-1] * (1 + price_ret[t]) * (1 + yield[t]/100/12)
    """
    # 把股息率归一化到月初（与 price 索引一致）
    dy = div_yield.copy()
    dy.index = dy.index.to_period("M").to_timestamp()
    # price 延伸后可能是月末（FRED resample ME），同样归一到月初
    p = price.copy()
    p.index = p.index.to_period("M").to_timestamp()
    df = pd.DataFrame({"price": p, "yld": dy}).dropna()
    price_ret = df["price"].pct_change().fillna(0.0)
    div_ret = df["yld"] / 100.0 / 12.0
    monthly_ret = (1 + price_ret) * (1 + div_ret) - 1
    tr_index = (1 + monthly_ret).cumprod() * 100.0
    return tr_index


def build_monthly_gs10():
    """10 年期国债收益率月度序列：FRED GS10（1953+）补齐席勒 GS10（1871-1953 空缺段）。返回月度 Series（%）。"""
    # 席勒 GS10（月初，1871-2023）
    raw = pd.read_excel(SHILLER_PATH, sheet_name="Data", header=7)
    sh = raw.dropna(subset=["Date"]).copy()
    sh["Date"] = pd.to_numeric(sh["Date"], errors="coerce")
    sh = sh.dropna(subset=["Date"])
    y = sh["Date"].astype(int)
    m = ((sh["Date"] - y) * 100).round().astype(int)
    sh["dt"] = pd.to_datetime(dict(year=y, month=m, day=1))
    gs10_shiller = pd.to_numeric(sh.set_index("dt")["Rate GS10"], errors="coerce").dropna()

    # FRED GS10 月度（月初，1953+）
    s, _ = fred_series("GS10")
    if s is None or len(s) == 0:
        return gs10_shiller
    s.index = s.index.to_period("M").to_timestamp()

    # 合并：FRED 优先，早期用席勒
    combined = pd.concat([gs10_shiller, s])
    combined = combined[~combined.index.duplicated(keep="last")].sort_index()
    return combined


def build_yield_spread(div_yield, gs10):
    """股债利差 = 股息率 - 10年期国债收益率（百分点）。返回月度 Series。"""
    dy = div_yield.copy()
    dy.index = dy.index.to_period("M").to_timestamp()
    g = gs10.copy()
    g.index = g.index.to_period("M").to_timestamp()
    df = pd.DataFrame({"dy": dy, "gs10": g}).dropna()
    return df["dy"] - df["gs10"]


# ---------------------------------------------------------------------------
# 实时数据（FRED + yfinance，失败降级）
# ---------------------------------------------------------------------------
def build_realtime():
    """返回 (rt dict, spx_daily Series)。spx_daily 用于延伸价格序列。"""
    rt = {}
    spx_daily = None
    # 标普500每日点位（FRED 稳定源）
    spx, last_date = fred_series("SP500")
    if spx is not None and len(spx) > 0:
        spx_daily = spx
        rt["spx_daily"] = {str(d.date()): round(float(v), 2) for d, v in spx.items()}
        rt["spx_last_date"] = str(last_date.date())
        rt["spx_last"] = round(float(spx.iloc[-1]), 2)
    # VIX
    vix, vix_date = fred_series("VIXCLS")
    if vix is not None and len(vix) > 0:
        rt["vix_daily"] = {str(d.date()): round(float(v), 2) for d, v in vix.items()}
        rt["vix_last"] = round(float(vix.iloc[-1]), 2)
        rt["vix_last_date"] = str(vix_date.date()) if vix_date is not None else str(vix.index[-1].date())
    return rt, spx_daily


def extend_price(price, spx_daily):
    """
    用 FRED 每日数据把价格序列从席勒末尾(2023.09)延伸到今天。
    每月取月末值，去重、只取席勒末尾之后的日期。
    """
    if spx_daily is None or len(spx_daily) == 0:
        return price
    monthly = spx_daily.resample("ME").last().dropna()
    # FRED 月末 → 月初，与席勒(月初)对齐，避免同月出现两个标签
    monthly.index = monthly.index.to_period("M").to_timestamp()
    monthly = monthly[monthly.index > price.index[-1]]
    if len(monthly) == 0:
        return price
    extended = pd.concat([price, monthly])
    extended = extended[~extended.index.duplicated(keep="last")].sort_index()
    return extended


def load_local_daily():
    """读本地缓存的每日数据 CSV，返回 Series（可能为 None）。"""
    if os.path.exists(DAILY_CSV):
        try:
            df = pd.read_csv(DAILY_CSV, parse_dates=["date"])
            s = pd.Series(df["close"].values, index=pd.to_datetime(df["date"]))
            s = pd.to_numeric(s, errors="coerce").dropna()
            s = s[~s.index.duplicated(keep="last")].sort_index()
            return s
        except Exception:  # noqa: BLE001
            return None
    return None


def save_daily(s):
    """把每日 Series 存到本地 CSV。"""
    df = pd.DataFrame({"date": s.index, "close": s.values})
    df.to_csv(DAILY_CSV, index=False)


def fetch_yfinance(start=None):
    """
    静默下载 ^GSPC 每日收盘价。
    start=None 时全量（period=max），否则只拉 start 之后（增量）。
    返回 Series 或 None。
    """
    try:
        import contextlib
        import io
        import yfinance as yf
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            if start:
                d = yf.download("^GSPC", start=start, interval="1d",
                                progress=False, auto_adjust=False)
            else:
                d = yf.download("^GSPC", period="max", interval="1d",
                                progress=False, auto_adjust=False)
        if d is not None and len(d) > 0:
            close = d["Close"]
            if isinstance(close, pd.DataFrame):
                close = close.iloc[:, 0]
            close = pd.to_numeric(close, errors="coerce").dropna()
            close.index = pd.to_datetime(close.index)
            close = close[~close.index.duplicated(keep="last")].sort_index()
            return close
    except Exception:  # noqa: BLE001
        pass
    return None


def build_daily_price(spx_daily):
    """
    获取每日价格序列（用于走势图），带本地持久化 + 增量更新：
      * 首次：yfinance 全量下载（1927 至今）并存入 CSV
      * 之后：只拉「本地最后日期 → 今天」的增量，合并去重存回
      * yfinance 失败（限流）时回退到 FRED 每日，或用本地缓存兜底
    """
    local = load_local_daily()

    if local is not None and len(local) > 1000:
        # 已有完整本地缓存 → 增量更新
        start = (local.index[-1] + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
        inc = fetch_yfinance(start)
        if inc is not None and len(inc) > 0:
            new = pd.concat([local, inc])
            new = new[~new.index.duplicated(keep="last")].sort_index()
            save_daily(new)
            print(f"  [daily] 增量更新：本地 {len(local)} 天 + 新增 {len(inc)} 天 "
                  f"= {len(new)} 天（{new.index[0].date()} ~ {new.index[-1].date()}）")
            return new
        else:
            print(f"  [daily] 增量获取失败（可能限流），沿用本地缓存 {len(local)} 天 "
                  f"（{local.index[0].date()} ~ {local.index[-1].date()}）")
            return local

    # 没有完整本地缓存 → 首次全量下载
    full = fetch_yfinance(None)
    if full is not None and len(full) > 1000:
        save_daily(full)
        print(f"  [daily] 首次全量下载：{len(full)} 天 "
              f"（{full.index[0].date()} ~ {full.index[-1].date()}），已存入本地 CSV")
        return full

    # yfinance 失败（限流），回退 FRED 每日
    if spx_daily is not None and len(spx_daily) > 0:
        print(f"  [daily] yfinance 不可用，回退 FRED：{len(spx_daily)} 天 "
              f"（{spx_daily.index[0].date()} ~ {spx_daily.index[-1].date()}）")
        return spx_daily

    # 本地有零星缓存也兜底
    if local is not None and len(local) > 0:
        return local
    return None


def build_analysis_series(monthly_price, daily):
    """
    混合分析序列：早期用月度（席勒），近期用每日（yfinance/FRED）。
    用于回撤、牛熊周期等对采样频率不敏感、但希望近期有每日精度的指标。
    返回 Series（1871 至今，前段月度 + 后段每日）。
    """
    if daily is None or len(daily) == 0:
        return monthly_price
    monthly_part = monthly_price[monthly_price.index < daily.index[0]]
    combined = pd.concat([monthly_part, daily])
    combined = combined[~combined.index.duplicated(keep="last")].sort_index()
    return combined


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def main():
    enable_proxy()
    print("== Growth Rings 数据更新 ==")
    print(dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))

    print("[1/4] 加载席勒百年数据 ...")
    df = load_shiller()
    price = build_price_series(df)

    print("[2/4] 拉取实时数据 (FRED) ...")
    realtime, spx_daily = build_realtime()

    print("[3/5] 延伸价格序列到最新并计算指标 ...")
    price = extend_price(price, spx_daily)
    daily = build_daily_price(spx_daily)
    # 回撤/牛熊等指标用混合序列（早期月度 + 近期每日）
    analysis = build_analysis_series(price, daily)
    annual = build_annual_returns(price)
    dist_counts, dist_labels = build_annual_distribution(annual)
    years, matrix = build_annualized_matrix(price)
    dd = build_drawdown(analysis)
    events = build_drawdown_events(analysis)
    # 波动率：仅当拿到 yfinance 全量每日(约2.5万天，1927至今)才用日频√252；
    # 否则(如FRED仅2016起2514天)用月频√12，避免丢失百年历史
    use_daily = daily is not None and len(daily) > 10000
    if use_daily:
        vol20, vol60 = build_volatility(daily, freq="daily")
    else:
        vol20, vol60 = build_volatility(price, freq="monthly")
    cape = build_cape(df)
    eps = build_eps(df)
    # 股息率：优先 multpl（1871 至今），回退席勒 D/P（仅到 2023.06）
    div_yield_series, div_src = fetch_dividend_yield()
    if div_yield_series is None:
        # 回退：席勒 D 列股息率
        dividend = df.set_index("dt")["D"].dropna()
        div_yield_series = build_dividend_yield(price, dividend)
        div_src = "shiller_xls"
    total_return = build_total_return_from_yield(price, div_yield_series)
    div_yield = div_yield_series
    intrayear = build_intrayear_drawdown(price)
    recessions = build_recessions()
    treasury = build_treasury_yield()
    # 股债利差：股息率 - 10 年期国债收益率（月度）
    gs10_monthly = build_monthly_gs10()
    yield_spread = build_yield_spread(div_yield_series, gs10_monthly)
    phases = build_bull_bear(analysis)
    # 滚动收益率：同上，日频需足够长的每日序列
    if use_daily:
        rolling = build_rolling_returns(daily, freq="daily")
    else:
        rolling = build_rolling_returns(price, freq="monthly")

    print("[3.5/5] 拉取 SPY 市盈率/市净率 (multpl) ...")
    spy_pe = multpl_series("https://www.multpl.com/s-p-500-pe-ratio/table/by-month")
    spy_pb = multpl_series("https://www.multpl.com/s-p-500-price-to-book/table/by-quarter")

    print("[3.6/5] 抓取 VIX、CAPE 与 EPS（参考站，失败回退） ...")
    vix_series, vix_last_date, vix_last, vix_src = fetch_vix_with_fallback()
    cape_series, cape_last_date, cape_last, cape_src = fetch_cape_with_fallback()
    eps_series, eps_last_date, eps_last, eps_src = fetch_eps_with_fallback()

    # 抓取 CAPE 失败时回退到席勒 xls 旧数据，避免面板空掉
    if cape_series:
        cape_payload = {
            "series": cape_series,
            "last": cape_last,
            "last_date": cape_last_date,
            "source": cape_src,
        }
    else:
        cape_payload = {
            "series": {str(d.date()): round(float(v), 2) for d, v in cape.items()},
            "last": round(float(cape.iloc[-1]), 2),
            "last_date": str(cape.index[-1].date()),
            "source": "shiller_xls",
        }

    # EPS：抓取失败时回退到席勒 xls 的 E 列（月度），避免面板空掉
    if eps_series:
        eps_payload = {
            "series": eps_series,
            "last": eps_last,
            "last_date": eps_last_date,
            "source": eps_src,
        }
    else:
        eps_payload = {
            "series": {str(d.date()): round(float(v), 2) for d, v in eps.items()},
            "last": round(float(eps.iloc[-1]), 2),
            "last_date": str(eps.index[-1].date()),
            "source": "shiller_xls",
        }

    payload = {
        "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
        "source": "Shiller (1871-2023.09) + FRED",
        "price": {
            "monthly": {str(d.date()): round(float(v), 2) for d, v in price.items()},
            "daily": {str(d.date()): round(float(v), 2) for d, v in daily.items()} if daily is not None else {},
            "daily_start": str(daily.index[0].date()) if daily is not None else None,
            "daily_end": str(daily.index[-1].date()) if daily is not None else None,
            "start": str(price.index[0].date()),
            "end": str(price.index[-1].date()),
        },
        "annual_returns": annual,
        "annual_distribution": {"labels": dist_labels, "counts": dist_counts},
        "annualized_matrix": {"years": years, "matrix": matrix},
        "drawdown": {
            "series": {str(d.date()): round(float(v), 2) for d, v in dd.items()},
            "events": events,
        },
        "volatility": {
            "vol20": {str(d.date()): round(float(v), 2) for d, v in vol20.dropna().items()},
            "vol60": {str(d.date()): round(float(v), 2) for d, v in vol60.dropna().items()},
        },
        "cape": cape_payload,
        "vix": {
            "series": vix_series if vix_series else {},
            "last": vix_last,
            "last_date": vix_last_date,
            "source": vix_src,
        },
        "eps": eps_payload,
        "bull_bear_phases": phases,
        "analysis_price": {str(d.date()): round(float(v), 2) for d, v in analysis.items()},
        "rolling_returns": rolling,
        "total_return": {str(d.date()): round(float(v), 2) for d, v in total_return.items()},
        "dividend_yield": {str(d.date()): round(float(v), 2) for d, v in div_yield.items()},
        "yield_spread": {str(d.date()): round(float(v), 2) for d, v in yield_spread.items()},
        "intrayear_drawdown": intrayear,
        "recessions": recessions,
        "treasury_yield": treasury,
        "spy_pe": {str(d.date()): round(float(v), 2) for d, v in spy_pe.items()},
        "spy_pb": {str(d.date()): round(float(v), 2) for d, v in spy_pb.items()},
        "realtime": realtime,
    }

    print("[4/5] 写入 JSON ...")
    for name in ["price", "annual_returns", "annual_distribution", "annualized_matrix",
                 "drawdown", "volatility", "cape", "vix", "eps", "bull_bear_phases",
                 "rolling_returns", "total_return", "dividend_yield", "yield_spread",
                 "intrayear_drawdown", "recessions", "treasury_yield", "spy_pe", "spy_pb", "analysis_price"]:
        fp = os.path.join(DATA_DIR, name + ".json")
        with open(fp, "w", encoding="utf-8") as f:
            json.dump(payload[name], f, ensure_ascii=False)
    fp = os.path.join(DATA_DIR, "realtime.json")
    with open(fp, "w", encoding="utf-8") as f:
        json.dump(payload["realtime"], f, ensure_ascii=False)
    fp = os.path.join(DATA_DIR, "meta.json")
    with open(fp, "w", encoding="utf-8") as f:
        json.dump({"generated_at": payload["generated_at"], "source": payload["source"]},
                  f, ensure_ascii=False)

    # 额外生成 data/data.js，供 file:// 双击打开时用 <script> 加载（绕过 fetch 跨域限制）
    js_payload = {
        "price": payload["price"],
        "annual_returns": payload["annual_returns"],
        "annual_distribution": payload["annual_distribution"],
        "annualized_matrix": payload["annualized_matrix"],
        "drawdown": payload["drawdown"],
        "volatility": payload["volatility"],
        "cape": payload["cape"],
        "vix": payload["vix"],
        "eps": payload["eps"],
        "bull_bear_phases": payload["bull_bear_phases"],
        "analysis_price": payload["analysis_price"],
        "rolling_returns": payload["rolling_returns"],
        "total_return": payload["total_return"],
        "dividend_yield": payload["dividend_yield"],
        "yield_spread": payload["yield_spread"],
        "intrayear_drawdown": payload["intrayear_drawdown"],
        "recessions": payload["recessions"],
        "treasury_yield": payload["treasury_yield"],
        "spy_pe": payload["spy_pe"],
        "spy_pb": payload["spy_pb"],
        "realtime": payload["realtime"],
        "meta": {"generated_at": payload["generated_at"], "source": payload["source"]},
    }
    fp = os.path.join(DATA_DIR, "data.js")
    with open(fp, "w", encoding="utf-8") as f:
        f.write("window.BIG_PICTURE_DATA = ")
        f.write(json.dumps(js_payload, ensure_ascii=False))
        f.write(";\n")

    save_snapshot(
        {"last": vix_last, "last_date": vix_last_date,
         "count": len(vix_series) if vix_series else 0, "source": vix_src},
        {"last": cape_payload["last"], "last_date": cape_payload["last_date"],
         "count": len(cape_payload["series"]), "source": cape_payload["source"]},
        {"last": eps_payload["last"], "last_date": eps_payload["last_date"],
         "count": len(eps_payload["series"]), "source": eps_payload["source"]},
    )

    print("完成。SPX 最新：", payload["realtime"].get("spx_last", "未取到"),
          " CAPE 最新：", payload["cape"]["last"],
          " VIX 最新：", payload["vix"].get("last", "未取到"),
          " EPS 最新：", payload["eps"].get("last", "未取到"))


if __name__ == "__main__":
    main()
