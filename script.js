
/* KreTeX AI — Delta Exchange India Live Dashboard
   Public market data only. No API key or secret in frontend.
   Existing HTML structure and element IDs are preserved.
*/

"use strict";

const REST = "https://api.india.delta.exchange";
const WS_URL = "wss://public-socket.india.delta.exchange";

const SYMBOLS = ["BTCUSD", "ETHUSD", "SOLUSD", "XAUTUSD"];

const DECIMALS = {
  BTCUSD: 1,
  ETHUSD: 2,
  SOLUSD: 3,
  XAUTUSD: 2
};

const TF_SECONDS = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400
};

const state = {
  symbol: "BTCUSD",
  tf: "15m",
  tickers: {},
  closes: [],
  loadToken: 0,
  restOk: false,
  wsOk: false,
  available: new Set(),
  wsRetry: 0
};

const $ = id => document.getElementById(id);

const num = value =>
  value === null || value === undefined || value === ""
    ? NaN
    : Number(value);

const dec = symbol => DECIMALS[symbol] ?? 2;

const fmt = (value, digits = 2) =>
  Number.isFinite(value)
    ? value.toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
      })
    : "—";

const fmtBig = value => {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1e9) return (value / 1e9).toFixed(2) + "B";
  if (value >= 1e6) return (value / 1e6).toFixed(2) + "M";
  if (value >= 1e3) return (value / 1e3).toFixed(2) + "K";
  return value.toFixed(2);
};

async function getJSON(path) {
  const response = await fetch(REST + path);

  if (!response.ok) {
    throw new Error("HTTP " + response.status + ": " + path);
  }

  const json = await response.json();

  if (json.success === false) {
    throw new Error("Delta API error: " + path);
  }

  return json.result;
}

function setStatus() {
  const status = $("status");
  const text = $("status-text");

  if (!status || !text) return;

  status.classList.remove("live", "error");

  if (state.wsOk) {
    status.classList.add("live");
    text.textContent = "Live (WebSocket)";
  } else if (state.restOk) {
    status.classList.add("live");
    text.textContent = "Live (REST polling)";
  } else {
    status.classList.add("error");
    text.textContent = "Disconnected — retrying";
  }
}

/* ---------------- Product discovery ---------------- */

async function discoverProducts() {
  try {
    const products = await getJSON(
      "/v2/products?states=live&page_size=100"
    );

    state.available = new Set(
      (products || []).map(product => product.symbol)
    );

    // Display unavailable symbols clearly rather than inventing prices.
    renderMarkets();
  } catch (error) {
    console.warn("Product discovery:", error);
  }
}

/* ---------------- Chart ---------------- */

let chart = null;
let candles = null;
let volume = null;

function initChart() {
  const chartEl = $("chart");

  if (!chartEl || !window.LightweightCharts) {
    console.error("Chart element or Lightweight Charts library missing.");
    return;
  }

  chart = LightweightCharts.createChart(chartEl, {
    width: chartEl.clientWidth,
    height: chartEl.clientHeight || 460,

    layout: {
      background: { color: "#13161b" },
      textColor: "#8a92a0"
    },

    grid: {
      vertLines: { color: "#1b1f26" },
      horzLines: { color: "#1b1f26" }
    },

    rightPriceScale: {
      borderColor: "#232830"
    },

    timeScale: {
      borderColor: "#232830",
      timeVisible: true,
      secondsVisible: false
    },

    localization: {
      timeFormatter: time =>
        new Date(time * 1000).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
          hour12: false
        })
    }
  });

  candles = chart.addCandlestickSeries({
    upColor: "#2cb72c",
    downColor: "#e5484d",
    borderUpColor: "#2cb72c",
    borderDownColor: "#e5484d",
    wickUpColor: "#2cb72c",
    wickDownColor: "#e5484d"
  });

  volume = chart.addHistogramSeries({
    priceFormat: { type: "volume" },
    priceScaleId: "vol"
  });

  chart.priceScale("vol").applyOptions({
    scaleMargins: { top: 0.82, bottom: 0 }
  });

  if ("ResizeObserver" in window) {
    new ResizeObserver(() => {
      chart.applyOptions({
        width: chartEl.clientWidth,
        height: chartEl.clientHeight || 460
      });
    }).observe(chartEl);
  }
}

