
// KreTeX AI Trading — Demo dashboard
// Public market data only. No real orders are placed.

async function updateSolPrice() {
  const element = document.getElementById("solPrice");
  if (!element) return;

  try {
    const response = await fetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT"
    );

    if (!response.ok) throw new Error("Price request failed");

    const data = await response.json();
    const price = Number(data.price);

    if (!Number.isFinite(price)) throw new Error("Invalid price");

    element.textContent = "$" + price.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  } catch (error) {
    element.textContent = "Price unavailable";
    console.error("SOL price error:", error);
  }
}

updateSolPrice();
setInterval(updateSolPrice, 10000);
