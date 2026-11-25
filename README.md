# EvenPulse — Polymarket & Hyperliquid Read + Write HUD for Even Realities G2

> **One glance on the 576×288 green waveguide. One tap, hold, or voice command to act.**

**EvenPulse** is a native **Even Hub SDK (`0.0.16`)** smart-glasses application for the **Even Realities G2** and **R1 Ring** built for the **Heads Up: Even Realities Hackathon (Track 2: Crypto & DeFi)**.

It bridges **live Polymarket prediction markets** and **live Hyperliquid perpetual futures** directly into a zero-clutter monochrome green HUD — combining **real-time glanceable reads** (24h candle sparklines, YES/NO probability split bars, 8h funding rates, mark-to-market P&L, and liquidation distance warnings) with **2-second hands-free writes** (1-tap paper orders, hold-to-execute quick trades, smart price alerts, and glasses-MIC voice commands).

> **Safety & Compliance:** All live market prices, 24h candles, funding rates, and prediction odds are read-only from public Polymarket & Hyperliquid endpoints (with an optional Hyperliquid Official Testnet feed toggle). All order execution runs against a persistent **$10,000 paper trading desk** (no mainnet funds at risk).

---

## Live Demo & Packaged Build

- **Packaged EvenHub App (`.ehpk`)**: [`evenpulse-g2.ehpk`](./evenpulse-g2.ehpk) (stamped `min_app_version: 2.2.10`, `min_sdk_version: 0.0.16`)
- **Live Interactive Browser Preview (576×288 G2 Mirror + Companion Desk)**: https://loganz2.github.io/evenpulse-g2/
- **Demo Video**: [`demo/evenpulse-g2-demo.mp4`](./demo/evenpulse-g2-demo.mp4)

---

## Why It Fits Even G2 ("Read & Write")

| Pillar | What EvenPulse Does on Even G2 (576×288 Monochrome Green) |
| :--- | :--- |
| **Glanceable Read** | Interleaved live Polymarket + Hyperliquid watchlist paired with a live **4-bit grayscale 24h sparkline** (`updateImageRawData`), YES/NO split bar, 24h volume, 8h funding rate, and 5-level phosphor luminance hierarchy (`textColor: 1..4`). |
| **2-Second Write** | **Tap** any market → instant Read + Write order card (`LONG 5x`, `SHORT 5x`, `BUY YES`, `BUY NO`, `SET ALERT`, `CLOSE`). **Long-Press** (R1 Ring or right temple via `LONG_PRESS_EVENT` / `LONG_PRESS_RELEASE_EVENT`) arms & executes an immediate quick-order with HUD receipt. |
| **Voice Order HUD** | Activates Even G2 glasses microphone (`audioControl(true, AudioInputSource.Glasses)`) with live PCM RMS telemetry and deterministic command parsing (`"Long BTC 200 5x"`, `"Buy Yes 100"`, `"Short ETH 5x"`, `"Alert"`, `"Close all"`). |
| **Live Risk & P&L** | **Double-Tap** anywhere toggles straight to your **Portfolio & P&L HUD** showing live mark-to-market unrealized P&L, **isolated liquidation distance %**, equity allocation bar chart, and **1-tap Close / Flatten All** — persisted via `bridge.setLocalStorage`. |
| **Contextual Menu** | Native Even G2 `menuObject` (`menuItemClickEvent`) switches filters (`All Live`, `Polymarket Odds`, `Hyperliquid Perps`), jumps to `Portfolio`, `Alerts`, `Voice HUD`, refreshes feeds, or flattens all positions. |

---

## Simulator Captures (Real `evenhub-simulator@0.9.5` 576×288 Framebuffer)

| Live Feed (Hyperliquid 24h Candles) | Polymarket Read + Write Detail | Live Portfolio & Liquidation Risk |
| :---: | :---: | :---: |
| ![Feed BTC](sim_captures_v2/01_feed_btc.png) | ![Polymarket Detail](sim_captures_v2/06_detail_pm_filled.png) | ![Portfolio HUD](sim_captures_v2/08_portfolio_both.png) |

---

## Architecture

```text
evenpulse-g2/
├── app.json                  # EvenHub manifest (package_id: ink.zky.evenpulse, network whitelist)
├── evenpulse-g2.ehpk         # Pre-built EvenHub package ready for sideload / QA
├── src/
│   ├── types.ts              # FeedItem, PaperPosition, PriceAlert, TradeReceipt, VoiceOrderIntent
│   ├── markets.ts            # Live Polymarket Gamma/CLOB + Hyperliquid Mainnet/Testnet API clients
│   ├── chartRenderer.ts      # Offscreen 4-bit monochrome PNG sparkline, YES/NO gauge & equity chart renderer
│   ├── paperEngine.ts        # $10K paper trading engine, liq-distance math, alert watchdog, voice parser
│   ├── hudController.ts      # Native @evenrealities/even_hub_sdk@0.0.16 multi-screen G2 controller
│   ├── main.ts               # Companion Even App WebView + standalone 576x288 G2 interactive mirror
│   └── style.css             # Obsidian & waveguide phosphor-green companion UI
└── demo/
    └── evenpulse-g2-demo.mp4 # Recorded walkthrough from real EvenHub Simulator framebuffer
```

### Live Public Data Endpoints (CORS-Enabled, Zero API Keys Required)
- **Polymarket Gamma API**: `https://gamma-api.polymarket.com/markets` (top 24h volume active binary markets)
- **Polymarket CLOB History**: `https://clob.polymarket.com/prices-history` (24h probability curve)
- **Hyperliquid Info API**: `https://api.hyperliquid.xyz/info` & `https://api.hyperliquid-testnet.xyz/info` (`metaAndAssetCtxs` + 1h `candleSnapshot`)

---

## Quick Start (Local Development & EvenHub Simulator)

### Prerequisites
- Node.js `>= 22`

### 1. Install & Run Locally
```bash
npm install
npm run dev
```

### 2. Launch in Official EvenHub Simulator
```bash
npx evenhub-simulator http://127.0.0.1:5173 --glow --automation-port 9898
```

### 3. Build & Repackage `.ehpk`
```bash
npm run pack
# Outputs: evenpulse-g2.ehpk (min_app_version 2.2.10, SDK 0.0.16)
```

---

## Controls Cheat Sheet (Even G2 Temple / R1 Ring)

- **Scroll Up / Down**: Navigate live Polymarket + Hyperliquid watchlist, order actions, or open positions
- **Single Tap (`CLICK_EVENT`)**: Inspect selected market → Execute selected paper order / Close position
- **Double Tap (`DOUBLE_CLICK_EVENT`)**: Toggle between Live Feed and Portfolio & P&L HUD
- **Long Press + Release (`LONG_PRESS_EVENT` → `LONG_PRESS_RELEASE_EVENT`)**: Arm & execute 1-step Quick Order (`LONG` perp / `BUY YES` prediction)
- **Context Menu (`menuItemClickEvent`)**: Switch `All Live` / `Polymarket` / `Hyperliquid` / `Portfolio` / `Alerts` / `Voice HUD` / `Flatten All`

---

## Disclosure & License

Built from scratch during the **Heads Up: Even Realities Hackathon (Nov 23–29, 2026)** with zero pre-existing prototype code. Licensed under the [MIT License](./LICENSE).