async function fetchCandles(symbol, timeframe, count) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - TF_SECONDS[timeframe] * count;

  const rows = await getJSON(
    `/v2/history/candles?resolution=${timeframe}` +
    `&symbol=${encodeURIComponent(symbol)}` +
    `&start=${start}&end=${end}`
  );

  const byTime = new Map();

  (rows || []).forEach(candle => {
    const item = {
      time: Number(candle.time),
      open: num(candle.open),
      high: num(candle.high),
      low: num(candle.low),
      close: num(candle.close),
      volume: num(candle.volume)
    };

    if (item.time && Number.isFinite(item.close)) {
      byTime.set(item.time, item);
    }
  });

  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

async function loadChart() {
  if (!chart || !candles || !volume) return;

  const token = ++state.loadToken;
  const symbol = state.symbol;
  const timeframe = state.tf;

  try {
    const data = await fetchCandles(symbol, timeframe, 300);

    if (token !== state.loadToken) return;

    candles.setData(
      data.map(({ volume: ignored, ...candle }) => candle)
    );

    volume.setData(
      data.map(candle => ({
        time: candle.time,
        value: Number.isFinite(candle.volume) ? candle.volume : 0,
        color: candle.close >= candle.open
          ? "rgba(44,183,44,0.35)"
          : "rgba(229,72,77,0.35)"
      }))
    );

    chart.timeScale().fitContent();
    state.closes = data.map(candle => candle.close);
    state.restOk = true;
    updateSignal();
  } catch (error) {
    console.error("Chart loading:", error);
    state.restOk = false;
  }

  setStatus();
}

async function refreshLastCandles() {
  if (!chart || !candles || !volume) return;

  const symbol = state.symbol;
  const timeframe = state.tf;

  try {
    const data = await fetchCandles(symbol, timeframe, 3);

    if (symbol !== state.symbol || timeframe !== state.tf) return;

    data.forEach(candle => {
      const candleData = {
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close
      };

      try {
        candles.update(candleData);

        volume.update({
          time: candle.time,
          value: Number.isFinite(candle.volume) ? candle.volume : 0,
          color: candle.close >= candle.open
            ? "rgba(44,183,44,0.35)"
            : "rgba(229,72,77,0.35)"
        });
      } catch (error) {
        // An older candle may not be updateable.
        console.debug("Candle update skipped:", error.message);
      }
    });

    if (data.length) {
      state.closes = state.closes.slice(-300);
      updateSignal();
    }

    state.restOk = true;
  } catch (error) {
    console.error("Candle refresh:", error);
    state.restOk = false;
  }

  setStatus();
}

/* ---------------- Tickers and top cards ---------------- */

function applyTicker(symbol, ticker) {
  if (!SYMBOLS.includes(symbol) || !ticker) return;

  const previous = state.tickers[symbol]?.price;

  const price = num(
    ticker.close ??
    ticker.last_price ??
    ticker.price ??
    ticker.mark_price
  );

  if (!Number.isFinite(price)) return;

  state.tickers[symbol] = {
    price,
    mark: num(ticker.mark_price),
    high: num(ticker.high),
    low: num(ticker.low),
    open: num(ticker.open),
    turnover: num(ticker.turnover_usd ?? ticker.turnover),
    prev: previous
  };

  renderMarkets();
  renderTopCards();

  if (symbol === state.symbol) renderStats();
}

function renderTopCards() {
  const topCards = {
    BTCUSD: "btcPrice",
    ETHUSD: "ethPrice",
    SOLUSD: "solPrice",
    XAUTUSD: "goldPrice"
  };

  Object.entries(topCards).forEach(([symbol, id]) => {
    const element = $(id);
    if (!element) return;

    const ticker = state.tickers[symbol];

    element.textContent = ticker
      ? fmt(ticker.price, dec(symbol))
      : "—";
  });
}

async function pollTickers() {
  const results = await Promise.allSettled(
    SYMBOLS.map(async symbol => {
      const ticker = await getJSON(
        `/v2/tickers/${encodeURIComponent(symbol)}`
      );

      applyTicker(symbol, ticker);
      return symbol;
    })
  );

  state.restOk = results.some(
    result => result.status === "fulfilled"
  );

  setStatus();
}

function changePct(ticker) {
  if (!ticker || !Number.isFinite(ticker.open) || ticker.open === 0) {
    return NaN;
  }

  return ((ticker.price - ticker.open) / ticker.open) * 100;
}

