import type {
  ExecutionMode,
  FeedItem,
  PaperPosition,
  PersistedState,
  PriceAlert,
  TradeReceipt,
  VoiceOrderIntent,
} from './types';
import { formatRawPrice } from './markets';

const STORAGE_KEY = 'evenpulse_state_v1';

export function createInitialState(): PersistedState {
  return {
    cashUsd: 10_000,
    realizedPnlUsd: 0,
    positions: [],
    alerts: [],
    receipts: [
      {
        id: 'boot',
        timestamp: Date.now(),
        summary: 'EvenPulse G2 Ready',
        detail: 'Paper desk funded with $10,000. Live Polymarket + Hyperliquid feeds active.',
        kind: 'info',
      },
    ],
    defaultPmSize: 100,
    defaultHlMargin: 100,
    defaultLeverage: 5,
    executionMode: 'paper-live',
  };
}

export function loadLocalState(): PersistedState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialState();
    const parsed = JSON.parse(raw);
    return { ...createInitialState(), ...parsed };
  } catch {
    return createInitialState();
  }
}

export function saveLocalState(state: PersistedState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore restricted WebView storage errors
  }
}

export function serializeState(state: PersistedState): string {
  return JSON.stringify({
    ...state,
    receipts: state.receipts.slice(0, 12),
  });
}

export function deserializeState(raw: string | null | undefined): PersistedState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.cashUsd === 'number') {
      return { ...createInitialState(), ...parsed };
    }
    return null;
  } catch {
    return null;
  }
}

export function computePositionPnl(pos: PaperPosition, item: FeedItem | undefined): {
  currentPrice: number;
  pnlUsd: number;
  pnlPct: number;
  liqPrice: number | null;
  liqDistPct: number | null;
} {
  if (pos.source === 'polymarket') {
    const yesPx = item ? item.price : pos.side === 'YES' ? pos.entryPrice : 1 - pos.entryPrice;
    const markSidePx = pos.side === 'YES' ? yesPx : Math.max(0.005, 1 - yesPx);
    const shares = pos.marginUsd / Math.max(0.005, pos.entryPrice);
    const valueNow = shares * markSidePx;
    const pnlUsd = valueNow - pos.marginUsd;
    const pnlPct = (pnlUsd / Math.max(1, pos.marginUsd)) * 100;
    return { currentPrice: markSidePx, pnlUsd, pnlPct, liqPrice: null, liqDistPct: null };
  }

  const mark = item ? item.price : pos.entryPrice;
  const dir = pos.side === 'LONG' ? 1 : -1;
  const priceDiffPct = (mark - pos.entryPrice) / Math.max(0.0001, pos.entryPrice);
  const pnlUsd = pos.sizeUsd * priceDiffPct * dir;
  const pnlPct = (pnlUsd / Math.max(1, pos.marginUsd)) * 100;
  // Approximate Hyperliquid isolated liq at ~90% margin loss
  const liqMove = 0.9 / Math.max(1, pos.leverage);
  const liqPrice = pos.side === 'LONG' ? pos.entryPrice * (1 - liqMove) : pos.entryPrice * (1 + liqMove);
  const liqDistPct =
    pos.side === 'LONG'
      ? ((mark - liqPrice) / Math.max(0.0001, mark)) * 100
      : ((liqPrice - mark) / Math.max(0.0001, mark)) * 100;
  return { currentPrice: mark, pnlUsd, pnlPct, liqPrice, liqDistPct };
}

export function computePortfolioSummary(state: PersistedState, feedMap: Map<string, FeedItem>): {
  equityUsd: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  marginUsedUsd: number;
} {
  let unrealized = 0;
  let marginUsed = 0;
  for (const pos of state.positions) {
    marginUsed += pos.marginUsd;
    unrealized += computePositionPnl(pos, feedMap.get(pos.itemId)).pnlUsd;
  }
  const equityUsd = state.cashUsd + marginUsed + unrealized;
  return {
    equityUsd,
    unrealizedPnlUsd: unrealized,
    totalPnlUsd: state.realizedPnlUsd + unrealized,
    marginUsedUsd: marginUsed,
  };
}

