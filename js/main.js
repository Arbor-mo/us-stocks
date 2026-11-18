// Growth Rings 前端渲染
(function () {
  "use strict";

  const RED = "#dc2626";
  const GREEN = "#22c55e";
  const BLUE = "#3b82f6";
  const AMBER = "#f59e0b";
  const TEXT = "#9aa4af";

  const charts = {};

  // ---------- 工具 ----------
  function objOf(obj) {
    if (!obj) return [];
    return Object.keys(obj).map((k) => ({ date: k, value: obj[k] }));
  }
  // category 轴配置：密集标签（自动隐藏重叠，强制显示最新）
  function catAxis(dates) {
    return {
      type: "category",
      data: dates,
      axisLine: { lineStyle: { color: "#2a313b" } },
      axisLabel: { color: TEXT, hideOverlap: true, showMaxLabel: true },
      splitLine: { show: false },
    };
  }
  function valAxis(extra) {
    return Object.assign(
      { type: "value", axisLine: { lineStyle: { color: "#2a313b" } }, axisLabel: { color: TEXT }, splitLine: { lineStyle: { color: "#20262e" } } },
      extra || {}
    );
  }
  function fmt(v, d) {
    d = d == null ? 2 : d;
    if (v == null || isNaN(v)) return "-";
    return Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtPct(v, d) {
    d = d == null ? 2 : d;
    if (v == null || isNaN(v)) return "-";
    return Number(v).toFixed(d) + "%";
  }
  // ---------- 对数视图辅助（仅 S&P 500 长周期走势图的对数模式使用） ----------
  // 目标：对数轴的刻度既「圆整」（0 结尾的整数）、又「间距相等」。
  // 这两个要求只有在刻度值构成等比数列时才能兼得，而十进制下圆整的比值只有 10 / 5 / 4 / 2.5 / 2。
  //   · 跨度大   → 10 的整数次幂（1 / 10 / 100 / 1,000 / 10,000）
  //   · 跨度中等 → ×2 等比阶梯（1,000 / 2,000 / 4,000 / 8,000）—— 2 是最细的圆整比值
  //   · 跨度太小 → ×2 会稀疏到把数据挤在图顶，退回十进制圆整步长
  //               （只在跨度 < 约 0.13 个数量级时发生，此时对数与线性的差异在万分之五以内）
  const NICE_MULTS = [1, 2, 2.5, 5];

  // 线性圆整刻度：与价格模式（scale:true）一致的 nice 步长，1/2/5×10^k，约 5 段。
  function linearTickPlan(vmin, vmax) {
    const rough = (vmax - vmin) / 5;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    let step;
    for (const n of [1, 2, 5, 10]) {
      if (mag * n >= rough) { step = mag * n; break; }
    }
    const min = Math.floor(vmin / step) * step;
    const max = Math.ceil(vmax / step) * step;
    return { mode: "value", step, min, max };
  }

  // 返回 { mode:"log", ratio, min, max } 或 { mode:"value", step, min, max }
  function logTickPlan(vmin, vmax) {
    const span = Math.log10(vmax) - Math.log10(vmin);
    // 短期区间（价格跨度 < 10 倍）：对数与线性差异微小，直接沿用价格模式的
    // 线性圆整刻度，间隔细密均匀，避免 ×2 等比把刻度拉稀。
    if (span < 1) return linearTickPlan(vmin, vmax);
    let best = null;

    function better(a, b) {
      if (a.fill > b.fill + 1e-9) return true;
      if (a.fill < b.fill - 1e-9) return false;
      if (a.u < b.u - 1e-9) return true;
      if (a.u > b.u + 1e-9) return false;
      if (a.nice !== b.nice) return a.nice < b.nice;
      return a.balance < b.balance - 1e-9;
    }

    function consider(plan, ticks, nice) {
      const n = ticks.length;
      if (n < 3 || n > 6) return;
      if (ticks[0] > vmin || ticks[n - 1] < vmax) return;
      const ls = ticks.map(Math.log10);
      let gMin = Infinity, gMax = 0;
      for (let i = 1; i < n; i++) {
        const g = ls[i] - ls[i - 1];
        if (g < gMin) gMin = g;
        if (g > gMax) gMax = g;
      }
      const cand = {
        u: gMax / gMin,                                  // 1 = 完全等距
        fill: span / (ls[n - 1] - ls[0]),                // 数据占图高比：越大越不浪费空间
        nice: nice,                                      // 首个刻度的「圆整度」，1 > 2 > 2.5 > 5
        balance: Math.abs(Math.log10(vmin / ticks[0]) + Math.log10(ticks[n - 1] / vmax)),
        plan: plan,
      };
      if (cand.u > 1.35) return;                         // 间距差超 35% 直接淘汰
      if (!best || better(cand, best)) best = cand;
    }

    for (let k = -3; k <= 7; k++) {
      for (let mi = 0; mi < NICE_MULTS.length; mi++) {
        const anchor = NICE_MULTS[mi] * Math.pow(10, k);

        // a) 十进制圆整步长
        const s = anchor;
        const first = Math.floor(vmin / s) * s;
        const last = Math.ceil(vmax / s) * s;
        const cnt = Math.round((last - first) / s) + 1;
        if (cnt >= 3 && cnt <= 6) {
          const ticks = [];
          for (let i = 0; i < cnt; i++) ticks.push(first + i * s);
          consider({ mode: "value", step: s, min: first, max: last }, ticks, mi);
        }

        // b) 等比阶梯：×2 与 ×10。只向上取（j ≥ 0），
        //    否则从 0.001 翻倍 21 次会得到 2097.152 这种不圆整的值。
        for (let ri = 0; ri < 2; ri++) {
          const ratio = ri === 0 ? 2 : 10;
          const ladder = [];
          for (let j = 0; j <= 5; j++) ladder.push(anchor * Math.pow(ratio, j));
          for (let a = 0; a < ladder.length; a++) {
            for (let b = a + 2; b < ladder.length; b++) {
              const seg = ladder.slice(a, b + 1);
              consider({ mode: "log", ratio: ratio, min: seg[0], max: seg[seg.length - 1] }, seg, mi);
            }
          }
        }
      }
    }
    return best ? best.plan : null;
  }

  function round6(v) {
    return Number(v.toFixed(6));
  }
  // 等比模式：轴上的值是 log10(价格)，标签要还原成价格
  function fmtPow10(v) {
    const x = Math.pow(10, v);
    if (Number.isInteger(x)) return fmt(x, 0);
    return x >= 100 ? fmt(x, 0) : fmt(x, 2);
  }
  // 十进制模式：轴上就是价格本身
  function fmtInt(v) {
    return fmt(v, Number.isInteger(v) ? 0 : 2);
  }

  function load(name) {
    return fetch("data/" + name + ".json").then((r) => r.json());
  }
  function getData() {
    if (window.BIG_PICTURE_DATA) return Promise.resolve(window.BIG_PICTURE_DATA);
    return Promise.all([
      load("price"), load("annual_returns"), load("annual_distribution"),
      load("annualized_matrix"), load("drawdown"), load("volatility"),
      load("cape"), load("eps"), load("bull_bear_phases"),
      load("rolling_returns"), load("spy_pe"), load("spy_pb"),
      load("analysis_price"), load("realtime"), load("meta"), load("vix"),
      load("total_return"), load("dividend_yield"), load("intrayear_drawdown"),
      load("recessions"), load("treasury_yield"), load("yield_spread"),
    ]).then(([price, annual, dist, matrix, drawdown, vol, cape, eps, phases, rolling, spy_pe, spy_pb, analysis_price, realtime, meta, vix, total_return, dividend_yield, intrayear_drawdown, recessions, treasury_yield, yield_spread]) => ({
      price, annual_returns: annual, annual_distribution: dist,
      annualized_matrix: matrix, drawdown, volatility: vol, cape, eps,
      bull_bear_phases: phases, rolling_returns: rolling, spy_pe, spy_pb,
      analysis_price, realtime, meta, vix,
      total_return, dividend_yield, intrayear_drawdown, recessions, treasury_yield, yield_spread,
    }));
  }

  // ---------- 走势图 ----------
  function renderPrice(price) {
    const monthly = objOf(price.monthly);   // 1871 至今（月度）
    const daily = objOf(price.daily);       // 1927 至今（每日）
    const chart = echarts.init(document.getElementById("chartPrice"));
    charts.price = chart;

    const RANGES = [
      { key: "all", label: "全部", days: Infinity },
      { key: "10y", label: "近10年", days: 3650 },
      { key: "5y", label: "近5年", days: 1825 },
      { key: "3y", label: "近3年", days: 1095 },
      { key: "1y", label: "近1年", days: 365 },
      { key: "6m", label: "近6月", days: 182 },
      { key: "3m", label: "近3月", days: 91 },
      { key: "1m", label: "近1月", days: 30 },
    ];

    let currentRange = "all";
    let currentScale = "price";

    function getData() {
      // 「全部」区间 = 1871 起月度 + 1927 起每日（前段月度补足早期，近期保持每日）；
      // 其余区间直接取每日切片
      const r = RANGES.find((x) => x.key === currentRange);
      const end = daily[daily.length - 1].date;
      const cutoff = new Date(end).getTime() - r.days * 86400000;
      const dailySlice = daily.filter((d) => new Date(d.date).getTime() >= cutoff);
      if (currentRange === "all") {
        const pre = monthly.filter((d) => d.date < daily[0].date);
        return pre.concat(daily);
      }
      return dailySlice;
    }

    function build() {
      const data = getData();
      const dates = data.map((d) => d.date);
      const lineWidth = currentRange === "all" ? 0.9 : 1.4;
      let values, yAxis, tipValue;

      if (currentScale === "log") {
        // 对数视图：先挑一套「圆整 + 等距」的刻度网格，再决定怎么渲染。
        // 不能直接用 type:"log"：ECharts 对数轴的刻度间隔被强制为 ≥1 个数量级，
        // 且手动指定 min/max 时会把两个原始端点也补成刻度，
        // 结果是中间没有横线、刻度间距也不均匀。
        const raw = data.map((d) => d.value);
        const plan = logTickPlan(Math.min(...raw), Math.max(...raw));
        if (plan && plan.mode === "log") {
          // 等比网格：把 log10 值再按 log10(比值) 归一化，刻度就落在整数上。
          // interval 取 1 是精确整数运算 —— ECharts 不会因浮点误差多补一个端点刻度（那会造成重复标签）。
          const stepLog = Math.log10(plan.ratio);
          const baseLog = Math.log10(plan.min);
          const k = Math.round((Math.log10(plan.max) - baseLog) / stepLog);
          values = raw.map((v) => (Math.log10(v) - baseLog) / stepLog);
          yAxis = valAxis({
            min: 0,
            max: k,
            interval: 1,
            axisLabel: { color: TEXT, formatter: (v) => fmtPow10(baseLog + v * stepLog) },
          });
          tipValue = (v) => fmt(Math.pow(10, baseLog + v * stepLog));
        } else {
          // 十进制圆整网格（只在跨度极小时胜出）→ 直接用原始价格，interval = 步长
          const p = plan || { step: 500, min: Math.floor(Math.min(...raw) / 500) * 500, max: Math.ceil(Math.max(...raw) / 500) * 500 };
          values = raw;
          yAxis = valAxis({
            min: round6(p.min),
            max: round6(p.max),
            interval: p.step,
            axisLabel: { color: TEXT, formatter: fmtInt },
          });
          tipValue = (v) => fmt(v);
        }
      } else if (currentScale === "pct") {
        const base = data[0].value;
        values = data.map((d) => ((d.value / base) - 1) * 100);
        yAxis = valAxis({ axisLabel: { color: TEXT, formatter: "{value}%" } });
        tipValue = (v) => v.toFixed(2) + "%";
      } else {
        values = data.map((d) => d.value);
        yAxis = valAxis({ scale: true });
        tipValue = (v) => fmt(v);
      }

      return {
        grid: { left: 70, right: 64, top: 30, bottom: 78 },
        xAxis: catAxis(dates),
        yAxis,
        series: [{
          type: "line", data: values, showSymbol: false,
          lineStyle: { color: BLUE, width: lineWidth }, areaStyle: { opacity: 0.12, color: BLUE },
        }],
        tooltip: {
          trigger: "axis",
          formatter: (p) => `${p[0].axisValue}<br>${tipValue(p[0].value)}`,
        },
        dataZoom: [{ type: "inside" }],
      };
    }

    chart.setOption(build());

    function renderSummary() {
      const data = getData();
      const first = data[0].value;
      const last = data[data.length - 1].value;
      const lastDate = data[data.length - 1].date;
      const firstDate = data[0].date;
      const years = (new Date(data[data.length - 1].date) - new Date(data[0].date)) / (365.25 * 24 * 3600 * 1000);
      const cagr = years > 0 ? (Math.pow(last / first, 1 / years) - 1) * 100 : 0;
      const granularity = currentRange === "all" ? "月度1871-1926 + 每日1927起" : "每日";
      document.getElementById("priceSummary").innerHTML = `
        <div class="metric"><div class="metric-label">最新点位（${lastDate}）</div><div class="metric-value">${fmt(last)}</div></div>
        <div class="metric"><div class="metric-label">区间起点（${firstDate}）</div><div class="metric-value">${fmt(first)}</div></div>
        <div class="metric"><div class="metric-label">区间年化回报</div><div class="metric-value ${cagr >= 0 ? "positive" : "negative"}">${fmtPct(cagr)}</div></div>
        <div class="metric"><div class="metric-label">数据粒度</div><div class="metric-value">${granularity}</div></div>
      `;
    }
    renderSummary();

    document.querySelectorAll("#priceRangeToggle .btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#priceRangeToggle .btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        currentRange = btn.dataset.range;
        chart.setOption(build(), true);
        renderSummary();
      });
    });
    document.querySelectorAll("#priceScaleToggle .btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#priceScaleToggle .btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        currentScale = btn.dataset.scale;
        chart.setOption(build(), true);
      });
    });
  }

  // ---------- 估值（PE/PB） ----------
  function renderValuation(spy_pe, spy_pb) {
    const pe = objOf(spy_pe);
    const pb = objOf(spy_pb);
    const chart = echarts.init(document.getElementById("chartValuation"));
    let current = "pe";

    function draw() {
      const data = current === "pe" ? pe : pb;
      const color = current === "pe" ? AMBER : BLUE;
      const mean = data.reduce((a, b) => a + b.value, 0) / data.length;
      chart.setOption({
        grid: { left: 60, right: 64, top: 30, bottom: 78 },
        xAxis: catAxis(data.map((d) => d.date)),
        yAxis: valAxis({ scale: true }),
        series: [{
          type: "line", data: data.map((d) => d.value), showSymbol: false,
          lineStyle: { color, width: 1.4 }, areaStyle: { opacity: 0.10, color },
          markLine: {
            silent: true, symbol: "none",
            label: { color: TEXT, formatter: "均值 " + mean.toFixed(1) },
            lineStyle: { color: TEXT, type: "dashed" },
            data: [{ yAxis: mean }],
          },
        }],
        tooltip: { trigger: "axis", valueFormatter: (v) => fmt(v) },
      }, true);

      const last = data[data.length - 1].value;
      const lastDate = data[data.length - 1].date;
      const max = Math.max(...data.map((d) => d.value));
      const min = Math.min(...data.map((d) => d.value));
      document.getElementById("valuationSummary").innerHTML = `
        <div class="metric"><div class="metric-label">最新 ${current === "pe" ? "PE" : "PB"}（${lastDate}）</div><div class="metric-value">${fmt(last)}</div></div>
        <div class="metric"><div class="metric-label">历史均值</div><div class="metric-value">${fmt(mean, 1)}</div></div>
        <div class="metric"><div class="metric-label">历史最高</div><div class="metric-value negative">${fmt(max, 1)}</div></div>
        <div class="metric"><div class="metric-label">历史最低</div><div class="metric-value positive">${fmt(min, 1)}</div></div>
      `;
    }
    draw();
    document.querySelectorAll("#valuationToggle .btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#valuationToggle .btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        current = btn.dataset.metric;
        draw();
      });
    });
  }

  // ---------- 恐慌指数 VIX ----------
  function renderVix(vix, price) {
    const vixData = objOf((vix && vix.series) || {});
    const priceData = objOf((price && price.daily) || {});
    if (!vixData.length || !priceData.length) return;

    // 按日期内连接（两者均为美股交易日）
    const priceMap = {};
    priceData.forEach((d) => { priceMap[d.date] = d.value; });
    const joined = vixData
      .filter((d) => priceMap[d.date] != null)
      .map((d) => ({ date: d.date, vix: d.value, price: priceMap[d.date] }));
    if (!joined.length) return;

    const dates = joined.map((d) => d.date);
    const vixValues = joined.map((d) => d.vix);
    const priceValues = joined.map((d) => d.price);

    // 标出 VIX > 30 的连续恐慌区间
    const markAreas = [];
    let segStart = null;
    for (let i = 0; i < vixValues.length; i++) {
      const panic = vixValues[i] > 30;
      if (panic && segStart == null) segStart = dates[i];
      if (!panic && segStart != null) {
        markAreas.push([
          { xAxis: segStart, itemStyle: { color: "rgba(220,38,38,0.15)" } },
          { xAxis: dates[i - 1] },
        ]);
        segStart = null;
      }
    }
    if (segStart != null) {
      markAreas.push([
        { xAxis: segStart, itemStyle: { color: "rgba(220,38,38,0.15)" } },
        { xAxis: dates[dates.length - 1] },
      ]);
    }

    const chart = echarts.init(document.getElementById("chartVix"));
    charts.vix = chart;
    const vixMean = vixValues.reduce((a, b) => a + b, 0) / vixValues.length;
    chart.setOption({
      grid: { left: 70, right: 70, top: 40, bottom: 78 },
      legend: { textStyle: { color: TEXT }, top: 0 },
      xAxis: catAxis(dates),
      yAxis: [
        valAxis({ type: "log", logBase: 10, name: "标普500", nameTextStyle: { color: TEXT } }),
        valAxis({ name: "VIX", nameTextStyle: { color: TEXT }, splitLine: { show: false } }),
      ],
      series: [
        {
          name: "标普500", type: "line", yAxisIndex: 0, data: priceValues,
          showSymbol: false, lineStyle: { color: BLUE, width: 1.2 },
        },
        {
          name: "VIX", type: "line", yAxisIndex: 1, data: vixValues,
          showSymbol: false, lineStyle: { color: AMBER, width: 1.2 },
          markArea: { silent: true, data: markAreas },
          markLine: {
            silent: true, symbol: "none",
            label: { color: TEXT, formatter: "均值 " + vixMean.toFixed(1) },
            lineStyle: { color: TEXT, type: "dashed" },
            data: [{ yAxis: vixMean }],
          },
        },
      ],
      tooltip: {
        trigger: "axis",
        formatter: (p) => {
          let s = p[0].axisValue;
          p.forEach((it) => {
            s += `<br>${it.seriesName}: ${it.seriesName === "VIX" ? fmt(it.value, 2) : fmt(it.value)}`;
          });
          return s;
        },
      },
      dataZoom: [{ type: "inside" }],
    });

    const last = vixValues[vixValues.length - 1];
    const panicDays = vixValues.filter((v) => v > 30).length;
    const lastPrice = priceValues[priceValues.length - 1];
    const lastDate = dates[dates.length - 1];
    document.getElementById("vixSummary").innerHTML = `
      <div class="metric"><div class="metric-label">最新 VIX（${lastDate}）</div><div class="metric-value">${fmt(last, 2)}</div></div>
      <div class="metric"><div class="metric-label">历史均值</div><div class="metric-value">${fmt(vixMean, 2)}</div></div>
      <div class="metric"><div class="metric-label">VIX>30 天数占比</div><div class="metric-value negative">${(panicDays / vixValues.length * 100).toFixed(1)}%</div></div>
      <div class="metric"><div class="metric-label">标普500 最新（${lastDate}）</div><div class="metric-value">${fmt(lastPrice)}</div></div>
    `;
  }

  // ---------- 年度回报 ----------
  function renderAnnual(annual, totalReturn) {
    const years = Object.keys(annual).map(Number).sort((a, b) => a - b);
    const values = years.map((y) => annual[String(y)]);

    // 从总回报指数（月度，基期 100）推导年度总回报
    const trData = objOf(totalReturn || {});
    const trAnnual = {};
    if (trData.length) {
      const byYear = {};
      trData.forEach((d) => { byYear[d.date.slice(0, 4)] = d.value; });
      const trYears = Object.keys(byYear).map(Number).sort((a, b) => a - b);
      for (let i = 1; i < trYears.length; i++) {
        const prev = byYear[String(trYears[i - 1])];
        const cur = byYear[String(trYears[i])];
        if (prev && cur) trAnnual[String(trYears[i])] = (cur / prev - 1) * 100;
      }
    }

    const chart = echarts.init(document.getElementById("chartAnnual"));
    const currentYear = new Date().getFullYear();
    const lastYear = years[years.length - 1];
    let mode = "price";

    function draw() {
      const useTr = mode === "total";
      const data = useTr ? trAnnual : annual;
      const ys = useTr ? Object.keys(data).map(Number).sort((a, b) => a - b) : years;
      const vals = ys.map((y) => data[String(y)]);
      const xLabels = ys.map((y) => (y === lastYear && y === currentYear ? y + " YTD" : y));
      chart.setOption({
        grid: { left: 60, right: 64, top: 30, bottom: 78 },
        xAxis: { type: "category", data: xLabels, axisLine: { lineStyle: { color: "#2a313b" } }, axisLabel: { color: TEXT, hideOverlap: true } },
        yAxis: valAxis({ axisLabel: { color: TEXT, formatter: "{value}%" } }),
        series: [{
          type: "bar", data: vals.map((v) => ({ value: v, itemStyle: { color: v >= 0 ? GREEN : RED } })),
          tooltip: { valueFormatter: (v) => fmtPct(v, 1) },
        }],
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      }, true);

      const pos = vals.filter((v) => v >= 0).length;
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const best = Math.max(...vals);
      const worst = Math.min(...vals);
      const bestYear = ys[vals.indexOf(best)];
      const worstYear = ys[vals.indexOf(worst)];
      const label = useTr ? "总回报（含股息）" : "价格回报";
      document.getElementById("annualSummary").innerHTML = `
        <div class="metric"><div class="metric-label">口径</div><div class="metric-value">${label}</div></div>
        <div class="metric"><div class="metric-label">上涨年份占比</div><div class="metric-value">${(pos / vals.length * 100).toFixed(0)}%</div></div>
        <div class="metric"><div class="metric-label">年度均值</div><div class="metric-value ${avg >= 0 ? "positive" : "negative"}">${fmtPct(avg)}</div></div>
        <div class="metric"><div class="metric-label">最好年份（${bestYear}）</div><div class="metric-value positive">+${fmtPct(best)}</div></div>
        <div class="metric"><div class="metric-label">最差年份（${worstYear}）</div><div class="metric-value negative">${fmtPct(worst)}</div></div>
      `;
    }
    draw();

    document.querySelectorAll("#annualToggle .btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#annualToggle .btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        mode = btn.dataset.mode;
        draw();
      });
    });
  }

  // ---------- 年度回报分布 ----------
  function renderAnnualDist(dist) {
    const chart = echarts.init(document.getElementById("chartAnnualDist"));
    const labels = dist.labels;
    const counts = labels.map((l) => dist.counts[l]);
    const total = counts.reduce((a, b) => a + b, 0);
    const colors = labels.map((l) => {
      if (l.startsWith("-") || l.startsWith("<")) return RED;
      if (l === "0~10" || l === "10~20") return GREEN;
      return AMBER;
    });
    chart.setOption({
      grid: { left: 50, right: 64, top: 30, bottom: 80 },
      xAxis: { type: "category", data: labels, axisLine: { lineStyle: { color: "#2a313b" } }, axisLabel: { color: TEXT, interval: 0, fontSize: 10 } },
      yAxis: valAxis(),
      series: [{
        type: "bar", data: counts.map((c, i) => ({ value: c, itemStyle: { color: colors[i] } })),
        label: { show: true, position: "top", color: "#fff", fontSize: 11, formatter: (p) => (p.value > 0 ? p.value : "") },
      }],
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, formatter: (p) => `${p[0].name}: ${p[0].value} 年（${(p[0].value / total * 100).toFixed(0)}%）` },
    });
    document.getElementById("distSummary").innerHTML = `
      <div class="metric"><div class="metric-label">统计年数</div><div class="metric-value">${total}</div></div>
      <div class="metric"><div class="metric-label">正收益年份</div><div class="metric-value positive">${labels.slice(4).reduce((a, l) => a + dist.counts[l], 0)} 年</div></div>
      <div class="metric"><div class="metric-label">负收益年份</div><div class="metric-value negative">${labels.slice(0, 4).reduce((a, l) => a + dist.counts[l], 0)} 年</div></div>
    `;
  }

  // ---------- 年化矩阵 ----------
  function renderMatrix(matrix) {
    const years = matrix.years;
    const mat = matrix.matrix;
    const container = document.getElementById("annualizedMatrix");
    let html = '<table class="matrix-table"><thead><tr><th class="corner">买入\\卖出</th>';
    years.forEach((y) => { html += `<th>${y}</th>`; });
    html += "</tr></thead><tbody>";
    for (let i = 0; i < years.length; i++) {
      html += `<tr><td class="row-label">${years[i]}</td>`;
      for (let j = 0; j < years.length; j++) {
        const v = mat[i][j];
        if (v == null) {
          html += '<td></td>';
        } else {
          const color = v >= 0 ? `rgba(34,197,94,${Math.min(0.15 + Math.abs(v) / 25, 1)})` : `rgba(220,38,38,${Math.min(0.15 + Math.abs(v) / 25, 1)})`;
          html += `<td><span class="matrix-cell" style="background:${color}" title="买入 ${years[i]} 卖出 ${years[j]}：${v.toFixed(1)}%">${v.toFixed(0)}%</span></td>`;
        }
      }
      html += "</tr>";
    }
    html += "</tbody></table>";
    container.innerHTML = html;
  }

  // ---------- 回撤 ----------
  function renderDrawdown(dd) {
    const data = objOf(dd.series);
    const chart = echarts.init(document.getElementById("chartDrawdown"));
    chart.setOption({
      grid: { left: 60, right: 64, top: 30, bottom: 78 },
      xAxis: catAxis(data.map((d) => d.date)),
      yAxis: valAxis({ axisLabel: { color: TEXT, formatter: "{value}%" }, max: 0 }),
      series: [{
        type: "line", data: data.map((d) => d.value), showSymbol: false,
        lineStyle: { color: RED, width: 1 }, areaStyle: { color: RED, opacity: 0.25 },
      }],
      tooltip: { trigger: "axis", valueFormatter: (v) => fmtPct(v, 1) },
      dataZoom: [{ type: "inside" }],
    });

    const tbody = document.getElementById("drawdownTbody");
    const events = dd.events.filter((e) => e.decline <= -10).sort((a, b) => (a.peak_date > b.peak_date ? 1 : -1));
    tbody.innerHTML = events.map((e) => `
      <tr>
        <td>${e.peak_date} ~ ${e.trough_date}</td>
        <td class="num">${e.peak.toLocaleString()}</td>
        <td class="num">${e.trough.toLocaleString()}</td>
        <td class="num">${e.trough_days}</td>
        <td class="num neg">${e.decline.toFixed(1)}%</td>
        <td class="num">${e.recovery_days == null ? "未恢复" : e.recovery_days}</td>
      </tr>
    `).join("");
  }

  // ---------- 波动率 ----------
  function renderVolatility(vol) {
    const d20 = objOf(vol.vol20);
    const chart = echarts.init(document.getElementById("chartVolatility"));
    chart.setOption({
      grid: { left: 60, right: 64, top: 30, bottom: 78 },
      xAxis: catAxis(d20.map((d) => d.date)),
      yAxis: valAxis({ axisLabel: { color: TEXT, formatter: "{value}%" } }),
      series: [
        { name: "20日", type: "line", data: d20.map((d) => d.value), showSymbol: false, lineStyle: { color: BLUE, width: 1 } },
        { name: "60日", type: "line", data: objOf(vol.vol60).map((d) => d.value), showSymbol: false, lineStyle: { color: AMBER, width: 1 } },
      ],
      tooltip: { trigger: "axis", valueFormatter: (v) => fmtPct(v, 1) },
      legend: { textStyle: { color: TEXT }, top: 0 },
      dataZoom: [{ type: "inside" }],
    });
  }

  // ---------- CAPE（叠加标普500点位） ----------
  function renderCape(cape, price) {
    const chart = echarts.init(document.getElementById("chartCape"));
    charts.cape = chart;
    const capeData = objOf(cape.series || {}).filter((d) => d.value != null);
    const priceData = objOf((price && price.monthly) || {}).filter((d) => d.value != null);
    if (!capeData.length) return;

    // 按月对齐（CAPE 与标普月度序列都取 YYYY-MM）
    const priceMap = {};
    priceData.forEach((d) => { priceMap[d.date.slice(0, 7)] = d.value; });
    const capeDates = capeData.map((d) => d.date);
    const capeValues = capeData.map((d) => d.value);
    const priceValues = capeData.map((d) => (priceMap[d.date.slice(0, 7)] != null ? priceMap[d.date.slice(0, 7)] : null));

    const maxCape = Math.max(...capeValues) + 2;
    const latest = capeData[capeData.length - 1];
    const peak = capeData.reduce((b, d) => (!b || d.value > b.value ? d : b), null);
    const trough = capeData.reduce((b, d) => (!b || d.value < b.value ? d : b), null);
    const capeMean = capeValues.reduce((a, b) => a + b, 0) / capeValues.length;
    // 标普500 叠加线最后一个非空点（与 CAPE 同月对齐），保证日期和值对应
    let spLastIdx = -1;
    for (let i = priceValues.length - 1; i >= 0; i--) {
      if (priceValues[i] != null) { spLastIdx = i; break; }
    }

    chart.setOption({
      grid: { left: 60, right: 70, top: 40, bottom: 78 },
      legend: { textStyle: { color: TEXT }, top: 0, data: ["席勒 CAPE", "标普500"] },
      xAxis: catAxis(capeDates),
      yAxis: [
        valAxis({ min: 0, max: maxCape, name: "CAPE", nameTextStyle: { color: TEXT } }),
        valAxis({ type: "log", logBase: 10, name: "标普500", nameTextStyle: { color: TEXT }, splitLine: { show: false } }),
      ],
      series: [
        {
          name: "席勒 CAPE", type: "line", yAxisIndex: 0, data: capeValues,
          showSymbol: false, lineStyle: { color: AMBER, width: 1.8 }, areaStyle: { opacity: 0.10, color: AMBER },
          markLine: {
            silent: true, symbol: "none",
            label: { color: TEXT, formatter: "均值 " + capeMean.toFixed(1) },
            lineStyle: { color: TEXT, type: "dashed" },
            data: [{ yAxis: capeMean }],
          },
          markPoint: {
            symbolSize: 44, label: { color: "#fff", fontSize: 10 },
            data: [
              { name: "历史高点", coord: [peak.date, peak.value], value: peak.value, itemStyle: { color: RED } },
              { name: "历史低点", coord: [trough.date, trough.value], value: trough.value, itemStyle: { color: GREEN } },
              { name: "最新", coord: [latest.date, latest.value], value: latest.value, itemStyle: { color: BLUE } },
            ],
          },
        },
        {
          name: "标普500", type: "line", yAxisIndex: 1, data: priceValues,
          showSymbol: false, lineStyle: { color: BLUE, width: 1.1, opacity: 0.85 }, connectNulls: false,
        },
      ],
      tooltip: {
        trigger: "axis",
        formatter: (p) => {
          let s = p[0].axisValue;
          p.forEach((it) => {
            const v = it.value;
            if (v == null) return;
            s += `<br>${it.seriesName}: ${it.seriesName === "标普500" ? fmt(v) : fmt(v, 2)}`;
          });
          return s;
        },
      },
      dataZoom: [{ type: "inside" }],
    });

    document.getElementById("capeSummary").innerHTML = `
      <div class="metric"><div class="metric-label">最新 CAPE（${latest.date}）</div><div class="metric-value">${fmt(latest.value, 2)}</div></div>
      <div class="metric"><div class="metric-label">历史均值</div><div class="metric-value">${fmt(capeMean, 1)}</div></div>
      <div class="metric"><div class="metric-label">历史高点（${peak.date}）</div><div class="metric-value negative">${fmt(peak.value, 1)}</div></div>
      <div class="metric"><div class="metric-label">历史低点（${trough.date}）</div><div class="metric-value positive">${fmt(trough.value, 1)}</div></div>
      <div class="metric"><div class="metric-label">标普500 最新（${spLastIdx >= 0 ? capeDates[spLastIdx] : "-"}）</div><div class="metric-value">${spLastIdx >= 0 ? fmt(priceValues[spLastIdx]) : "-"}</div></div>
    `;
  }

  // ---------- EPS（叠加标普500 + 同比增长率） ----------
  function renderEps(eps, price) {
    const chart = echarts.init(document.getElementById("chartEps"));
    charts.eps = chart;
    const epsAll = objOf((eps && eps.series) || {});
    const epsSeries = epsAll.filter((d) => d.value != null && d.value > 0);
    if (!epsSeries.length) return;
    const epsStart = epsSeries[0].date;

    // 标普500 月线对齐到 EPS 起点（对数视角，作为副轴对照）
    const spSeries = objOf((price && price.monthly) || {})
      .filter((d) => d.value != null && d.value > 0 && d.date >= epsStart);

    // EPS 同比增长率：查找一年前同月日的值
    const epsMap = {};
    epsAll.forEach((d) => { if (d.value != null) epsMap[d.date] = d.value; });
    const yoySeries = [];
    epsAll.forEach((d) => {
      if (d.value == null) return;
      const year = parseInt(d.date.slice(0, 4), 10);
      const prevKey = (year - 1) + d.date.slice(4);
      const prev = epsMap[prevKey];
      if (prev == null || prev === 0) return;
      yoySeries.push({ date: d.date, value: ((d.value - prev) / Math.abs(prev)) * 100 });
    });

    const epsData = epsSeries.map((d) => [d.date, d.value]);
    const spData = spSeries.map((d) => [d.date, d.value]);
    const yoyData = yoySeries.map((d) => [d.date, d.value]);

    chart.setOption({
      legend: { textStyle: { color: TEXT }, top: 0, data: ["标普500 EPS (TTM)", "标普500 指数（对数）", "EPS 同比增长率"] },
      grid: [
        { left: 64, right: 64, top: 40, height: "58%" },
        { left: 64, right: 64, top: "72%", height: "18%" },
      ],
      xAxis: [
        { type: "time", gridIndex: 0, axisLabel: { show: false }, axisLine: { lineStyle: { color: "#2a313b" } }, splitLine: { show: false } },
        { type: "time", gridIndex: 1, axisLabel: { color: TEXT, hideOverlap: true }, axisLine: { lineStyle: { color: "#2a313b" } }, splitLine: { show: false } },
      ],
      yAxis: [
        { type: "log", gridIndex: 0, name: "EPS ($)", nameTextStyle: { color: TEXT }, axisLabel: { color: TEXT }, splitLine: { lineStyle: { color: "#20262e" } } },
        { type: "log", gridIndex: 0, name: "标普500", position: "right", nameTextStyle: { color: TEXT }, axisLabel: { color: TEXT }, splitLine: { show: false } },
        { type: "value", gridIndex: 1, name: "YoY (%)", nameTextStyle: { color: TEXT }, axisLabel: { color: TEXT, formatter: "{value}%" }, splitLine: { lineStyle: { color: "#20262e" } } },
      ],
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      series: [
        { name: "标普500 EPS (TTM)", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: epsData, showSymbol: false, lineStyle: { color: GREEN, width: 2 }, z: 3 },
        { name: "标普500 指数（对数）", type: "line", xAxisIndex: 0, yAxisIndex: 1, data: spData, showSymbol: false, lineStyle: { color: BLUE, width: 1.2, opacity: 0.85 }, z: 3 },
        { name: "EPS 同比增长率", type: "bar", xAxisIndex: 1, yAxisIndex: 2, data: yoyData, barMaxWidth: 6, itemStyle: { color: (p) => (p.value[1] >= 0 ? GREEN : RED) }, z: 3 },
      ],
      tooltip: {
        trigger: "axis",
        formatter: (p) => {
          let s = p[0].axisValueLabel || "";
          p.forEach((it) => {
            const v = it.value;
            if (!v || v[1] == null) return;
            if (it.seriesName === "EPS 同比增长率") s += `<br>${it.seriesName}: ${fmtPct(v[1], 1)}`;
            else s += `<br>${it.seriesName}: ${it.seriesName === "标普500 指数（对数）" ? fmt(v[1]) : fmt(v[1], 2)}`;
          });
          return s;
        },
      },
      dataZoom: [{ type: "inside", xAxisIndex: [0, 1] }],
    });

    const last = epsSeries[epsSeries.length - 1];
    const latestYoy = yoySeries.length ? yoySeries[yoySeries.length - 1] : null;
    const lastSp = spSeries.length ? spSeries[spSeries.length - 1] : null;
    document.getElementById("epsSummary").innerHTML = `
      <div class="metric"><div class="metric-label">最新 EPS (TTM)（${last.date}）</div><div class="metric-value">${fmt(last.value, 2)}</div></div>
      <div class="metric"><div class="metric-label">EPS 同比</div><div class="metric-value ${latestYoy && latestYoy.value >= 0 ? "positive" : "negative"}">${latestYoy ? fmtPct(latestYoy.value, 1) : "-"}</div></div>
      <div class="metric"><div class="metric-label">标普500 最新（${lastSp ? lastSp.date : "-"}）</div><div class="metric-value">${lastSp ? fmt(lastSp.value) : "-"}</div></div>
      <div class="metric"><div class="metric-label">数据粒度</div><div class="metric-value">年频→季频（1871 起）</div></div>
    `;
  }

  // ---------- 牛熊周期 ----------
  function renderBullBear(phases, analysis_price) {
    const chart = echarts.init(document.getElementById("chartBullBear"));
    const data = objOf(analysis_price || {});

    const markAreas = phases.map((p) => [
      { xAxis: p.start, itemStyle: { color: p.type === "bull" ? "rgba(34,197,94,0.12)" : "rgba(220,38,38,0.12)" } },
      { xAxis: p.end },
    ]);

    const vmin = Math.min(...data.map((d) => d.value));
    const vmax = Math.max(...data.map((d) => d.value));
    chart.setOption({
      grid: { left: 70, right: 64, top: 30, bottom: 78 },
      xAxis: catAxis(data.map((d) => d.date)),
      yAxis: valAxis({ type: "log", logBase: 10, min: vmin * 0.95, max: vmax * 1.05 }),
      series: [{
        type: "line", data: data.map((d) => d.value), showSymbol: false,
        lineStyle: { color: BLUE, width: 1.5 },
        markArea: { silent: true, data: markAreas },
      }],
      tooltip: { trigger: "axis", valueFormatter: (v) => fmt(v) },
    });

    const recent = phases.slice(-12).reverse();
    const legendHtml = recent.map((p) => {
      const color = p.type === "bull" ? GREEN : RED;
      const label = p.type === "bull" ? "牛" : "熊";
      return `<span class="bb-item" style="color:${color}">${label} ${p.start} ~ ${p.end} <b>${p.ret >= 0 ? "+" : ""}${p.ret}%</b></span>`;
    }).join("");
    const el = document.createElement("div");
    el.className = "bb-legend";
    el.innerHTML = legendHtml;
    document.getElementById("panel-bull-bear").querySelector(".panel-inner").appendChild(el);
  }

  // ---------- 滚动收益率 ----------
  function renderRolling(rolling) {
    const chart = echarts.init(document.getElementById("chartRolling"));
    // 固定滚动窗口 = 10 年
    const allData = objOf(rolling["10"]);

    function draw() {
      const data = allData;
      chart.setOption({
        grid: { left: 60, right: 64, top: 30, bottom: 78 },
        xAxis: catAxis(data.map((d) => d.date)),
        yAxis: valAxis({ axisLabel: { color: TEXT, formatter: "{value}%" } }),
        series: [{ type: "line", data: data.map((d) => d.value), showSymbol: false, lineStyle: { color: BLUE, width: 1.5 } }],
        tooltip: { trigger: "axis", valueFormatter: (v) => fmtPct(v, 1) },
        dataZoom: [{ type: "inside" }],
      }, true);
    }
    draw();
  }

  // ---------- 年内最大回撤 vs 全年涨幅 ----------
  function renderIntrayearDrawdown(intrayear) {
    const chart = echarts.init(document.getElementById("chartIntrayear"));
    charts.intrayear = chart;
    const years = Object.keys(intrayear).map(Number).sort((a, b) => a - b);
    const ddVals = years.map((y) => intrayear[y].dd);
    const retVals = years.map((y) => intrayear[y].ret);

    chart.setOption({
      grid: { left: 60, right: 64, top: 30, bottom: 78 },
      legend: {
        textStyle: { color: TEXT }, top: 0,
        data: [
          { name: "全年涨幅", itemStyle: { color: GREEN } },
          { name: "年内最大回撤", itemStyle: { color: AMBER } },
        ],
      },
      xAxis: { type: "category", data: years.map(String), axisLine: { lineStyle: { color: "#2a313b" } }, axisLabel: { color: TEXT, hideOverlap: true } },
      yAxis: valAxis({ axisLabel: { color: TEXT, formatter: "{value}%" } }),
      series: [
        {
          name: "全年涨幅", type: "bar",
          itemStyle: { color: (p) => (p.value >= 0 ? GREEN : RED) },
          data: retVals.map((v) => ({ value: v })),
        },
        {
          name: "年内最大回撤", type: "bar",
          itemStyle: { color: AMBER },
          data: ddVals.map((v) => ({ value: v })),
        },
      ],
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (p) => {
          let s = p[0].axisValue;
          p.forEach((it) => { s += `<br>${it.seriesName}: ${fmtPct(it.value, 1)}`; });
          return s;
        },
      },
      dataZoom: [{ type: "inside" }],
    });

    const avg = ddVals.reduce((a, b) => a + b, 0) / ddVals.length;
    const worst = Math.min(...ddVals);
    const worstYear = years[ddVals.indexOf(worst)];
    const negYears = ddVals.filter((v) => v < -10).length;
    document.getElementById("intrayearSummary").innerHTML = `
      <div class="metric"><div class="metric-label">统计年数</div><div class="metric-value">${years.length}</div></div>
      <div class="metric"><div class="metric-label">年内回撤均值</div><div class="metric-value negative">${fmtPct(avg, 1)}</div></div>
      <div class="metric"><div class="metric-label">最深年内回撤（${worstYear}）</div><div class="metric-value negative">${fmtPct(worst, 1)}</div></div>
      <div class="metric"><div class="metric-label">回撤超 10% 年份</div><div class="metric-value">${negYears} 年</div></div>
    `;
  }

  // ---------- 10 年期国债收益率 ----------
  function renderTreasury(treasury) {
    const chart = echarts.init(document.getElementById("chartTreasury"));
    charts.treasury = chart;
    const data = objOf(treasury || {}).filter((d) => d.value != null);
    if (!data.length) return;

    const last = data[data.length - 1];
    const mean = data.reduce((a, b) => a + b.value, 0) / data.length;
    const max = Math.max(...data.map((d) => d.value));
    const min = Math.min(...data.map((d) => d.value));

    chart.setOption({
      grid: { left: 60, right: 64, top: 30, bottom: 78 },
      xAxis: catAxis(data.map((d) => d.date)),
      yAxis: valAxis({ axisLabel: { color: TEXT, formatter: "{value}%" } }),
      series: [{
        type: "line", data: data.map((d) => d.value), showSymbol: false,
        lineStyle: { color: AMBER, width: 1.4 }, areaStyle: { opacity: 0.10, color: AMBER },
      }],
      tooltip: { trigger: "axis", valueFormatter: (v) => fmt(v, 2) + "%" },
      dataZoom: [{ type: "inside" }],
    });

    document.getElementById("treasurySummary").innerHTML = `
      <div class="metric"><div class="metric-label">最新 10 年国债（${last.date}）</div><div class="metric-value">${fmt(last.value, 2)}%</div></div>
      <div class="metric"><div class="metric-label">历史均值</div><div class="metric-value">${fmt(mean, 2)}%</div></div>
      <div class="metric"><div class="metric-label">历史最高（1981）</div><div class="metric-value negative">${fmt(max, 2)}%</div></div>
      <div class="metric"><div class="metric-label">历史最低（2020）</div><div class="metric-value positive">${fmt(min, 2)}%</div></div>
    `;
  }

  // ---------- 股债利差 ----------
  function renderYieldSpread(spread) {
    const chart = echarts.init(document.getElementById("chartYieldSpread"));
    charts.yieldSpread = chart;
    const data = objOf(spread || {}).filter((d) => d.value != null);
    if (!data.length) return;

    const last = data[data.length - 1];
    const mean = data.reduce((a, b) => a + b.value, 0) / data.length;
    const max = Math.max(...data.map((d) => d.value));
    const min = Math.min(...data.map((d) => d.value));

    chart.setOption({
      grid: { left: 60, right: 64, top: 30, bottom: 78 },
      xAxis: catAxis(data.map((d) => d.date)),
      yAxis: valAxis({ axisLabel: { color: TEXT, formatter: "{value}%" } }),
      series: [{
        type: "line", data: data.map((d) => d.value), showSymbol: false,
        lineStyle: { color: BLUE, width: 1.4 }, areaStyle: { opacity: 0.10, color: BLUE },
        markLine: {
          silent: true, symbol: "none",
          label: { color: TEXT, formatter: "零轴" },
          lineStyle: { color: TEXT, type: "dashed" },
          data: [{ yAxis: 0 }],
        },
      }],
      tooltip: { trigger: "axis", valueFormatter: (v) => fmt(v, 2) + " 个百分点" },
      dataZoom: [{ type: "inside" }],
    });

    document.getElementById("yieldSpreadSummary").innerHTML = `
      <div class="metric"><div class="metric-label">最新利差（${last.date}）</div><div class="metric-value ${last.value >= 0 ? "positive" : "negative"}">${fmt(last.value, 2)} 个百分点</div></div>
      <div class="metric"><div class="metric-label">历史均值</div><div class="metric-value">${fmt(mean, 2)}</div></div>
      <div class="metric"><div class="metric-label">历史最高（股票最便宜）</div><div class="metric-value positive">${fmt(max, 2)}</div></div>
      <div class="metric"><div class="metric-label">历史最低（股票最贵）</div><div class="metric-value negative">${fmt(min, 2)}</div></div>
    `;
  }

  // ---------- Hero 徽章 ----------
  function renderBadges(cape, realtime) {
    const el = document.getElementById("heroBadges");
    const capeDates = Object.keys(cape.series || {});
    const capeDate = capeDates.length ? capeDates[capeDates.length - 1] : "";
    let html = "";
    if (realtime.spx_last) {
      html += `<div class="badge"><b>${fmt(realtime.spx_last)}</b>S&P 500 最新（${realtime.spx_last_date}）</div>`;
    }
    html += `<div class="badge"><b>${cape.last}</b>席勒市盈率 CAPE（${capeDate}）</div>`;
    if (realtime.vix_last) {
      html += `<div class="badge"><b>${fmt(realtime.vix_last)}</b>VIX 恐慌指数（${realtime.vix_last_date || ""}）<span class="info-icon">i<span class="info-tooltip"><span class="tt-title">VIX 恐慌指数</span>衡量市场对未来 30 天 S&P 500 波动率的预期，反映恐慌情绪。<br><br><b>判断高低的标准：</b><br>• &lt; 15：极平静，市场自满<br>• 15–20：正常区间<br>• 20–30：情绪紧张，需警惕<br>• 30–40：恐慌，常伴随急跌<br>• &gt; 40：极端恐慌，往往接近底部</span></span></div>`;
    }
    el.innerHTML = html;
  }

  // ---------- 启动 ----------
  getData().then((D) => {
    const gen = D.meta && D.meta.generated_at ? new Date(D.meta.generated_at) : null;
    const f = document.querySelector("#headerFreshness .hf-text");
    if (gen) f.textContent = "数据更新于 " + gen.toLocaleString("zh-CN");

    renderPrice(D.price);
    renderValuation(D.spy_pe, D.spy_pb);
    renderVix(D.vix, D.price);
    renderAnnual(D.annual_returns, D.total_return);
    renderAnnualDist(D.annual_distribution);
    renderMatrix(D.annualized_matrix);
    renderDrawdown(D.drawdown);
    renderVolatility(D.volatility);
    renderCape(D.cape, D.price);
    renderEps(D.eps, D.price);
    renderBullBear(D.bull_bear_phases, D.analysis_price);
    renderRolling(D.rolling_returns);
    renderIntrayearDrawdown(D.intrayear_drawdown);
    renderTreasury(D.treasury_yield);
    renderYieldSpread(D.yield_spread);
    renderBadges(D.cape, D.realtime);
  }).catch((err) => {
    console.error("加载数据失败", err);
    document.querySelector("#headerFreshness .hf-text").textContent = "数据加载失败，请先运行 fetch_data.py";
  });

  const navItems = document.querySelectorAll(".nav-item");
  const panels = document.querySelectorAll(".panel");
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        navItems.forEach((n) => n.classList.toggle("active", n.dataset.panel === entry.target.id));
      }
    });
  }, { rootMargin: "-40% 0px -55% 0px" });
  panels.forEach((p) => observer.observe(p));

  window.addEventListener("resize", () => {
    Object.values(charts).forEach((c) => c.resize());
  });
})();
