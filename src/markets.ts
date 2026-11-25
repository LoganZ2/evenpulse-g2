import type { ExecutionMode, FeedItem } from './types';

const POLYMARKET_GAMMA_URL =
  'https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=40';
const POLYMARKET_CLOB_HISTORY_URL = 'https://clob.polymarket.com/prices-history';
const HYPERLIQUID_MAINNET_URL = 'https://api.hyperliquid.xyz/info';
const HYPERLIQUID_TESTNET_URL = 'https://api.hyperliquid-testnet.xyz/info';

const FEATURED_PERPS = ['BTC', 'ETH', 'SOL', 'HYPE', 'XRP', 'DOGE', 'SUI', 'ARB'];

function compactPmTitle(question: string): string {
  const cleaned = question
    .replace(/^Will\s+there\s+be\s+/i, '')
    .replace(/^Will\s+the\s+/i, '')
    .replace(/^Will\s+/i, '')
    .replace(/\?+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const capped = cleaned ? cleaned[0].toUpperCase() + cleaned.slice(1) : 'Market';
  if (capped.length <= 26) return capped;
  return capped.slice(0, 25).trimEnd() + '..';
}

function derivePmTicker(question: string): string {
  const stop = new Set(['will', 'the', 'be', 'in', 'by', 'of', 'to', 'a', 'an', 'on', 'for', 'at', 'or', 'and', '2026', '2027']);
  const words = question
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !stop.has(w.toLowerCase()));
  const tag = (words[0] || 'MKT').toUpperCase().slice(0, 6);
  return `PM:${tag}`;
}

function safeJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function synthesizeTrend(current: number, delta: number, isProb: boolean): number[] {
  const pts = 24;
  const start = isProb
    ? Math.max(0.02, Math.min(0.98, current - delta))
    : Math.max(0.0001, current / (1 + delta / 100));
  const out: number[] = [];
  for (let i = 0; i < pts; i++) {
    const t = i / (pts - 1);
    const wave = Math.sin(t * Math.PI * 2.5 + current * 13) * 0.18 * (1 - t);
    const val = start + (current - start) * t + (current - start) * wave;
    out.push(isProb ? Math.max(0.01, Math.min(0.99, val)) : Math.max(0.0001, val));
  }
  out[pts - 1] = current;
  return out;
}

export async function fetchPolymarketFeed(): Promise<FeedItem[]> {
  const res = await fetch(POLYMARKET_GAMMA_URL);
  if (!res.ok) throw new Error(`Polymarket HTTP ${res.status}`);
  const rows: any[] = await res.json();
  const now = Date.now();
  const items: FeedItem[] = [];

  for (const m of rows) {
    if (items.length >= 8) break;
    const question = String(m.question || '').trim();
    if (!question) continue;
    const prices = safeJsonArray(m.outcomePrices).map(Number);
    const outcomes = safeJsonArray(m.outcomes);
    const tokens = safeJsonArray(m.clobTokenIds);
    const yesPrice = prices[0];
    if (!Number.isFinite(yesPrice) || yesPrice < 0.04 || yesPrice > 0.96) continue;

    const delta = Number(m.oneDayPriceChange ?? 0);
    const vol = Number(m.volume24hr ?? 0);
    if (vol < 25_000) continue;

    items.push({
      id: `pm:${m.id}`,
      source: 'polymarket',
      symbol: derivePmTicker(question),
      shortTitle: compactPmTitle(question),
      fullTitle: question,
      price: yesPrice,
      change24hPct: Number.isFinite(delta) ? delta * 100 : 0,
      volume24hUsd: vol,
      yesLabel: outcomes[0] || 'Yes',
      noLabel: outcomes[1] || 'No',
      bestBid: Number.isFinite(Number(m.bestBid)) ? Number(m.bestBid) : Math.max(0.01, yesPrice - 0.005),
      bestAsk: Number.isFinite(Number(m.bestAsk)) ? Number(m.bestAsk) : Math.min(0.99, yesPrice + 0.005),
      clobTokenId: tokens[0],
      series: synthesizeTrend(yesPrice, Number.isFinite(delta) ? delta : 0, true),
      updatedAt: now,
    });
  }

  return items;
}

export async function fetchPolymarketHistory(tokenId: string): Promise<number[] | null> {
  try {
    const url = `${POLYMARKET_CLOB_HISTORY_URL}?market=${encodeURIComponent(tokenId)}&interval=1d&fidelity=60`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const history: Array<{ p: number }> = data?.history || [];
    const pts = history.map((h) => Number(h.p)).filter((p) => Number.isFinite(p) && p >= 0 && p <= 1);
    return pts.length >= 4 ? pts.slice(-24) : null;
  } catch {
    return null;
  }
}

