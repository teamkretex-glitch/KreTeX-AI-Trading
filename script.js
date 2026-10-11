// KreTeX AI — Market Dashboard
// Public market data only. Buy/Sell buttons are demo-only.
// Never put API secrets in frontend JavaScript.

(() => {
  "use strict";

  const REST = "https://api.india.delta.exchange";
  const WS_URL = "wss://public-socket.india.delta.exchange";

  const MARKETS = {
    BTCUSD: { name: "Bitcoin", decimals: 1 },
    ETHUSD: { name: "Ethereum", decimals: 2 },
    SOLUSD: { name: "Solana", decimals: 3 },
    XAUTUSD: { name: "Gold", decimals: 2 }
  };

  const TIMEFRAMES = {
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
    timeframe: "15m",
    tickers: {},
    candles: [],
    products: new Set(),
    chart: null,
    candleSeries: null,
    volumeSeries: null,
    socket: null,
    reconnectTimer: null,
    tickerTimer: null,
    candleTimer: null,
    bookTimer: null,
    requestId: 0,
    busy: false
  };

  const $ = (id) => document.getElementById(id);

  function number(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function fmt(value, decimals = 2) {
    const n = number(value);
    if (n === null) return "—";
    return n.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  function price(value, symbol = state.symbol) {
    const n = number(value);
    if (n === null) return "—";

    const decimals = MARKETS[symbol]?.decimals ?? 2;
    return "$" + fmt(n, decimals);
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  function setStatus(message, connected = false) {
    setText("status-text", message);

    const dot = document.querySelector(".status-dot");
    if (dot) {
      dot.style.background = connected ? "#2CB72C" : "#e5a23b";
    }
  }

  async function getJSON(path) {
    const response = await fetch(REST + path, {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error("API HTTP " + response.status);
    }

    const result = await response.json();

    if (result.success === false) {
      throw new Error(result.error || "Market API error");
    }

    return result;
  }

  function tickerPrice(ticker) {
    if (!ticker) return null;

    return number(
      ticker.close ??
      ticker.last_price ??
      ticker.mark_price ??
      ticker.price
    );
  }

  function tickerChange(ticker) {
    if (!ticker) return null;

    const direct = number(ticker.change_percentage);
    if (direct !== null) return direct;

    const close = number(ticker.close);
    const open = number(ticker.open);

    if (close !== null && open !== null && open !== 0) {
      return ((close - open) / open) * 100;
    }

    return null;
  }

  // ---------- Chart ----------

  function initChart() {
    const container = $("chart");

    if (!container || !window.LightweightCharts) {
      setStatus("Chart library unavailable");
      return;
    }

    state.chart = LightweightCharts.createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { color: "#12151b" },
        textColor: "#a8b0bf"
      },
      grid: {
        vertLines: { color: "#222731" },
        horzLines: { color: "#222731" }
      },
      rightPriceScale: {
        borderColor: "#343a46"
      },
      timeScale: {
        borderColor: "#343a46",
        timeVisible: true,
        secondsVisible: false
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal
      },
      localization: {
        priceFormatter: (value) => price(value)
      }
    });

    state.candleSeries = state.chart.addCandlestickSeries({
      upColor: "#2CB72C",
      downColor: "#e5484d",
      borderUpColor: "#2CB72C",
      borderDownColor: "#e5484d",
      wickUpColor: "#2CB72C",
      wickDownColor: "#e5484d",
      priceLineVisible: true
    });

    state.volumeSeries = state.chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "",
      lastValueVisible: false,
      priceLineVisible: false
    });

    state.volumeSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.82,
        bottom: 0
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      if (!state.chart || !container.isConnected) return;

      state.chart.applyOptions({
        width: container.clientWidth,
        height: container.clientHeight
      });
    });

    resizeObserver.observe(container);
  }

  function normalizeCandles(rows) {
    if (!Array.isArray(rows)) return [];

    return rows.map((c) => {
      const seconds = Number(c.time ?? c.t ?? c.timestamp);

      return {
        time: seconds > 1e12
          ? Math.floor(seconds / 1000)
          : Math.floor(seconds),
        open: Number(c.open ?? c.o),
        high: Number(c.high ?? c.h),
        low: Number(c.low ?? c.l),
        close: Number(c.close ?? c.c),
        volume: Number(c.volume ?? c.v ?? 0)
      };
    }).filter((c) =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.time > 0
    ).sort((a, b) => a.time - b.time)
      .filter((c, i, arr) =>
        i === 0 || c.time !== arr[i - 1].time
      );
  }

  async function loadCandles() {
    if (!state.candleSeries) return;

    const requestId = ++state.requestId;
    const now = Math.floor(Date.now() / 1000);
    const start = now - TIMEFRAMES[state.timeframe] * 200;

    try {
      const result = await getJSON(
        "/v2/history/candles" +
        "?resolution=" + encodeURIComponent(state.timeframe) +
        "&symbol=" + encodeURIComponent(state.symbol) +
        "&start=" + start +
        "&end=" + now
      );

      if (requestId !== state.requestId) return;

      const rows = normalizeCandles(result.result);

      if (!rows.length) {
        setStatus("No candles returned for " + state.symbol);
        return;
      }

      state.candles = rows;

      state.candleSeries.setData(rows.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
      })));

      state.volumeSeries.setData(rows.map((c) => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open
          ? "rgba(44,183,44,0.35)"
          : "rgba(229,72,77,0.35)"
      })));

      state.chart.timeScale().fitContent();

      updateAnalysis();
      updateCurrentCandle(rows[rows.length - 1]);

      setStatus("Candles loaded", true);
    } catch (error) {
      console.error("Candle error:", error);
      setStatus("Candle data unavailable");
    }
  }

  function updateCurrentCandle(candle) {
    if (!candle) return;

    const ticker = state.tickers[state.symbol];
    const livePrice = tickerPrice(ticker);

    if (livePrice === null) return;

    const last = {
      ...candle,
      close: livePrice,
      high: Math.max(candle.high, livePrice),
      low: Math.min(candle.low, livePrice)
    };

    state.candleSeries.update({
      time: last.time,
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close
    });
  }

  // ---------- Tickers and market cards ----------

  async function loadTicker(symbol) {
    try {
      const result = await getJSON(
        "/v2/tickers/" + encodeURIComponent(symbol)
      );

      const ticker = result.result;

      if (ticker) {
        state.tickers[symbol] = ticker;
        updateMarketCard(symbol);
      }

      return ticker;
    } catch (error) {
      console.warn("Ticker unavailable:", symbol, error.message);
      return null;
    }
  }

  async function loadAllTickers() {
    await Promise.all(
      Object.keys(MARKETS).map(loadTicker)
    );

    renderMarketList();
    updateSelectedMarket();
    updateCurrentCandle(
      state.candles[state.candles.length - 1]
    );
  }

  function updateMarketCard(symbol) {
    const card = document.querySelector(
      '.market-card[data-market="' + symbol + '"]'
    );

    if (!card) return;

    const ticker = state.tickers[symbol];
    const p = tickerPrice(ticker);
    const change = tickerChange(ticker);

    const priceEl = card.querySelector(".market-price");
    const changeEl = card.querySelector(".market-change");

    if (priceEl) {
      priceEl.textContent = p === null ? "—" : price(p, symbol);
    }

    if (changeEl) {
      changeEl.textContent = change === null
        ? "Change unavailable"
        : (change > 0 ? "+" : "") + fmt(change, 2) + "%";

      changeEl.classList.toggle("up", change !== null && change > 0);
      changeEl.classList.toggle("down", change !== null && change < 0);
    }

    card.classList.toggle("active", symbol === state.symbol);
  }

  function updateSelectedMarket() {
    const symbol = state.symbol;
    const ticker = state.tickers[symbol];
    const p = tickerPrice(ticker);

    setText("symbol-name", symbol);
    setText("last-price", p === null ? "—" : price(p));

    const change = tickerChange(ticker);
    const changeEl = $("chg");

    if (changeEl) {
      changeEl.textContent = change === null
        ? "—"
        : (change > 0 ? "+" : "") + fmt(change, 2) + "%";

      changeEl.classList.toggle("up", change !== null && change > 0);
      changeEl.classList.toggle("down", change !== null && change < 0);
    }

    setText("mark", price(ticker?.mark_price));
    setText("high", price(ticker?.high));
    setText("low", price(ticker?.low));
    setText("vol", fmt(ticker?.volume, 2));

    document.querySelectorAll(".market-card[data-market]")
      .forEach((card) => {
        card.classList.toggle(
          "active",
          card.dataset.market === symbol
        );
      });

    document.querySelectorAll(".market-list-item")
      .forEach((item) => {
        item.classList.toggle(
          "active",
          item.dataset.market === symbol
        );
      });
  }

  function renderMarketList() {
    const container = $("market-list");
    if (!container) return;

    container.replaceChildren();

    Object.keys(MARKETS).forEach((symbol) => {
      const ticker = state.tickers[symbol];
      const p = tickerPrice(ticker);
      const change = tickerChange(ticker);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "market-list-item";
      button.dataset.market = symbol;

      const left = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = symbol;

      const description = document.createElement("small");
      description.textContent = MARKETS[symbol].name;

      left.append(name, description);

      const right = document.createElement("span");
      right.textContent = p === null ? "—" : price(p, symbol);

      if (change !== null) {
        const small = document.createElement("small");
        small.textContent =
          (change > 0 ? "+" : "") + fmt(change, 2) + "%";
        small.classList.add(change >= 0 ? "up" : "down");
        right.appendChild(small);
      }

      button.append(left, right);
      button.addEventListener("click", () => selectMarket(symbol));

      container.appendChild(button);
    });

    updateSelectedMarket();
  }

  // ---------- EMA and RSI ----------

  function ema(values, period) {
    if (values.length < period) return null;

    const multiplier = 2 / (period + 1);
    let result = values
      .slice(0, period)
      .reduce((sum, value) => sum + value, 0) / period;

    for (let i = period; i < values.length; i++) {
      result = values[i] * multiplier +
        result * (1 - multiplier);
    }

    return result;
  }

  function rsi(values, period = 14) {
    if (values.length <= period) return null;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
      const difference = values[i] - values[i - 1];

      if (difference > 0) gains += difference;
      else losses -= difference;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < values.length; i++) {
      const difference = values[i] - values[i - 1];

      avgGain =
        (avgGain * (period - 1) + Math.max(difference, 0)) /
        period;

      avgLoss =
        (avgLoss * (period - 1) + Math.max(-difference, 0)) /
        period;
    }

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  function updateAnalysis() {
    const closes = state.candles.map((c) => c.close);

    const main = $("signal-main");
    const meta = $("signal-meta");

    if (!main || !meta) return;

    if (closes.length < 30) {
      main.textContent = "Waiting for data";
      main.className = "signal-main signal-neutral";
      meta.textContent = "More candles are needed for EMA and RSI.";
      return;
    }

    const fast = ema(closes, 9);
    const slow = ema(closes, 21);
    const currentRsi = rsi(closes, 14);

    let signal = "Neutral";
    let signalClass = "signal-neutral";

    if (fast !== null && slow !== null && currentRsi !== null) {
      if (fast > slow && currentRsi >= 50 && currentRsi < 70) {
        signal = "Bullish";
        signalClass = "signal-bullish";
      } else if (
        fast < slow &&
        currentRsi < 50 &&
        currentRsi > 30
      ) {
        signal = "Bearish";
        signalClass = "signal-bearish";
      }
    }

    main.textContent = signal;
    main.className = "signal-main " + signalClass;

    meta.textContent =
      "EMA 9: " + fmt(fast, 2) +
      " | EMA 21: " + fmt(slow, 2) +
      " | RSI 14: " + fmt(currentRsi, 2) +
      " | Timeframe: " + state.timeframe +
      ". Indicator-based information only; not a guarantee.";
  }

  // ---------- Order book ----------

  async function loadOrderBook() {
    try {
      const result = await getJSON(
        "/v2/l2orderbook/" +
        encodeURIComponent(state.symbol) +
        "?depth=12"
      );

      const book = result.result || {};
      renderBookSide("asks", book.asks || [], "ask");
      renderBookSide("bids", book.bids || [], "bid");

      const ask = Number(book.asks?.[0]?.[0]);
      const bid = Number(book.bids?.[0]?.[0]);

      setText(
        "spread",
        Number.isFinite(ask) && Number.isFinite(bid)
          ? fmt(ask - bid, MARKETS[state.symbol]?.decimals ?? 2)
          : "—"
      );
    } catch (error) {
      console.warn("Order book unavailable:", error.message);
      setText("spread", "—");
      renderBookSide("asks", [], "ask");
      renderBookSide("bids", [], "bid");
    }
  }

  function renderBookSide(id, rows, className) {
    const container = $(id);
    if (!container) return;

    container.replaceChildren();

    rows.slice(0, 12).forEach((row) => {
      const line = document.createElement("div");
      line.className = "order-row " + className;

      const p = document.createElement("span");
      p.textContent = fmt(row[0], MARKETS[state.symbol]?.decimals ?? 2);

      const amount = document.createElement("span");
      amount.textContent = fmt(row[1], 4);

      line.append(p, amount);
      container.appendChild(line);
    });

    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "Order book unavailable";
      container.appendChild(empty);
    }
  }

  // ---------- Market selection ----------

  async function selectMarket(symbol) {
    if (!MARKETS[symbol] || state.symbol === symbol) return;

    state.symbol = symbol;

    updateSelectedMarket();
    setStatus("Loading " + symbol + "…");

    await Promise.all([
      loadTicker(symbol),
      loadCandles(),
      loadOrderBook()
    ]);

    updateSelectedMarket();
    updateAnalysis();
  }

  function selectTimeframe(timeframe) {
    if (!TIMEFRAMES[timeframe] || state.timeframe === timeframe) {
      return;
    }

    state.timeframe = timeframe;

    document.querySelectorAll("[data-tf]").forEach((button) => {
      button.classList.toggle(
        "active",
        button.dataset.tf === timeframe
      );
    });

    loadCandles();
  }

  function wireControls() {
    document.querySelectorAll(".market-card[data-market]")
      .forEach((card) => {
        card.addEventListener("click", () => {
          selectMarket(card.dataset.market);
        });
      });

    document.querySelectorAll("[data-tf]").forEach((button) => {
      button.addEventListener("click", () => {
        selectTimeframe(button.dataset.tf);
      });
    });

    const longButton = $("demo-long");
    const shortButton = $("demo-short");
    const amountInput = $("demo-size");

    function demoOrder(direction) {
      const amount = number(amountInput?.value);

      if (amount === null || amount <= 0) {
        setText("orderMessage", "Enter a valid demo amount.");
        return;
      }

      const ticker = state.tickers[state.symbol];
      const p = tickerPrice(ticker);

      if (p === null) {
        setText("orderMessage", "Market price unavailable. Try again later.");
        return;
      }

      setText(
        "orderMessage",
        "DEMO ONLY: " + direction + " " + state.symbol +
        " | Amount: " + fmt(amount, 2) +
        " | Reference price: " + price(p) +
        ". No real order was placed."
      );
    }

    if (longButton) {
      longButton.addEventListener("click", () => demoOrder("BUY"));
    }

    if (shortButton) {
      shortButton.addEventListener("click", () => demoOrder("SELL"));
    }
  }

  // ---------- Public WebSocket ----------

  function connectWebSocket() {
    if (state.socket) {
      try {
        state.socket.close();
      } catch (_) {}
    }

    try {
      const socket = new WebSocket(WS_URL);
      state.socket = socket;

      socket.addEventListener("open", () => {
        setStatus("Live connection active", true);

        socket.send(JSON.stringify({
          type: "subscribe",
          payload: {
            channels: [{
              name: "ticker",
              symbols: Object.keys(MARKETS)
            }]
          }
        }));
      });

      socket.addEventListener("message", (event) => {
        let message;

        try {
          message = JSON.parse(event.data);
        } catch (_) {
          return;
        }

        const data = message.data || message;
        const symbol = data.symbol || data.product_symbol;

        if (!symbol || !MARKETS[symbol]) return;

        state.tickers[symbol] = {
          ...(state.tickers[symbol] || {}),
          ...data
        };

        updateMarketCard(symbol);

        if (symbol === state.symbol) {
          updateSelectedMarket();
          updateCurrentCandle(
            state.candles[state.candles.length - 1]
          );
        }

        renderMarketList();
      });

      socket.addEventListener("error", () => {
        setStatus("Live feed issue; retrying");
      });

      socket.addEventListener("close", () => {
        if (state.reconnectTimer) {
          clearTimeout(state.reconnectTimer);
        }

        state.reconnectTimer = setTimeout(
          connectWebSocket,
          5000
        );
      });
    } catch (error) {
      console.warn("WebSocket error:", error);
      setStatus("Using REST market updates");
    }
  }

  // ---------- Start dashboard ----------

  async function start() {
    wireControls();
    initChart();

    document.querySelectorAll("[data-tf]").forEach((button) => {
      button.classList.toggle(
        "active",
        button.dataset.tf === state.timeframe
      );
    });

    setStatus("Connecting to market data…");

    await Promise.all([
      loadAllTickers(),
      loadCandles(),
      loadOrderBook()
    ]);

    connectWebSocket();

    state.tickerTimer = setInterval(loadAllTickers,
10000); 
    state.candleTimer = setInterval(loadCandles, 
60000); 
    state.bookTimer = setInterval(loadOrderBook, 
 5000); 
   } 
  
  document.addEventListener("DOMContentLoaded", 
start); 
})();
