export type FeedSource = 'polymarket' | 'hyperliquid';
export type FilterMode = 'all' | 'polymarket' | 'hyperliquid';
export type HudScreen = 'feed' | 'detail' | 'portfolio' | 'alerts' | 'voice';
export type ExecutionMode = 'paper-live' | 'hl-testnet';

export interface FeedItem {
  id: string;
  source: FeedSource;
  symbol: string;        // Short HUD ticker e.g. "BTC-PERP" or "PM:FED"
  shortTitle: string;    // <= 30 chars for list item
  fullTitle: string;     // Full question or market name
  price: number;         // USD price (HL) or 0..1 probability (PM)
  change24hPct: number;  // Percentage points (PM) or % change (HL)
  volume24hUsd: number;
  funding8hPct?: number; // HL 8h funding %
  openInterestUsd?: number;
  yesLabel?: string;     // PM outcome 0 label (usually "Yes")
  noLabel?: string;      // PM outcome 1 label (usually "No")
  bestBid?: number;
  bestAsk?: number;
  clobTokenId?: string;
  series: number[];      // Historical sparkline points (oldest -> newest)
  updatedAt: number;
}

export interface PaperPosition {
  id: string;
  itemId: string;
  source: FeedSource;
  symbol: string;
  title: string;
  side: 'YES' | 'NO' | 'LONG' | 'SHORT';
  sizeUsd: number;       // Notional USD (for HL = margin * leverage; for PM = cost basis)
  marginUsd: number;     // Cash committed
  leverage: number;      // 1 for PM, 2..10 for HL
  entryPrice: number;    // 0..1 for PM (side price), USD mark for HL
  openedAt: number;
}

export interface PriceAlert {
  id: string;
  itemId: string;
  symbol: string;
  source: FeedSource;
  direction: 'above' | 'below';
  threshold: number;
  triggered: boolean;
  triggeredAt?: number;
  createdAt: number;
}

export interface TradeReceipt {
  id: string;
  timestamp: number;
  summary: string;
  detail: string;
  kind: 'fill' | 'close' | 'alert' | 'info' | 'voice';
}

export interface VoiceOrderIntent {
  raw: string;
  action: 'buy_yes' | 'buy_no' | 'long' | 'short' | 'close' | 'close_all' | 'alert' | 'portfolio' | 'feed' | 'unknown';
  symbolHint?: string;
  amountUsd?: number;
  leverage?: number;
  summary: string;
}

export interface PersistedState {
  cashUsd: number;
  realizedPnlUsd: number;
  positions: PaperPosition[];
  alerts: PriceAlert[];
  receipts: TradeReceipt[];
  defaultPmSize: number;
  defaultHlMargin: number;
  defaultLeverage: number;
  executionMode: ExecutionMode;
}