export async function fetchHyperliquidFeed(mode: ExecutionMode): Promise<FeedItem[]> {
  const endpoint = mode === 'hl-testnet' ? HYPERLIQUID_TESTNET_URL : HYPERLIQUID_MAINNET_URL;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
  });
  if (!res.ok) throw new Error(`Hyperliquid HTTP ${res.status}`);
  const payload = await res.json();
  const universe: Array<{ name: string }> = payload?.[0]?.universe || [];
  const ctxs: any[] = payload?.[1] || [];
  const now = Date.now();

  const byName = new Map<string, { name: string; ctx: any }>();
  for (let i = 0; i < Math.min(universe.length, ctxs.length); i++) {
    byName.set(universe[i].name, { name: universe[i].name, ctx: ctxs[i] });
  }

  const chosen: Array<{ name: string; ctx: any }> = [];
  for (const sym of FEATURED_PERPS) {
    const found = byName.get(sym);
    if (found && Number(found.ctx.markPx) > 0) chosen.push(found);
  }
  if (chosen.length < 6) {
    for (const entry of byName.values()) {
      if (chosen.length >= 8) break;
      if (!chosen.some((c) => c.name === entry.name) && Number(entry.ctx.markPx) > 0) {
        chosen.push(entry);
      }
    }
  }

  return chosen.map(({ name, ctx }) => {
    const mark = Number(ctx.markPx || ctx.midPx || 0);
    const prev = Number(ctx.prevDayPx || mark);
    const chgPct = prev > 0 ? ((mark - prev) / prev) * 100 : 0;
    const fundingHourly = Number(ctx.funding || 0);
    const funding8hPct = fundingHourly * 8 * 100;
    const vol = Number(ctx.dayNtlVlm || 0);
    const oi = Number(ctx.openInterest || 0) * mark;
    return {
      id: `hl:${name}`,
      source: 'hyperliquid',
      symbol: `${name}-PERP`,
      shortTitle: `${name} Perp`,
      fullTitle: `Hyperliquid ${name}-USD Perpetual${mode === 'hl-testnet' ? ' (Testnet)' : ''}`,
      price: mark,
      change24hPct: chgPct,
      volume24hUsd: vol,
      funding8hPct,
      openInterestUsd: oi,
      series: synthesizeTrend(mark, chgPct, false),
      updatedAt: now,
    };
  });
}

export async function fetchHyperliquidCandles(
  coin: string,
  mode: ExecutionMode
): Promise<number[] | null> {
  const endpoint = mode === 'hl-testnet' ? HYPERLIQUID_TESTNET_URL : HYPERLIQUID_MAINNET_URL;
  const endTime = Date.now();
  const startTime = endTime - 24 * 3600 * 1000;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'candleSnapshot',
        req: { coin, interval: '1h', startTime, endTime },
      }),
    });
    if (!res.ok) return null;
    const candles: Array<{ c: string }> = await res.json();
    const closes = candles.map((c) => Number(c.c)).filter((n) => Number.isFinite(n) && n > 0);
    return closes.length >= 4 ? closes.slice(-24) : null;
  } catch {
    return null;
  }
}

export function formatPrice(item: FeedItem): string {
  if (item.source === 'polymarket') {
    return `${(item.price * 100).toFixed(1)}c`;
  }
  const p = item.price;
  if (p >= 10_000) return `$${Math.round(p).toLocaleString('en-US')}`;
  if (p >= 100) return `$${p.toFixed(1)}`;
  if (p >= 1) return `$${p.toFixed(2)}`;
  return `$${p.toFixed(4)}`;
}

export function formatRawPrice(source: 'polymarket' | 'hyperliquid', p: number): string {
  if (source === 'polymarket') return `${(p * 100).toFixed(1)}c`;
  if (p >= 10_000) return `$${Math.round(p).toLocaleString('en-US')}`;
  if (p >= 100) return `$${p.toFixed(1)}`;
  if (p >= 1) return `$${p.toFixed(2)}`;
  return `$${p.toFixed(4)}`;
}

export function formatCompactUsd(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

export function formatSignedPct(v: number, suffix = '%'): string {
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}${suffix}`;
}

export function formatSignedUsd(v: number, decimals = 2): string {
  const abs = Math.abs(v).toFixed(decimals);
  return v >= 0 ? `+$${abs}` : `-$${abs}`;
}
