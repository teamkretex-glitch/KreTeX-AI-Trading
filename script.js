/* KreTeX AI — public market data + demo trading
   Real exchange orders are intentionally disabled.
*/

(() => {
  "use strict";

  const API = "https://api.india.delta.exchange";
  const $ = (id) => document.getElementById(id);

  const state = {
    symbol: "BTCUSD",
    timeframe: "15m",
    candles: [],
    chart: null,
    candleSeries: null,
    volumeSeries: null,
    extraSeries: {},
    demoOrders: [],
    demoPositions: [],
    side: "Long",
    balance: 1000,
    loading: false
  };

  const intervals = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "4h": 14400,
    "1d": 86400
  };

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  function show(el) {
    if (el) el.classList.remove("hidden");
  }

  function hide(el) {
    if (el) el.classList.add("hidden");
  }

  async function getJSON(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Market data request failed (${response.status})`);
    }

    const data = await response.json();

    if (data.success === false) {
      throw new Error(data.error || "Market data unavailable");
    }

    return data;
  }

  function formatPrice(value) {
    if (!Number.isFinite(value)) return "—";

    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4
    }).format(value);
  }

  function resolutionFor(timeframe) {
    return timeframe;
  }

  function renderChartPlaceholder(message) {
    const el = $("tradingChart");
    if (!el) return;

    el.innerHTML = "";
    const p = document.createElement("p");
    p.className = "chart-placeholder";
    p.textContent = message;
    el.appendChild(p);
  }

  function initChart() {
    const el = $("tradingChart");

    if (!el || !window.LightweightCharts) {
      renderChartPlaceholder("Chart library could not load.");
      return;
    }

    el.innerHTML = "";

    state.chart = LightweightCharts.createChart(el, {
      width: el.clientWidth,
      height: el.clientHeight,
      layout: {
        background: { color: "#0c1016" },
        textColor: "#a6adbd"
      },
      grid: {
        vertLines: { color: "#222b36" },
        horzLines: { color: "#222b36" }
      },
      rightPriceScale: {
        borderColor: "#343a45"
      },
      timeScale: {
        borderColor: "#343a45",
        timeVisible: true,
        secondsVisible: false
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal
      }
    });

    state.candleSeries = state.chart.addCandlestickSeries({
      upColor: "#43d9a3",
      downColor: "#ff7185",
      borderUpColor: "#43d9a3",
      borderDownColor: "#ff7185",
      wickUpColor: "#43d9a3",
      wickDownColor: "#ff7185"
    });

    state.volumeSeries = state.chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: ""
    });

    state.volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 }
    });

    if (window.ResizeObserver) {
      const observer = new ResizeObserver(() => {
        if (state.chart && el.clientWidth) {
          state.chart.applyOptions({
            width: el.clientWidth,
            height: el.clientHeight
          });
        }
      });
      observer.observe(el);
    }
  }

  async function loadCandles() {
    if (state.loading) return;
    state.loading = true;

    try {
      renderChartPlaceholder("Loading market candles...");

      const now = Math.floor(Date.now() / 1000);
      const seconds = intervals[state.timeframe] || 900;
      const start = now - seconds * 200;

      const url =
        `${API}/v2/history/candles` +
        `?resolution=${encodeURIComponent(resolutionFor(state.timeframe))}` +
        `&symbol=${encodeURIComponent(state.symbol)}` +
        `&start=${start}&end=${now}`;

      const response = await getJSON(url);
      const rows = response.result;

      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error("No candle data returned for this market.");
      }

      const candles = rows.map((c) => ({
        time: Number(c.time),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume || 0)
      })).filter((c) =>
        Number.isFinite(c.time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
      ).sort((a, b) => a.time - b.time);

      const unique = [];
      const seen = new Set();

      for (const candle of candles) {
        if (!seen.has(candle.time)) {
          seen.add(candle.time);
          unique.push(candle);
        }
      }

      state.candles = unique;

      if (!state.chart) initChart();

      if (!state.candleSeries) {
        throw new Error("Chart could not initialize.");
      }

      state.candleSeries.setData(
        unique.map(({ time, open, high, low, close }) => ({
          time, open, high, low, close
        }))
      );

      state.volumeSeries.setData(
        unique.map((c) => ({
          time: c.time,
          value: c.volume,
          color: c.close >= c.open
            ? "rgba(67,217,163,0.45)"
            : "rgba(255,113,133,0.45)"
        }))
      );

      state.chart.timeScale().fitContent();

      const last = unique[unique.length - 1];
      setText("currentPrice", `$${formatPrice(last.close)}`);
      setText("marketStatus", "Public data");
      calculateIndicators();
      renderAnalysis();

    } catch (error) {
      console.error(error);
      renderChartPlaceholder(error.message);
      setText("currentPrice", "—");
      setText("marketStatus", "Data unavailable");
      setText("analysisSignal", "Waiting for market data");
      setText("analysisText", error.message);
    } finally {
      state.loading = false;
    }
  }

  async function loadTicker() {
    try {
      const response = await getJSON(
        `${API}/v2/tickers/${encodeURIComponent(state.symbol)}`
      );

      const ticker = response.result;
      if (!ticker) throw new Error("Ticker not found.");

      const price = Number(
        ticker.close ?? ticker.mark_price ?? ticker.last_price
      );

      if (Number.isFinite(price)) {
        setText("currentPrice", `$${formatPrice(price)}`);
      }

      const change = Number(ticker.change_percentage);
      setText(
        "priceChange",
        Number.isFinite(change)
          ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`
          : "Market price"
      );

    } catch (error) {
      console.warn("Ticker unavailable:", error.message);
    }
  }

  function ema(values, period) {
    const result = [];
    const multiplier = 2 / (period + 1);
    let previous = null;

    values.forEach((value, index) => {
      previous = previous === null
        ? value
        : value * multiplier + previous * (1 - multiplier);

      result.push({
        time: state.candles[index].time,
        value: previous
      });
    });

    return result;
  }

  function rsi(values, period = 14) {
    if (values.length <= period) return null;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
      const difference = values[i] - values[i - 1];
      gains += Math.max(0, difference);
      losses += Math.max(0, -difference);
    }

    let averageGain = gains / period;
    let averageLoss = losses / period;
    let latest = null;

    for (let i = period + 1; i < values.length; i++) {
      const difference = values[i] - values[i - 1];

      averageGain =
        (averageGain * (period - 1) + Math.max(0, difference)) / period;

      averageLoss =
        (averageLoss * (period - 1) + Math.max(0, -difference)) / period;

      latest = averageLoss === 0
        ? 100
        : 100 - 100 / (1 + averageGain / averageLoss);
    }

    return latest;
  }

  function calculateIndicators() {
    if (!state.chart || !state.candleSeries) return;

    const closes = state.candles.map((c) => c.close);
    const selected = Array.from(
      document.querySelectorAll("#indicatorsMenu input:checked")
    ).map((input) => input.value);

    Object.values(state.extraSeries).forEach((series) => {
      try {
        state.chart.removeSeries(series);
      } catch (_) {}
    });

    state.extraSeries = {};

    function addLine(key, values, color) {
      const line = state.chart.addLineSeries({
        color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true
      });

      line.setData(values.filter((v) =>
        Number.isFinite(v.value) && Number.isFinite(v.time)
      ));

      state.extraSeries[key] = line;
    }

    if (selected.includes("ema9")) {
      addLine("ema9", ema(closes, 9), "#43d9a3");
    }

    if (selected.includes("ema21")) {
      addLine("ema21", ema(closes, 21), "#f3c65d");
    }

    if (selected.includes("vwap")) {
      let totalPV = 0;
      let totalVolume = 0;

      const values = state.candles.map((c) => {
        const typical = (c.high + c.low + c.close) / 3;
        const volume = c.volume || 0;
        totalPV += typical * volume;
        totalVolume += volume;

        return {
          time: c.time,
          value: totalVolume > 0 ? totalPV / totalVolume : c.close
        };
      });

      addLine("vwap", values, "#7ca8ff");
    }

    if (selected.includes("bb") && closes.length >= 20) {
      const upper = [];
      const lower = [];

      for (let i = 19; i < closes.length; i++) {
        const slice = closes.slice(i - 19, i + 1);
        const mean = slice.reduce((a, b) => a + b, 0) / 20;
        const variance = slice.reduce(
          (sum, value) => sum + Math.pow(value - mean, 2), 0
        ) / 20;

        const deviation = Math.sqrt(variance);

        upper.push({
          time: state.candles[i].time,
          value: mean + 2 * deviation
        });

        lower.push({
          time: state.candles[i].time,
          value: mean - 2 * deviation
        });
      }

      addLine("bbUpper", upper, "#ba8cff");
      addLine("bbLower", lower, "#ba8cff");
    }

    const panel = $("indicatorPanels");
    if (!panel) return;

    panel.innerHTML = "";

    if (selected.includes("rsi")) {
      const rsiPanel = document.createElement("div");
      rsiPanel.className = "indicator-panel";
      rsiPanel.textContent = "RSI 14: " +
        (rsi(closes) === null ? "Need more candles" : rsi(closes).toFixed(2));
      panel.appendChild(rsiPanel);
    }

    if (selected.includes("macd")) {
      const macdPanel = document.createElement("div");
      macdPanel.className = "indicator-panel";

      const fast = ema(closes, 12);
      const slow = ema(closes, 26);
      const difference = fast.length - slow.length;
      const macdValue = difference >= 0
        ? fast[fast.length - 1].value - slow[slow.length - 1].value
        : null;

      macdPanel.textContent = "MACD: " +
        (Number.isFinite(macdValue) ? macdValue.toFixed(4) : "Need more candles");

      panel.appendChild(macdPanel);
    }
  }

  function renderAnalysis() {
    const closes = state.candles.map((c) => c.close);

    if (closes.length < 30) {
      setText("analysisSignal", "Not enough data");
      setText("analysisText", "More candles are needed for EMA analysis.");
      return;
    }

    const fast = ema(closes, 9).at(-1).value;
    const slow = ema(closes, 21).at(-1).value;
    const momentum = rsi(closes);

    let signal = "Neutral";
    let explanation = "Indicators are mixed. Wait for confirmation.";

    if (fast > slow && momentum !== null && momentum >= 50 && momentum < 70) {
      signal = "Bullish";
      explanation = "EMA 9 is above EMA 21 and RSI supports upward momentum.";
    } else if (
      fast < slow &&
      momentum !== null &&
      momentum <= 50 &&
      momentum > 30
    ) {
      signal = "Bearish";
      explanation = "EMA 9 is below EMA 21 and RSI supports downward momentum.";
    }

    setText("analysisSignal", signal);
    setText("analysisText", explanation);
  }

  function setSide(side) {
    state.side = side;
    setText("selectedSide", side);

    const longButton = $("longButton");
    const shortButton = $("shortButton");

    if (longButton) longButton.setAttribute("aria-pressed", String(side === "Long"));
    if (shortButton) shortButton.setAttribute("aria-pressed", String(side === "Short"));

    const panel = $("orderPanel");
    if (panel) {
      panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function renderDemoOrders() {
    const count = $("orderCount");
    if (count) count.textContent = String(state.demoOrders.length);

    const positions = $("positionsContent");
    if (!positions) return;

    positions.innerHTML = "";

    if (state.demoPositions.length === 0) {
      const p = document.createElement("p");
      p.className = "empty-state";
      p.textContent = "No open demo position";
      positions.appendChild(p);
      return;
    }

    state.demoPositions.forEach((position) => {
      const row = document.createElement("div");
      row.className = "analysis-card";

      const title = document.createElement("strong");
      title.textContent = `${position.side} ${position.symbol}`;

      const detail = document.createElement("p");
      detail.textContent =
        `Amount: ${position.amount} · Entry: ${position.price}`;

      row.append(title, detail);
      positions.appendChild(row);
    });
  }

  function placeDemoOrder() {
    const amount = Number($("orderAmount")?.value);
    const priceText = $("currentPrice")?.textContent || "";
    const price = Number(priceText.replace(/[$,]/g, ""));

    if (!Number.isFinite(amount) || amount <= 0) {
      alert("Please enter a valid demo amount.");
      return;
    }

    if (!Number.isFinite(price) || price <= 0) {
      alert("Market price is unavailable. Please wait for data.");
      return;
    }

    const order = {
      id: Date.now(),
      symbol: state.symbol,
      side: state.side,
      amount,
      price,
      leverage: Number($("leverage")?.value || 1),
      type: $("orderType")?.value || "market",
      createdAt: new Date().toISOString()
    };

    state.demoOrders.push(order);
    state.demoPositions.push(order);

    renderDemoOrders();

    alert(
      `DEMO ORDER CREATED\n${order.side} ${order.symbol}\n` +
      `Amount: ${order.amount}\nPrice: ${order.price}\n\n` +
      "No real order was sent to the exchange."
    );
  }

  function closeMenus(except) {
    [
      $("marketPicker"),
      $("timeframeMenu"),
      $("indicatorsMenu")
    ].forEach((menu) => {
      if (menu && menu !== except) hide(menu);
    });
  }

  function setupControls() {
    $("symbolButton")?.addEventListener("click", () => {
      const menu = $("marketPicker");
      if (!menu) return;

      closeMenus(menu);
      menu.classList.toggle("hidden");
    });

    $("marketPicker")?.querySelectorAll("[data-symbol]").forEach((button) => {
      button.addEventListener("click", async () => {
        state.symbol = button.dataset.symbol;
        setText("symbolButton", `★ ${state.symbol} ▾`);
        hide($("marketPicker"));
        await loadCandles();
        await loadTicker();
      });
    });

    $("timeframeButton")?.addEventListener("click", () => {
      const menu = $("timeframeMenu");
      if (!menu) return;

      closeMenus(menu);
      menu.classList.toggle("hidden");
    });

    $("timeframeMenu")?.querySelectorAll("[data-timeframe]").forEach((button) => {
      button.addEventListener("click", async () => {
        state.timeframe = button.dataset.timeframe;
        setText("timeframeButton", `${state.timeframe} ›`);
        hide($("timeframeMenu"));
        await loadCandles();
      });
    });

    $("indicatorsButton")?.addEventListener("click", () => {
      const menu = $("indicatorsMenu");
      if (!menu) return;

      closeMenus(menu);
      menu.classList.toggle("hidden");
    });

    $("indicatorsMenu")?.querySelectorAll("input[type=checkbox]").forEach((input) => {
      input.addEventListener("change", calculateIndicators);
    });

    $("longButton")?.addEventListener("click", () => setSide("Long"));
    $("shortButton")?.addEventListener("click", () => setSide("Short"));

    $("placeDemoOrder")?.addEventListener("click", placeDemoOrder);

    $("orderType")?.addEventListener("change", () => {
      const limit = $("orderType").value === "limit";
      if (limit) {
        alert("Limit price entry will be added in a later step. Demo only.");
      }
    });

    document.querySelectorAll(".position-tab").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll(".position-tab").forEach((tab) => {
          tab.classList.remove("active");
        });

        button.classList.add("active");

        if (button.dataset.tab === "orders") {
          const content = $("positionsContent");
          if (!content) return;

          content.innerHTML = "";

          if (state.demoOrders.length === 0) {
            const p = document.createElement("p");
            p.className = "empty-state";
            p.textContent = "No open demo orders";
            content.appendChild(p);
          } else {
            state.demoOrders.forEach((order) => {
              const row = document.createElement("p");
              row.className = "empty-state";
              row.textContent =
                `${order.side} ${order.symbol} · ${order.amount} · ${order.price}`;
              content.appendChild(row);
            });
          }
        } else {
          renderDemoOrders();
        }
      });
    });

    document.querySelectorAll(".bottom-nav [data-page]").forEach((button) => {
      button.addEventListener("click", () => {
        const page = button.dataset.page;

        document.querySelectorAll(".bottom-nav button").forEach((item) => {
          item.classList.remove("nav-active");
        });
        button.classList.add("nav-active");

        const targets = {
          home: ".topbar",
          markets: ".market-header",
          trade: "#orderPanel",
          charts: ".chart-section",
          portfolio: ".positions-section"
        };

        const target = document.querySelector(targets[page]);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    });

    document.addEventListener("click", (event) => {
      const inside = event.target.closest(
        "#symbolButton, #marketPicker, #timeframeButton, " +
        "#timeframeMenu, #indicatorsButton, #indicatorsMenu"
      );

      if (!inside) closeMenus(null);
    });
  }

  async function start() {
    setupControls();
    initChart();
    setSide("Long");
    renderDemoOrders();

    await loadCandles();
    await loadTicker();

    setInterval(loadTicker, 15000);
  }

  document.addEventListener("DOMContentLoaded", start);
})();