export function executePaperOrder(
  state: PersistedState,
  item: FeedItem,
  side: 'YES' | 'NO' | 'LONG' | 'SHORT',
  marginUsd: number,
  leverage = 1
): { ok: boolean; receipt: TradeReceipt } {
  const actualMargin = Math.min(marginUsd, Math.floor(state.cashUsd));
  if (actualMargin < 10) {
    const receipt: TradeReceipt = {
      id: `rej-${Date.now()}`,
      timestamp: Date.now(),
      summary: 'INSUFFICIENT PAPER CASH',
      detail: `Need >= $10 free cash (have $${state.cashUsd.toFixed(0)}). Close a position first.`,
      kind: 'info',
    };
    state.receipts.unshift(receipt);
    return { ok: false, receipt };
  }

  const effLev = item.source === 'polymarket' ? 1 : Math.max(1, Math.min(10, leverage));
  const sizeUsd = actualMargin * effLev;
  const fillPrice =
    item.source === 'polymarket'
      ? side === 'YES'
        ? Math.min(0.99, item.bestAsk ?? item.price)
        : Math.min(0.99, Math.max(0.01, 1 - (item.bestBid ?? item.price)))
      : item.price;

  // Merge if same item + side already exists
  const existing = state.positions.find((p) => p.itemId === item.id && p.side === side);
  if (existing) {
    const newSize = existing.sizeUsd + sizeUsd;
    existing.entryPrice = (existing.entryPrice * existing.sizeUsd + fillPrice * sizeUsd) / newSize;
    existing.sizeUsd = newSize;
    existing.marginUsd += actualMargin;
    existing.leverage = effLev;
  } else {
    state.positions.unshift({
      id: `pos-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      itemId: item.id,
      source: item.source,
      symbol: item.symbol,
      title: item.shortTitle,
      side,
      sizeUsd,
      marginUsd: actualMargin,
      leverage: effLev,
      entryPrice: fillPrice,
      openedAt: Date.now(),
    });
  }

  state.cashUsd -= actualMargin;
  const fillStr = formatRawPrice(item.source, fillPrice);
  const receipt: TradeReceipt = {
    id: `fill-${Date.now().toString(36).toUpperCase()}`,
    timestamp: Date.now(),
    summary: `FILLED ${side} ${item.symbol}`,
    detail:
      item.source === 'polymarket'
        ? `$${actualMargin} ${side} @ ${fillStr} (${(actualMargin / fillPrice).toFixed(1)} sh)`
        : `$${sizeUsd} (${effLev}x) ${side} @ ${fillStr}`,
    kind: 'fill',
  };
  state.receipts.unshift(receipt);
  if (state.receipts.length > 20) state.receipts.length = 20;
  return { ok: true, receipt };
}

export function closePosition(
  state: PersistedState,
  posId: string,
  feedMap: Map<string, FeedItem>
): TradeReceipt | null {
  const idx = state.positions.findIndex((p) => p.id === posId);
  if (idx === -1) return null;
  const pos = state.positions[idx];
  const { currentPrice, pnlUsd } = computePositionPnl(pos, feedMap.get(pos.itemId));
  state.positions.splice(idx, 1);
  state.cashUsd = Math.max(0, state.cashUsd + pos.marginUsd + pnlUsd);
  state.realizedPnlUsd += pnlUsd;

  const pnlStr = pnlUsd >= 0 ? `+$${pnlUsd.toFixed(2)}` : `-$${Math.abs(pnlUsd).toFixed(2)}`;
  const receipt: TradeReceipt = {
    id: `cls-${Date.now().toString(36).toUpperCase()}`,
    timestamp: Date.now(),
    summary: `CLOSED ${pos.side} ${pos.symbol}`,
    detail: `Exit @ ${formatRawPrice(pos.source, currentPrice)} | P&L ${pnlStr}`,
    kind: 'close',
  };
  state.receipts.unshift(receipt);
  return receipt;
}

export function flattenAllPositions(state: PersistedState, feedMap: Map<string, FeedItem>): TradeReceipt {
  let totalPnl = 0;
  const count = state.positions.length;
  for (const pos of state.positions) {
    const { pnlUsd } = computePositionPnl(pos, feedMap.get(pos.itemId));
    state.cashUsd = Math.max(0, state.cashUsd + pos.marginUsd + pnlUsd);
    state.realizedPnlUsd += pnlUsd;
    totalPnl += pnlUsd;
  }
  state.positions = [];
  const pnlStr = totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`;
  const receipt: TradeReceipt = {
    id: `flt-${Date.now().toString(36).toUpperCase()}`,
    timestamp: Date.now(),
    summary: count > 0 ? `FLATTENED ${count} POSITIONS` : 'NO OPEN POSITIONS',
    detail: count > 0 ? `Realized ${pnlStr} | Cash $${state.cashUsd.toFixed(0)}` : 'Book already flat.',
    kind: 'close',
  };
  state.receipts.unshift(receipt);
  return receipt;
}

export function addSmartAlert(state: PersistedState, item: FeedItem, direction: 'above' | 'below'): PriceAlert {
  const threshold =
    item.source === 'polymarket'
      ? direction === 'above'
        ? Math.min(0.98, item.price + 0.05)
        : Math.max(0.02, item.price - 0.05)
      : direction === 'above'
      ? item.price * 1.02
      : item.price * 0.98;

  const alert: PriceAlert = {
    id: `alt-${Date.now().toString(36)}`,
    itemId: item.id,
    symbol: item.symbol,
    source: item.source,
    direction,
    threshold,
    triggered: false,
    createdAt: Date.now(),
  };
  state.alerts.unshift(alert);
  state.receipts.unshift({
    id: `ar-${Date.now()}`,
    timestamp: Date.now(),
    summary: `ALERT SET: ${item.symbol}`,
    detail: `Notify when ${direction.toUpperCase()} ${formatRawPrice(item.source, threshold)}`,
    kind: 'alert',
  });
  return alert;
}

export function evaluateAlerts(state: PersistedState, feedMap: Map<string, FeedItem>): PriceAlert[] {
  const newlyTriggered: PriceAlert[] = [];
  for (const alert of state.alerts) {
    if (alert.triggered) continue;
    const item = feedMap.get(alert.itemId);
    if (!item) continue;
    const hit =
      (alert.direction === 'above' && item.price >= alert.threshold) ||
      (alert.direction === 'below' && item.price <= alert.threshold);
    if (hit) {
      alert.triggered = true;
      alert.triggeredAt = Date.now();
      newlyTriggered.push(alert);
      state.receipts.unshift({
        id: `hit-${Date.now()}`,
        timestamp: Date.now(),
        summary: `TRIGGERED: ${alert.symbol}`,
        detail: `Crossed ${alert.direction} ${formatRawPrice(alert.source, alert.threshold)} (now ${formatRawPrice(alert.source, item.price)})`,
        kind: 'alert',
      });
    }
  }
  return newlyTriggered;
}

export function parseVoiceCommand(rawInput: string, activeItem: FeedItem | undefined): VoiceOrderIntent {
  const text = rawInput.trim();
  const lower = text.toLowerCase();
  const amountMatch = lower.match(/\$?\b(\d{2,5})\b(?!x)/);
  const levMatch = lower.match(/\b(\d{1,2})\s*x\b/);
  const amountUsd = amountMatch ? Math.max(10, Math.min(5000, Number(amountMatch[1]))) : undefined;
  const leverage = levMatch ? Math.max(1, Math.min(10, Number(levMatch[1]))) : undefined;

  const coinMatch = lower.match(/\b(btc|bitcoin|eth|ethereum|sol|solana|hype|xrp|doge|sui|arb)\b/);
  const coinMap: Record<string, string> = {
    btc: 'BTC', bitcoin: 'BTC',
    eth: 'ETH', ethereum: 'ETH',
    sol: 'SOL', solana: 'SOL',
    hype: 'HYPE', xrp: 'XRP', doge: 'DOGE', sui: 'SUI', arb: 'ARB',
  };
  const symbolHint = coinMatch ? coinMap[coinMatch[1]] : activeItem?.symbol;

  if (/\b(close all|flatten|exit all)\b/.test(lower)) {
    return { raw: text, action: 'close_all', summary: 'Flatten all open paper positions' };
  }
  if (/\b(portfolio|positions|pnl|balance)\b/.test(lower)) {
    return { raw: text, action: 'portfolio', summary: 'Open Portfolio & P&L HUD' };
  }
  if (/\b(feed|markets|watchlist|home)\b/.test(lower)) {
    return { raw: text, action: 'feed', summary: 'Return to Live Market Feed' };
  }
  if (/\b(close|exit|sell)\b/.test(lower)) {
    return { raw: text, action: 'close', symbolHint, summary: `Close position on ${symbolHint || 'selected market'}` };
  }
  if (/\b(alert|watch|notify)\b/.test(lower)) {
    return { raw: text, action: 'alert', symbolHint, summary: `Set smart alert on ${symbolHint || 'selected market'}` };
  }
  if (/\b(buy yes|yes)\b/.test(lower)) {
    return {
      raw: text,
      action: 'buy_yes',
      symbolHint,
      amountUsd: amountUsd ?? 100,
      summary: `Paper BUY YES $${amountUsd ?? 100} on ${symbolHint || 'selected PM'}`,
    };
  }
  if (/\b(buy no|no)\b/.test(lower)) {
    return {
      raw: text,
      action: 'buy_no',
      symbolHint,
      amountUsd: amountUsd ?? 100,
      summary: `Paper BUY NO $${amountUsd ?? 100} on ${symbolHint || 'selected PM'}`,
    };
  }
  if (/\b(long|buy)\b/.test(lower)) {
    return {
      raw: text,
      action: 'long',
      symbolHint,
      amountUsd: amountUsd ?? 100,
      leverage: leverage ?? 5,
      summary: `Paper LONG ${symbolHint || 'selected perp'} $${amountUsd ?? 100} @ ${leverage ?? 5}x`,
    };
  }
  if (/\b(short)\b/.test(lower)) {
    return {
      raw: text,
      action: 'short',
      symbolHint,
      amountUsd: amountUsd ?? 100,
      leverage: leverage ?? 5,
      summary: `Paper SHORT ${symbolHint || 'selected perp'} $${amountUsd ?? 100} @ ${leverage ?? 5}x`,
    };
  }

  return { raw: text, action: 'unknown', summary: `Unrecognized: "${text}"` };
}

export function setExecutionMode(state: PersistedState, mode: ExecutionMode): void {
  state.executionMode = mode;
}