function renderMarkets() {
  const list = $("market-list");
  if (!list) return;

  if (!list.children.length) {
    SYMBOLS.forEach(symbol => {
      const item = document.createElement("li");

      item.dataset.sym = symbol;
      item.tabIndex = 0;
      item.innerHTML =
        `<span class="m-sym">${symbol}</span>` +
        `<span class="m-price" data-p>—</span>` +
        `<span class="m-sub">Delta market</span>` +
        `<span class="m-chg" data-c>—</span>`;

      item.addEventListener("click", () => selectSymbol(symbol));

      item.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectSymbol(symbol);
        }
      });

      list.appendChild(item);
    });
  }

  SYMBOLS.forEach(symbol => {
    const item = list.querySelector(`[data-sym="${symbol}"]`);
    if (!item) return;

    item.classList.toggle("active", symbol === state.symbol);

    const ticker = state.tickers[symbol];
    const priceElement = item.querySelector("[data-p]");
    const changeElement = item.querySelector("[data-c]");

    if (!ticker) {
      priceElement.textContent = "—";
      changeElement.textContent = state.available.size &&
        !state.available.has(symbol)
          ? "Unavailable"
          : "Waiting";
      return;
    }

    priceElement.textContent = fmt(ticker.price, dec(symbol));

    const change = changePct(ticker);

    changeElement.textContent = Number.isFinite(change)
      ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`
      : "—";

    changeElement.className =
      "m-chg " +
      (change >= 0 ? "up" : "down");
  });
}

function renderStats() {
  const ticker = state.tickers[state.symbol];

  const symbolName = $("symbol-name");
  if (symbolName) symbolName.textContent = state.symbol;

  if (!ticker) return;

  const digits = dec(state.symbol);
  const lastPrice = $("last-price");

  if (lastPrice) {
    lastPrice.textContent = fmt(ticker.price, digits);
    lastPrice.className = "val " +
      (ticker.price >= (ticker.prev ?? ticker.price) ? "up" : "down");
  }

  const change = changePct(ticker);
  const changeElement = $("chg");

  if (changeElement) {
    changeElement.textContent = Number.isFinite(change)
      ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`
      : "—";

    changeElement.className =
      "val " + (change >= 0 ? "up" : "down");
  }

  if ($("mark")) $("mark").textContent = fmt(ticker.mark, digits);
  if ($("high")) $("high").textContent = fmt(ticker.high, digits);
  if ($("low")) $("low").textContent = fmt(ticker.low, digits);

  if ($("vol")) {
    $("vol").textContent = Number.isFinite(ticker.turnover)
      ? "$" + fmtBig(ticker.turnover)
      : "—";
  }

  document.title = `${fmt(ticker.price, digits)} ${state.symbol} — KreTeX AI`;
}

function flash(element, current, previous) {
  if (!element || previous === undefined || current === previous) return;

  element.classList.remove("flash-up", "flash-down");
  void element.offsetWidth;

  element.classList.add(
    current > previous ? "flash-up" : "flash-down"
  );
}

/* ---------------- Order book ---------------- */

async function refreshBook() {
  const symbol = state.symbol;

  try {
    const book = await getJSON(
      `/v2/l2orderbook/${encodeURIComponent(symbol)}?depth=12`
    );

    if (symbol !== state.symbol) return;

    const asks = (book.sell || [])
      .slice(0, 10)
      .map(row => ({ price: num(row.price), size: num(row.size) }));

    const bids = (book.buy || [])
      .slice(0, 10)
      .map(row => ({ price: num(row.price), size: num(row.size) }));

    const sizes = [...asks, ...bids].map(row => row.size);
    const maxSize = Math.max(...sizes, 1);
    const digits = dec(symbol);

    const makeRow = (row, className) =>
      `<div class="row ${className}">` +
      `<div class="bar" style="width:${Math.max(0, row.size / maxSize * 100)}%"></div>` +
      `<span class="p">${fmt(row.price, digits)}</span>` +
      `<span>${fmt(row.size, 0)}</span>` +
      `</div>`;

    if ($("asks")) {
      $("asks").innerHTML = asks
        .sort((a, b) => b.price - a.price)
        .map(row => makeRow(row, "ask"))
        .join("");
    }

    if ($("bids")) {
      $("bids").innerHTML = bids
        .sort((a, b) => b.price - a.price)
        .map(row => makeRow(row, "bid"))
        .join("");
    }

    if ($("spread") && asks.length && bids.length) {
      const bestAsk = Math.min(...asks.map(row => row.price));
      const bestBid = Math.max(...bids.map(row => row.price));

      $("spread").textContent =
        "Spread " + fmt(bestAsk - bestBid, digits);
    }
  } catch (error) {
    console.error("Order book:", error);
  }
}

/* ---------------- EMA / RSI signal ---------------- */

