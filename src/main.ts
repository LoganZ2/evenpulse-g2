import './style.css';
import { EvenPulseController, type HudSnapshot } from './hudController';
import { computePortfolioSummary, computePositionPnl } from './paperEngine';
import { formatCompactUsd, formatPrice, formatRawPrice, formatSignedPct, formatSignedUsd } from './markets';

const controller = new EvenPulseController();
const root = document.getElementById('app')!;

let latestSnap: HudSnapshot | null = null;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderCompanion(snap: HudSnapshot): void {
  latestSnap = snap;
  const feedMap = new Map(snap.items.map((x) => [x.id, x]));
  const summary = computePortfolioSummary(snap.state, feedMap);
  const selected = snap.selectedItem;

  // Build mirrored HUD list rows based on active screen
  let hudListHtml = '';
  let hudSideText = '';

  if (snap.screen === 'feed') {
    hudListHtml = snap.items.length
      ? snap.items
          .slice(0, 10)
          .map((item, idx) => {
            const cls = idx === snap.selectedIndex ? 'hud-row active' : 'hud-row';
            const tag = item.source === 'hyperliquid' ? 'HL' : 'PM';
            const lbl =
              item.source === 'hyperliquid'
                ? `${tag} ${item.symbol.replace('-PERP', '')}  ${formatPrice(item)}  ${formatSignedPct(item.change24hPct)}`
                : `${tag} ${item.shortTitle}  ${formatPrice(item)}`;
            return `<div class="${cls}" data-feed-idx="${idx}">${escapeHtml(lbl)}</div>`;
          })
          .join('')
      : '<div class="hud-row">Connecting live feeds...</div>';

    if (selected) {
      hudSideText =
        selected.source === 'polymarket'
          ? `${selected.symbol}\nYES ${(selected.price * 100).toFixed(1)}c | NO ${((1 - selected.price) * 100).toFixed(1)}c\n24h Vol: ${formatCompactUsd(selected.volume24hUsd)}\nTAP Trade | HOLD +YES`
          : `${selected.symbol} ${formatSignedPct(selected.change24hPct)}\nMARK: ${formatPrice(selected)}\nFUND: ${selected.funding8hPct != null ? formatSignedPct(selected.funding8hPct, '%/8h') : 'n/a'}\nTAP Trade | HOLD Long`;
    }
  } else if (snap.screen === 'detail' && selected) {
    const pos = snap.state.positions.find((p) => p.itemId === selected.id);
    const actions =
      selected.source === 'polymarket'
        ? [
            `BUY YES $${snap.state.defaultPmSize} Paper`,
            `BUY NO $${snap.state.defaultPmSize} Paper`,
            `BUY YES $${snap.state.defaultPmSize * 2} Paper`,
            ...(pos ? [`CLOSE ${pos.side} Position`] : []),
            'SET ALERT (+5c Up)',
            'SET ALERT (-5c Down)',
            '< BACK TO FEED',
          ]
        : [
            `LONG $${snap.state.defaultHlMargin * snap.state.defaultLeverage} (${snap.state.defaultLeverage}x Paper)`,
            `SHORT $${snap.state.defaultHlMargin * snap.state.defaultLeverage} (${snap.state.defaultLeverage}x Paper)`,
            ...(pos ? [`CLOSE ${pos.side} Position`] : []),
            'SET ALERT (+2% Up)',
            'SET ALERT (-2% Down)',
            '< BACK TO FEED',
          ];

    hudListHtml = actions
      .map((a, idx) => {
        const cls = idx === snap.detailActionIndex ? 'hud-row active' : 'hud-row';
        return `<div class="${cls}" data-detail-idx="${idx}">${escapeHtml(a)}</div>`;
      })
      .join('');
    hudSideText = `${selected.fullTitle}\n${pos ? `OPEN ${pos.side} $${pos.sizeUsd}` : snap.banner}`;
  } else if (snap.screen === 'portfolio') {
    const rows = snap.state.positions.map((p, idx) => {
      const { pnlUsd, liqDistPct } = computePositionPnl(p, feedMap.get(p.itemId));
      const liq = liqDistPct != null ? ` L:${liqDistPct.toFixed(0)}%` : '';
      const cls = idx === snap.portfolioIndex ? 'hud-row active' : 'hud-row';
      return `<div class="${cls}" data-port-idx="${idx}">${escapeHtml(`${p.side} ${p.symbol} $${p.sizeUsd} ${formatSignedUsd(pnlUsd, 1)}${liq}`)}</div>`;
    });
    if (!rows.length) rows.push('<div class="hud-row active">No open positions</div>');
    hudListHtml = rows.join('');
    hudSideText = `EQUITY: $${summary.equityUsd.toFixed(2)}\nCASH: $${snap.state.cashUsd.toFixed(2)}\nOPEN P&L: ${formatSignedUsd(summary.unrealizedPnlUsd, 2)}`;
  } else if (snap.screen === 'alerts') {
    hudListHtml = snap.state.alerts.length
      ? snap.state.alerts
          .map(
            (a, idx) =>
              `<div class="${idx === snap.alertIndex ? 'hud-row active' : 'hud-row'}">${a.triggered ? '[HIT]' : '[ARM]'} ${escapeHtml(a.symbol)} ${a.direction.toUpperCase()} ${formatRawPrice(a.source, a.threshold)}</div>`
          )
          .join('')
      : '<div class="hud-row active">No price alerts set yet</div>';
    hudSideText = 'Alerts poll Polymarket & Hyperliquid every 15s and flash the HUD on trigger.';
  } else {
    hudListHtml = `<div class="hud-row active">MIC: ${snap.voiceListening ? 'LIVE' : 'STANDBY'}</div>
      <div class="hud-row">${escapeHtml(snap.voiceTranscript)}</div>`;
    hudSideText = 'Voice orders route to local paper desk or Hyperliquid Testnet.';
  }

  const positionsHtml = snap.state.positions.length
    ? snap.state.positions
        .map((p) => {
          const { currentPrice, pnlUsd, liqDistPct } = computePositionPnl(p, feedMap.get(p.itemId));
          const cls = pnlUsd >= 0 ? 'pos' : 'neg';
          return `<div class="pos-item">
            <div>
              <strong>${escapeHtml(p.side)} ${escapeHtml(p.symbol)}</strong>
              <div style="color:var(--muted);font-size:10.5px;">$${p.sizeUsd} (${p.leverage}x) @ ${formatRawPrice(p.source, p.entryPrice)} → ${formatRawPrice(p.source, currentPrice)}${liqDistPct != null ? ` · Liq ${liqDistPct.toFixed(1)}%` : ''}</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="pos-pnl ${cls}">${formatSignedUsd(pnlUsd, 2)}</span>
              <button data-close-pos="${p.id}">Close</button>
            </div>
          </div>`;
        })
        .join('')
    : '<div style="color:var(--muted);font-size:12px;font-family:var(--mono);">No open paper positions. Tap any market on the G2 HUD or speak a voice order.</div>';

  const receiptsHtml = snap.state.receipts
    .slice(0, 6)
    .map(
      (r) => `<div class="receipt-item">
        <div>
          <strong style="color:var(--green);">${escapeHtml(r.summary)}</strong>
          <div style="color:var(--muted);font-size:10.5px;">${escapeHtml(r.detail)}</div>
        </div>
        <span style="color:var(--muted);font-size:10px;">${new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
      </div>`
    )
    .join('');

  root.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-dot"></div>
          <div>
            <h1>EVENPULSE</h1>
            <span>Polymarket &amp; Hyperliquid Read + Write HUD for Even G2</span>
          </div>
        </div>
        <div class="pill-row">
          <span class="pill">${escapeHtml(snap.deviceLabel)}</span>
          <span class="pill muted">SDK 0.0.16 · 576×288</span>
          <span class="pill muted">${snap.state.executionMode === 'hl-testnet' ? 'HL Testnet Feed' : 'Mainnet Read / Paper Exec'}</span>
        </div>
      </header>

      <section class="hud-stage">
        <div class="hud-meta">
          <span>EVEN G2 WAVEGUIDE MIRROR · SCREEN: ${snap.screen.toUpperCase()} · FILTER: ${snap.filter.toUpperCase()}</span>
          <span>${snap.lastUpdated ? `LIVE ${new Date(snap.lastUpdated).toLocaleTimeString()}` : 'SYNCING...'}</span>
        </div>
        <div class="hud-glass">
          <div class="hud-hdr">EVENPULSE | ${snap.screen.toUpperCase()} | PAPER $${summary.equityUsd.toFixed(0)} (${formatSignedUsd(summary.totalPnlUsd, 2)})</div>
          <div class="hud-body">
            <div class="hud-list">${hudListHtml}</div>
            <div class="hud-side">
              ${snap.chartDataUrl ? `<img class="hud-chart" src="${snap.chartDataUrl}" alt="G2 4-bit sparkline" />` : '<div class="hud-chart"></div>'}
              <div class="hud-card">${escapeHtml(hudSideText)}</div>
            </div>
          </div>
          <div class="hud-ftr">${escapeHtml(snap.banner)}</div>
        </div>

        <div class="controls">
          <button id="btn-up">▲ Up</button>
          <button id="btn-down">▼ Down</button>
          <button id="btn-tap" class="primary">● Tap / Trade</button>
          <button id="btn-hold">◉ Hold Quick-Exec</button>
          <button id="btn-dbl">◎ Double-Tap</button>
          <button id="btn-menu-all">All</button>
          <button id="btn-menu-pm">Polymarket</button>
          <button id="btn-menu-hl">Hyperliquid</button>
          <button id="btn-menu-port">Portfolio</button>
          <button id="btn-menu-alerts">Alerts</button>
          <button id="btn-menu-voice">Voice HUD</button>
        </div>
      </section>

      <div class="grid">
        <div class="card">
          <h2>
            <span>Voice &amp; One-Tap Write Desk</span>
            <button id="btn-mic">${snap.voiceListening ? 'Stop G2 MIC' : 'Arm G2 MIC'}</button>
          </h2>
          <form class="voice-form" id="voice-form">
            <input id="voice-input" type="text" placeholder='Try: "Long BTC 200 5x", "Buy Yes 100", "Short SOL 5x", "Close all"' />
            <button type="submit" class="primary">Run</button>
          </form>
          <div class="chips">
            <button class="chip" data-voice="Long BTC 100 5x">Long BTC $500 (5x)</button>
            <button class="chip" data-voice="Short ETH 100 5x">Short ETH $500 (5x)</button>
            <button class="chip" data-voice="Buy Yes 100">Buy YES $100</button>
            <button class="chip" data-voice="Buy No 100">Buy NO $100</button>
            <button class="chip" data-voice="Alert">Set Alert</button>
            <button class="chip danger" data-voice="Close all">Flatten All</button>
          </div>
          <div class="settings-row">
            <label>HL Feed:
              <select id="sel-mode">
                <option value="paper-live" ${snap.state.executionMode === 'paper-live' ? 'selected' : ''}>Mainnet Live + Paper</option>
                <option value="hl-testnet" ${snap.state.executionMode === 'hl-testnet' ? 'selected' : ''}>Hyperliquid Testnet</option>
              </select>
            </label>
            <label>Size:
              <select id="sel-size">
                <option value="50" ${snap.state.defaultPmSize === 50 ? 'selected' : ''}>$50</option>
                <option value="100" ${snap.state.defaultPmSize === 100 ? 'selected' : ''}>$100</option>
                <option value="250" ${snap.state.defaultPmSize === 250 ? 'selected' : ''}>$250</option>
              </select>
            </label>
            <label>Lev:
              <select id="sel-lev">
                <option value="2" ${snap.state.defaultLeverage === 2 ? 'selected' : ''}>2x</option>
                <option value="5" ${snap.state.defaultLeverage === 5 ? 'selected' : ''}>5x</option>
                <option value="10" ${snap.state.defaultLeverage === 10 ? 'selected' : ''}>10x</option>
              </select>
            </label>
            <button id="btn-reset" class="danger">Reset $10k</button>
          </div>
        </div>

        <div class="card">
          <h2><span>Paper Portfolio &amp; Risk</span><span>${snap.state.positions.length} Open</span></h2>
          <div class="stats-row">
            <div class="stat"><div class="k">EQUITY</div><div class="v">$${summary.equityUsd.toFixed(0)}</div></div>
            <div class="stat"><div class="k">FREE CASH</div><div class="v">$${snap.state.cashUsd.toFixed(0)}</div></div>
            <div class="stat"><div class="k">TOTAL P&amp;L</div><div class="v" style="color:${summary.totalPnlUsd >= 0 ? 'var(--green)' : 'var(--danger)'}">${formatSignedUsd(summary.totalPnlUsd, 2)}</div></div>
          </div>
          <div>${positionsHtml}</div>
        </div>
      </div>

      <div class="card" style="margin-top:12px;">
        <h2><span>Execution &amp; Alert Tape</span><button id="btn-refresh">Refresh Feeds</button></h2>
        <div>${receiptsHtml}</div>
      </div>
    </div>
  `;

  // Wire companion controls
  document.getElementById('btn-up')?.addEventListener('click', () => void controller.stepSelection(-1));
  document.getElementById('btn-down')?.addEventListener('click', () => void controller.stepSelection(1));
  document.getElementById('btn-tap')?.addEventListener('click', () => void controller.handlePrimaryClick());
  document.getElementById('btn-hold')?.addEventListener('click', () => void controller.executeQuickHoldAction());
  document.getElementById('btn-dbl')?.addEventListener('click', () => void controller.handleDoubleClick());
  document.getElementById('btn-menu-all')?.addEventListener('click', () => void controller.handleMenuAction(1));
  document.getElementById('btn-menu-pm')?.addEventListener('click', () => void controller.handleMenuAction(2));
  document.getElementById('btn-menu-hl')?.addEventListener('click', () => void controller.handleMenuAction(3));
  document.getElementById('btn-menu-port')?.addEventListener('click', () => void controller.handleMenuAction(4));
  document.getElementById('btn-menu-alerts')?.addEventListener('click', () => void controller.handleMenuAction(5));
  document.getElementById('btn-menu-voice')?.addEventListener('click', () => void controller.handleMenuAction(6));
  document.getElementById('btn-refresh')?.addEventListener('click', () => void controller.refreshData(true));
  document.getElementById('btn-mic')?.addEventListener('click', () => void controller.toggleVoiceMic());
  document.getElementById('btn-reset')?.addEventListener('click', () => void controller.resetPaperDesk());

  document.querySelectorAll<HTMLElement>('[data-feed-idx]').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = Number(el.dataset.feedIdx);
      void controller.selectFeedIndex(idx, idx === latestSnap?.selectedIndex);
    });
  });

  document.querySelectorAll<HTMLElement>('[data-detail-idx]').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = Number(el.dataset.detailIdx);
      const cur = latestSnap?.detailActionIndex ?? 0;
      const diff = idx - cur;
      void controller.stepSelection(diff).then(() => controller.handlePrimaryClick());
    });
  });

  document.querySelectorAll<HTMLElement>('[data-voice]').forEach((el) => {
    el.addEventListener('click', () => {
      const cmd = el.dataset.voice || '';
      if (cmd) void controller.executeVoiceTranscript(cmd);
    });
  });

  document.querySelectorAll<HTMLElement>('[data-close-pos]').forEach((el) => {
    el.addEventListener('click', () => {
      const posId = el.dataset.closePos;
      if (!posId || !latestSnap) return;
      const idx = latestSnap.state.positions.findIndex((p) => p.id === posId);
      if (idx !== -1) {
        void controller.setScreen('portfolio').then(async () => {
          await controller.stepSelection(idx);
          await controller.handlePrimaryClick();
        });
      }
    });
  });

  document.getElementById('voice-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = document.getElementById('voice-input') as HTMLInputElement | null;
    const text = inp?.value.trim();
    if (text) void controller.executeVoiceTranscript(text);
  });

  document.getElementById('sel-mode')?.addEventListener('change', (e) => {
    const val = (e.target as HTMLSelectElement).value as 'paper-live' | 'hl-testnet';
    void controller.setExecutionMode(val);
  });

  document.getElementById('sel-size')?.addEventListener('change', (e) => {
    const sz = Number((e.target as HTMLSelectElement).value);
    void controller.updateRiskDefaults(sz, sz, snap.state.defaultLeverage);
  });

  document.getElementById('sel-lev')?.addEventListener('change', (e) => {
    const lev = Number((e.target as HTMLSelectElement).value);
    void controller.updateRiskDefaults(snap.state.defaultPmSize, snap.state.defaultHlMargin, lev);
  });
}

controller.subscribe(renderCompanion);
void controller.boot();
