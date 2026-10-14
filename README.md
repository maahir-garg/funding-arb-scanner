# Funding spread scanner

Compares perpetual futures funding rates on Binance and Hyperliquid for every coin listed on both, and ranks the gaps by what's left after trading costs.

Live at https://funding-arb-scanner-omega.vercel.app

Funding is the periodic payment between longs and shorts that keeps a perpetual's price near spot. Each exchange sets its own rate, so the same coin can pay differently on each. If you short the coin where funding is higher and go long where it's lower, the price moves cancel and you collect the difference. This page shows how big each difference is, what it costs to trade, and how long it has to last to pay for itself.

## Run it

It's a static page with no build step and no dependencies. Serve the folder with anything:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Opening `index.html` straight from disk won't work, because browsers block ES modules on `file://`.

To deploy, import the repo into Vercel with no settings changed. Requests go from the viewer's browser straight to the exchanges, so there is no server to configure. Binance blocks some countries, including the US, and users there will see an error for the Binance side.

## How it works

The page calls six public endpoints when it loads, then the five that change every 30 seconds. No API keys are needed.

| Exchange | Endpoint | Used for |
|---|---|---|
| Binance | `GET /fapi/v1/premiumIndex` | Predicted funding and mark price for every perpetual |
| Binance | `GET /fapi/v1/fundingInfo` | Funding interval of 1, 4 or 8 hours, and cap, per symbol |
| Binance | `GET /fapi/v1/exchangeInfo` | Which symbols are trading. Fetched once per page load |
| Binance | `GET /fapi/v1/ticker/24hr` | 24h volume and price change |
| Binance | `GET /fapi/v1/ticker/bookTicker` | Best bid and ask |
| Hyperliquid | `POST /info {"type":"metaAndAssetCtxs"}` | Hourly funding, mark price, impact prices and volume for every coin |

Clicking a coin calls two more endpoints for its last 7 days of funding, Binance `GET /fapi/v1/fundingRate` and Hyperliquid `POST /info {"type":"fundingHistory"}`, and lines the two up hour by hour. A Binance payment covering 8 hours counts as an eighth of the payment in each of those hours. Searching for a coin by name shows it even if it is below the volume filter.

The steps live in `src/scanner.js` as pure functions:

1. **Parse.** Keep Binance USDT perpetuals that are trading and Hyperliquid coins that aren't delisted.
2. **Match.** Pair each Hyperliquid coin with its Binance symbol. Hyperliquid's `kPEPE` is 1,000 PEPE, and so is Binance's `1000PEPEUSDT`. A pair only counts if the price per coin agrees within 5%, which catches contracts of different sizes and unrelated tokens that share a ticker.
3. **Normalise.** Hyperliquid quotes an hourly rate already. Binance pays every 1, 4 or 8 hours depending on the symbol, so the scanner divides each Binance rate by its interval.
4. **Score.** For each pair:
   - spread per year = |hourly gap| × 8,760
   - cost = 2 × (Binance fee + Hyperliquid fee) + bid-ask spread on each exchange
   - breakeven = cost ÷ hourly gap
   - net per year = (hourly gap × hold hours − cost) ÷ hold hours × 8,760
5. **Flag** spreads that usually mean a market in trouble:
   - either side paying 0.01% an hour or more;
   - Binance funding at 80% or more of its cap;
   - Binance paying the coin every hour;
   - a 15% price move in 24 hours.

Two details catch people out:

- Binance's `lastFundingRate` field is the predicted next payment, not the last one paid.
- Hyperliquid pays funding on its oracle price, Binance on its mark price.

## What it doesn't do

- **Spreads fade.** The ranking assumes today's spread lasts for the holding period, and it usually shrinks. The 7-day view on each coin shows by how much.
- **Order book depth.** The cost uses each exchange's quoted spread. Hyperliquid's comes from its $20,000 impact price for BTC and ETH and $6,000 for everything else. Larger orders would pay more.
- **The other risks.** It ignores margin, liquidation and the time it takes to move money between exchanges.
- **Other markets.** It covers Binance's crypto perpetuals and Hyperliquid's main perp exchange. Binance's stock and commodity perpetuals and Hyperliquid's builder-deployed exchanges, such as `xyz`, are left out.

## Tests

```bash
npm test
```

Uses Node's built-in test runner, so there is nothing to install. The tests cover each step with hand-built cases, plus one run of the whole pipeline on real responses recorded on 13 October 2026, so a renamed field from either exchange fails the build.