function ema(values, period) {
  if (!values.length) return NaN;

  const multiplier = 2 / (period + 1);
  let result = values[0];

  for (let index = 1; index < values.length; index++) {
    result = values[index] * multiplier +
      result * (1 - multiplier);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return NaN;

  let gain = 0;
  let loss = 0;

  for (let index = 1; index <= period; index++) {
    const difference = values[index] - values[index - 1];

    if (difference >= 0) gain += difference;
    else loss -= difference;
  }

  gain /= period;
  loss /= period;

  for (let index = period + 1; index < values.length; index++) {
    const difference = values[index] - values[index - 1];

    gain = (gain * (period - 1) + Math.max(difference, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-difference, 0)) / period;
  }

  if (loss === 0) return gain === 0 ? 50 : 100;

  return 100 - 100 / (1 + gain / loss);
}

function updateSignal() {
  const values = state.closes;

  if (values.length < 30) return;

  const fast = ema(values.slice(-Math.min(values.length, 60)), 9);
  const slow = ema(values.slice(-Math.min(values.length, 60)), 21);
  const relativeStrength = rsi(values);

  let label = "Neutral";
  let className = "";

  if (fast > slow && relativeStrength < 70) {
    label = "Bullish";
    className = "up";
  } else if (fast < slow && relativeStrength > 30) {
    label = "Bearish";
    className = "down";
  } else if (relativeStrength >= 70) {
    label = "Overbought";
    className = "down";
  } else if (relativeStrength <= 30) {
    label = "Oversold";
    className = "up";
  }

  if ($("signal-main")) {
    $("signal-main").textContent = label;
    $("signal-main").className = "signal-main " + className;
  }

  if ($("signal-meta")) {
    $("signal-meta").textContent =
      `${state.symbol} · ${state.tf} · ` +
      `EMA9 ${fmt(fast, dec(state.symbol))} · ` +
      `EMA21 ${fmt(slow, dec(state.symbol))} · ` +
      `RSI ${fmt(relativeStrength, 1)}`;
  }
}

/* ---------------- WebSocket ---------------- */

let ws = null;

function connectWS() {
  try {
    ws = new WebSocket(WS_URL);
  } catch (error) {
    console.error("WebSocket creation:", error);
    scheduleWS();
    return;
  }

  ws.onopen = () => {
    state.wsRetry = 0;

    ws.send(JSON.stringify({
      type: "subscribe",
      payload: {
        channels: [{
          name: "ticker",
          symbols: SYMBOLS
        }]
      }
    }));
  };

  ws.onmessage = event => {
    let message;

    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === "ticker") {
      const symbol = message.symbol ?? message.sy;

      if (symbol && SYMBOLS.includes(symbol)) {
        state.wsOk = true;
        applyTicker(symbol, message);
        setStatus();
      }
    }
  };

  ws.onclose = () => {
    state.wsOk = false;
    setStatus();
    scheduleWS();
  };

  ws.onerror = error => {
    console.warn("WebSocket error:", error);
    state.wsOk = false;
    setStatus();
  };
}

function scheduleWS() {
  clearTimeout(scheduleWS.timer);

  const delay = Math.min(
    1000 * (2 ** state.wsRetry),
    15000
  );

  state.wsRetry++;

  scheduleWS.timer = setTimeout(connectWS, delay);
}

/* ---------------- Controls ---------------- */

function selectSymbol(symbol) {
  if (!SYMBOLS.includes(symbol)) return;

  state.symbol = symbol;
  renderMarkets();
  renderStats();

  if ($("asks")) $("asks").innerHTML = "";
  if ($("bids")) $("bids").innerHTML = "";

  loadChart();
  refreshBook();
}

const timeframeButtons = $("tf-buttons");

if (timeframeButtons) {
  timeframeButtons.addEventListener("click", event => {
    const button = event.target.closest("button[data-tf]");
    if (!button) return;

    if (!TF_SECONDS[button.dataset.tf]) return;

    state.tf = button.dataset.tf;

    document.querySelectorAll("#tf-buttons button").forEach(item => {
      item.classList.toggle("active", item === button);
    });

    loadChart();
  });
}

/* ---------------- Start dashboard ---------------- */

async function startDashboard() {
  initChart();
  renderMarkets();
  renderTopCards();
  setStatus();

  await discoverProducts();
  await pollTickers();

  renderStats();

  await Promise.allSettled([
    loadChart(),
    refreshBook()
  ]);

  connectWS();

  setInterval(pollTickers, 5000);
  setInterval(refreshLastCandles, 5000);
  setInterval(refreshBook, 3000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startDashboard, { once: true });
} else {
  startDashboard();
}
