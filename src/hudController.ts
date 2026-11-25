import {
  AudioInputSource,
  CreateStartUpPageContainer,
  EvenAppBridge,
  EventSourceType,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import {
  addSmartAlert,
  closePosition,
  computePortfolioSummary,
  computePositionPnl,
  deserializeState,
  evaluateAlerts,
  executePaperOrder,
  flattenAllPositions,
  loadLocalState,
  parseVoiceCommand,
  saveLocalState,
  serializeState,
} from './paperEngine';
import {
  fetchHyperliquidCandles,
  fetchHyperliquidFeed,
  fetchPolymarketFeed,
  fetchPolymarketHistory,
  formatCompactUsd,
  formatPrice,
  formatRawPrice,
  formatSignedPct,
  formatSignedUsd,
} from './markets';
import { renderPortfolioChartPng, renderSparklinePng } from './chartRenderer';
import type {
  ExecutionMode,
  FeedItem,
  FilterMode,
  HudScreen,
  PersistedState,
  TradeReceipt,
} from './types';

export interface HudSnapshot {
  connected: boolean;
  deviceLabel: string;
  launchSource: string;
  screen: HudScreen;
  filter: FilterMode;
  selectedIndex: number;
  selectedItem: FeedItem | null;
  detailActionIndex: number;
  portfolioIndex: number;
  alertIndex: number;
  items: FeedItem[];
  state: PersistedState;
  banner: string;
  longPressArmed: boolean;
  voiceListening: boolean;
  voiceTranscript: string;
  voiceRms: number;
  lastUpdated: number;
  lastError: string | null;
  chartDataUrl: string | null;
}

const MENU_ALL = 1;
const MENU_PM = 2;
const MENU_HL = 3;
const MENU_PORTFOLIO = 4;
const MENU_ALERTS = 5;
const MENU_VOICE = 6;
const MENU_REFRESH = 7;
const MENU_FLATTEN = 8;

const STORAGE_BRIDGE_KEY = 'evenpulse_state_v1';

function clipAscii(s: string, maxLen: number): string {
  const clean = s.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, Math.max(1, maxLen - 2)) + '..';
}

function clipLines(lines: string[], maxCharsPerLine: number): string {
  return lines
    .map((ln) => clipAscii(ln, maxCharsPerLine))
    .filter((ln) => ln.length > 0)
    .join('\n');
}

function formatFeedListLabel(item: FeedItem): string {
  const px = formatPrice(item);
  const chg = formatSignedPct(item.change24hPct, item.source === 'polymarket' ? 'c' : '%');
  if (item.source === 'hyperliquid') {
    const coin = item.symbol.replace('-PERP', '').padEnd(4, ' ');
    return clipAscii(`HL ${coin} ${px} ${chg}`, 42);
  }
  const title = clipAscii(item.shortTitle, 19);
  return clipAscii(`PM ${title} ${px}`, 42);
}

export class EvenPulseController {
  private bridge: EvenAppBridge | null = null;
  private startupCreated = false;
  private listeners = new Set<(snap: HudSnapshot) => void>();

  private connected = false;
  private deviceLabel = 'Browser Preview (No Bridge)';
  private launchSource = 'web';
  private screen: HudScreen = 'feed';
  private filter: FilterMode = 'all';
  private selectedIndex = 0;
  private detailActionIndex = 0;
  private portfolioIndex = 0;
  private alertIndex = 0;

  private allItems: FeedItem[] = [];
  private feedMap = new Map<string, FeedItem>();
  private state: PersistedState = loadLocalState();

  private banner = 'Live Polymarket + Hyperliquid | Tap to inspect & trade';
  private longPressArmed = false;
  private longPressSource = '';
  private voiceListening = false;
  private voiceTranscript = 'Say: "Long BTC 200 5x" or "Buy Yes 100"';
  private voiceRms = 0;
  private lastUpdated = 0;
  private lastError: string | null = null;
  private chartDataUrl: string | null = null;
  private candleFetched = new Set<string>();
  private renderInFlight = false;
  private pollTimer: number | null = null;

  public subscribe(fn: (snap: HudSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.getSnapshot());
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const snap = this.getSnapshot();
    for (const fn of this.listeners) fn(snap);
  }

  public getFilteredItems(): FeedItem[] {
    if (this.filter === 'all') return this.allItems;
    return this.allItems.filter((i) => i.source === this.filter);
  }

  public getSelectedItem(): FeedItem | null {
    const list = this.getFilteredItems();
    if (!list.length) return null;
    const idx = Math.max(0, Math.min(this.selectedIndex, list.length - 1));
    return list[idx] ?? null;
  }

  public getSnapshot(): HudSnapshot {
    const items = this.getFilteredItems();
    return {
      connected: this.connected,
      deviceLabel: this.deviceLabel,
      launchSource: this.launchSource,
      screen: this.screen,
      filter: this.filter,
      selectedIndex: Math.min(this.selectedIndex, Math.max(0, items.length - 1)),
      selectedItem: this.getSelectedItem(),
      detailActionIndex: this.detailActionIndex,
      portfolioIndex: this.portfolioIndex,
      alertIndex: this.alertIndex,
      items,
      state: this.state,
      banner: this.banner,
      longPressArmed: this.longPressArmed,
      voiceListening: this.voiceListening,
      voiceTranscript: this.voiceTranscript,
      voiceRms: this.voiceRms,
      lastUpdated: this.lastUpdated,
      lastError: this.lastError,
      chartDataUrl: this.chartDataUrl,
    };
  }

  public async boot(): Promise<void> {
    // Attempt native Even App / EvenHub Simulator bridge with fast timeout fallback
    await this.initBridgeWithTimeout(2200);

    // Load persisted paper portfolio from Even App storage if available
    if (this.bridge) {
      try {
        const stored = await this.bridge.getLocalStorage(STORAGE_BRIDGE_KEY);
        const parsed = deserializeState(stored);
        if (parsed) this.state = parsed;
      } catch {
        // Fallback to localStorage state already loaded
      }
    }

    // Render immediate splash/loading layout on glasses so startup container exists early
    await this.refreshData(true);

    // Periodic 15s live market refresh
    this.pollTimer = window.setInterval(() => {
      void this.refreshData(false);
    }, 15_000);
  }

  public destroy(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async initBridgeWithTimeout(timeoutMs: number): Promise<void> {
    const hasNativeHost =
      typeof (window as any).flutter_inappwebview !== 'undefined' ||
      typeof (window as any).evenAppBridge !== 'undefined';

    try {
      const bridge = await Promise.race<EvenAppBridge | null>([
        waitForEvenAppBridge(),
        new Promise<null>((resolve) =>
          window.setTimeout(() => resolve(null), hasNativeHost ? 5000 : timeoutMs)
        ),
      ]);

      if (!bridge) {
        this.connected = false;
        this.deviceLabel = 'Web Preview (Even G2 576x288 Mirror)';
        this.emit();
        return;
      }

      this.bridge = bridge;
      this.connected = true;
      this.deviceLabel = 'Even G2 Connected';

      bridge.onLaunchSource((src) => {
        this.launchSource = src;
        this.emit();
      });

      bridge.onDeviceStatusChanged((st) => {
        const bat = typeof st.batteryLevel === 'number' ? ` ${st.batteryLevel}%` : '';
        this.deviceLabel = `Even G2 (${st.connectType}${bat})`;
        this.emit();
      });

      bridge.onEvenHubEvent((ev) => {
        void this.handleEvenHubEvent(ev);
      });

      try {
        const dev = await bridge.getDeviceInfo();
        if (dev) {
          const bat = dev.status?.batteryLevel != null ? ` ${dev.status.batteryLevel}%` : '';
          this.deviceLabel = `Even ${String(dev.model || 'g2').toUpperCase()}${bat}`;
        }
      } catch {
        // Simulator hardcodes or skips deviceInfo safely
      }
      this.emit();
    } catch {
      this.connected = false;
      this.deviceLabel = 'Web Preview (Even G2 576x288 Mirror)';
      this.emit();
    }
  }

  private async persist(): Promise<void> {
    saveLocalState(this.state);
    if (this.bridge) {
      try {
        await this.bridge.setLocalStorage(STORAGE_BRIDGE_KEY, serializeState(this.state));
      } catch {
        // Ignore bridge storage failure
      }
    }
  }

  public async refreshData(forceRebuild: boolean): Promise<void> {
    try {
      const [hlRes, pmRes] = await Promise.allSettled([
        fetchHyperliquidFeed(this.state.executionMode),
        fetchPolymarketFeed(),
      ]);

      const hlItems = hlRes.status === 'fulfilled' ? hlRes.value : [];
      const pmItems = pmRes.status === 'fulfilled' ? pmRes.value : [];

      if (!hlItems.length && !pmItems.length) {
        this.lastError = 'Network feed offline — retrying...';
      } else {
        this.lastError = null;
        // Interleave HL and PM so the very first glance shows BOTH ecosystems
        const merged: FeedItem[] = [];
        const maxLen = Math.max(hlItems.length, pmItems.length);
        for (let i = 0; i < maxLen; i++) {
          if (hlItems[i]) merged.push(hlItems[i]);
          if (pmItems[i]) merged.push(pmItems[i]);
        }

        // Preserve previously fetched high-res candle series
        for (const item of merged) {
          const prev = this.feedMap.get(item.id);
          if (prev && prev.series.length >= 12 && this.candleFetched.has(item.id)) {
            item.series = [...prev.series.slice(0, -1), item.price];
          }
          this.feedMap.set(item.id, item);
        }
        this.allItems = merged;
        this.lastUpdated = Date.now();

        // Check smart alerts against fresh prices
        const triggered = evaluateAlerts(this.state, this.feedMap);
        if (triggered.length > 0) {
          this.banner = `ALERT HIT: ${triggered[0].symbol} ${triggered[0].direction.toUpperCase()} ${formatRawPrice(triggered[0].source, triggered[0].threshold)}`;
          await this.persist();
        }
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : 'Feed error';
    }

    // Hydrate real 24h candle/CLOB history for currently selected item
    const active = this.getSelectedItem();
    if (active && !this.candleFetched.has(active.id)) {
      void this.hydrateSeries(active);
    }

    if (forceRebuild || !this.startupCreated) {
      await this.renderHud(true);
    } else if (this.screen === 'feed' || this.screen === 'detail' || this.screen === 'portfolio') {
      await this.updateLiveTextsAndChart();
    }
    this.emit();
  }

  private async hydrateSeries(item: FeedItem): Promise<void> {
    this.candleFetched.add(item.id);
    let pts: number[] | null = null;
    if (item.source === 'hyperliquid') {
      const coin = item.symbol.replace('-PERP', '');
      pts = await fetchHyperliquidCandles(coin, this.state.executionMode);
    } else if (item.clobTokenId) {
      pts = await fetchPolymarketHistory(item.clobTokenId);
    }
    if (pts && pts.length >= 4) {
      item.series = pts;
      const cur = this.getSelectedItem();
      if (cur && cur.id === item.id) {
        await this.updateActiveChartOnly();
        this.emit();
      }
    }
  }

  private buildMenuObject(): MenuContainerProperty {
    return new MenuContainerProperty({
      menuItems: [
        new MenuItemProperty({ itemID: MENU_ALL, itemName: 'All Live Markets' }),
        new MenuItemProperty({ itemID: MENU_PM, itemName: 'Polymarket Odds' }),
        new MenuItemProperty({ itemID: MENU_HL, itemName: 'Hyperliquid Perps' }),
        new MenuItemProperty({ itemID: MENU_PORTFOLIO, itemName: 'Portfolio & P&L' }),
        new MenuItemProperty({ itemID: MENU_ALERTS, itemName: 'Price Alerts' }),
        new MenuItemProperty({ itemID: MENU_VOICE, itemName: 'Voice Trade HUD' }),
        new MenuItemProperty({ itemID: MENU_REFRESH, itemName: 'Refresh Live Feed' }),
        new MenuItemProperty({ itemID: MENU_FLATTEN, itemName: 'Flatten All Pos' }),
      ],
    });
  }

  private getHeaderText(): string {
    const summary = computePortfolioSummary(this.state, this.feedMap);
    const modeTag = this.state.executionMode === 'hl-testnet' ? 'TEST' : 'PAPER';
    const filterTag =
      this.screen === 'feed'
        ? this.filter === 'all'
          ? 'PM+HL'
          : this.filter === 'polymarket'
          ? 'POLY'
          : 'HYPER'
        : this.screen.toUpperCase();
    return clipAscii(
      `EVENPULSE | ${filterTag} | ${modeTag} $${summary.equityUsd.toFixed(0)} (${formatSignedUsd(summary.totalPnlUsd, 1)})`,
      48
    );
  }

  private getFeedMetricText(item: FeedItem | null): string {
    if (!item) return clipLines(['Loading live feeds', 'Polymarket + HL'], 18);
    const pos = this.state.positions.find((p) => p.itemId === item.id);
    if (item.source === 'polymarket') {
      const yesPct = (item.price * 100).toFixed(1);
      const noPct = ((1 - item.price) * 100).toFixed(1);
      const line3 = pos ? `POS ${pos.side} $${pos.marginUsd}` : `24H ${formatCompactUsd(item.volume24hUsd)}`;
      return clipLines([item.symbol, `Y:${yesPct}c N:${noPct}c`, line3], 18);
    }
    const fund = item.funding8hPct != null ? formatSignedPct(item.funding8hPct, '%') : '0%';
    const line3 = pos ? `${pos.side} ${pos.leverage}x $${pos.sizeUsd}` : `F8h ${fund}`;
    return clipLines([`${item.symbol} ${formatSignedPct(item.change24hPct)}`, `MK ${formatPrice(item)}`, line3], 18);
  }

  private getDetailActions(item: FeedItem): string[] {
    const pos = this.state.positions.find((p) => p.itemId === item.id);
    if (item.source === 'polymarket') {
      const actions = [
        `BUY YES $${this.state.defaultPmSize} Paper`,
        `BUY NO  $${this.state.defaultPmSize} Paper`,
        `BUY YES $${this.state.defaultPmSize * 2} Paper`,
      ];
      if (pos) actions.push(`CLOSE ${pos.side} Position`);
      actions.push('SET ALERT (+5c Up)');
      actions.push('SET ALERT (-5c Down)');
      actions.push('< BACK TO FEED');
      return actions;
    }
    const lev = this.state.defaultLeverage;
    const mgn = this.state.defaultHlMargin;
    const actions = [
      `LONG  $${mgn * lev} (${lev}x Paper)`,
      `SHORT $${mgn * lev} (${lev}x Paper)`,
    ];
    if (pos) actions.push(`CLOSE ${pos.side} Position`);
    actions.push('SET ALERT (+2% Up)');
    actions.push('SET ALERT (-2% Down)');
    actions.push('< BACK TO FEED');
    return actions;
  }

  private getDetailStatusText(item: FeedItem): string {
    const pos = this.state.positions.find((p) => p.itemId === item.id);
    const lines: string[] = [];
    if (item.source === 'polymarket') {
      lines.push(`YES ${(item.price * 100).toFixed(1)}c  NO ${((1 - item.price) * 100).toFixed(1)}c`);
      lines.push(`24H VOL ${formatCompactUsd(item.volume24hUsd)}`);
    } else {
      const f = item.funding8hPct != null ? formatSignedPct(item.funding8hPct, '%') : '0%';
      lines.push(`${formatPrice(item)} (${formatSignedPct(item.change24hPct)})`);
      lines.push(`8H FUND ${f}`);
    }
    if (pos) {
      const { pnlUsd, liqDistPct } = computePositionPnl(pos, item);
      const liqStr = liqDistPct != null ? ` L:${liqDistPct.toFixed(0)}%` : '';
      lines.push(`${pos.side} $${pos.sizeUsd} ${formatSignedUsd(pnlUsd, 2)}${liqStr}`);
    } else {
      lines.push('Ready: Tap to Exec');
    }
    return clipLines(lines, 22);
  }

  public async renderHud(rebuild = true): Promise<void> {
    if (this.renderInFlight) return;
    this.renderInFlight = true;
    try {
      await this.renderChartBuffer();

      if (!this.bridge) {
        this.emit();
        return;
      }

      const payload = this.buildPagePayload();
      if (!this.startupCreated) {
        const res = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(payload));
        if (res === StartUpPageCreateResult.success) {
          this.startupCreated = true;
        }
      } else if (rebuild) {
        await this.bridge.rebuildPageContainer(new RebuildPageContainer(payload));
      }

      await this.pushChartToGlasses();
    } catch (err) {
      console.error('[EvenPulse] HUD render error:', err);
    } finally {
      this.renderInFlight = false;
      this.emit();
    }
  }

  private buildPagePayload(): {
    containerTotalNum: number;
    listObject?: ListContainerProperty[];
    textObject?: TextContainerProperty[];
    imageObject?: ImageContainerProperty[];
    menuObject?: MenuContainerProperty;
  } {
    const menuObject = this.buildMenuObject();

    if (this.screen === 'feed') {
      const items = this.getFilteredItems();
      const labels = items.length
        ? items.slice(0, 12).map(formatFeedListLabel)
        : ['Connecting Polymarket + Hyperliquid...'];
      const active = this.getSelectedItem();

      const textObject: TextContainerProperty[] = [
        new TextContainerProperty({
          containerID: 1,
          containerName: 'hdr-bar',
          xPosition: 8,
          yPosition: 2,
          width: 560,
          height: 32,
          content: this.getHeaderText(),
          textColor: 2,
          isEventCapture: 0,
          zOrderIndex: 1,
        }),
        new TextContainerProperty({
          containerID: 4,
          containerName: 'feed-metric',
          xPosition: 352,
          yPosition: 158,
          width: 216,
          height: 94,
          borderWidth: 1,
          borderColor: 5,
          borderRadius: 4,
          paddingLength: 6,
          content: this.getFeedMetricText(active),
          textColor: 4,
          isEventCapture: 0,
          zOrderIndex: 4,
        }),
        new TextContainerProperty({
          containerID: 5,
          containerName: 'ftr-bar',
          xPosition: 8,
          yPosition: 256,
          width: 560,
          height: 32,
          content: clipAscii(this.longPressArmed ? `ARMED (${this.longPressSource}) RELEASE TO EXEC` : this.banner, 52),
          textColor: this.longPressArmed ? 4 : 1,
          isEventCapture: 0,
          zOrderIndex: 5,
        }),
      ];

      const listObject: ListContainerProperty[] = [
        new ListContainerProperty({
          containerID: 2,
          containerName: 'list-feed',
          xPosition: 8,
          yPosition: 34,
          width: 336,
          height: 218,
          borderWidth: 1,
          borderColor: 3,
          borderRadius: 4,
          paddingLength: 4,
          isEventCapture: 1,
          zOrderIndex: 2,
          itemContainer: new ListItemContainerProperty({
            itemCount: labels.length,
            itemWidth: 324,
            isItemSelectBorderEn: 1,
            itemName: labels,
          }),
        }),
      ];

      const imageObject: ImageContainerProperty[] = [
        new ImageContainerProperty({
          containerID: 3,
          containerName: 'img-chart',
          xPosition: 352,
          yPosition: 34,
          width: 216,
          height: 118,
          zOrderIndex: 3,
        }),
      ];

      return {
        containerTotalNum: 5,
        listObject,
        textObject,
        imageObject,
        menuObject,
      };
    }

    if (this.screen === 'detail') {
      const item = this.getSelectedItem() || this.allItems[0];
      const actions = item ? this.getDetailActions(item) : ['< BACK TO FEED'];
      const titleLine = item
        ? clipAscii(`${item.symbol} | ${item.shortTitle}`, 44)
        : 'MARKET DETAIL';

      return {
        containerTotalNum: 5,
        textObject: [
          new TextContainerProperty({
            containerID: 1,
            containerName: 'hdr-bar',
            xPosition: 8,
            yPosition: 2,
            width: 560,
            height: 32,
            content: titleLine,
            textColor: 4,
            isEventCapture: 0,
            zOrderIndex: 1,
          }),
          new TextContainerProperty({
            containerID: 4,
            containerName: 'detail-pos',
            xPosition: 8,
            yPosition: 166,
            width: 264,
            height: 88,
            borderWidth: 1,
            borderColor: 5,
            borderRadius: 4,
            paddingLength: 6,
            content: item ? this.getDetailStatusText(item) : '',
            textColor: 3,
            isEventCapture: 0,
            zOrderIndex: 4,
          }),
          new TextContainerProperty({
            containerID: 5,
            containerName: 'ftr-bar',
            xPosition: 8,
            yPosition: 256,
            width: 560,
            height: 32,
            content: clipAscii('TAP Exec Paper | DBL Back | MENU More', 52),
            textColor: 1,
            isEventCapture: 0,
            zOrderIndex: 5,
          }),
        ],
        imageObject: [
          new ImageContainerProperty({
            containerID: 3,
            containerName: 'img-chart',
            xPosition: 8,
            yPosition: 36,
            width: 264,
            height: 126,
            zOrderIndex: 2,
          }),
        ],
        listObject: [
          new ListContainerProperty({
            containerID: 2,
            containerName: 'list-actions',
            xPosition: 280,
            yPosition: 36,
            width: 288,
            height: 216,
            borderWidth: 1,
            borderColor: 6,
            borderRadius: 4,
            paddingLength: 4,
            isEventCapture: 1,
            zOrderIndex: 3,
            itemContainer: new ListItemContainerProperty({
              itemCount: actions.length,
              itemWidth: 276,
              isItemSelectBorderEn: 1,
              itemName: actions.map((a) => clipAscii(a, 44)),
            }),
          }),
        ],
        menuObject,
      };
    }

    if (this.screen === 'portfolio') {
      const rows = this.state.positions.map((pos) => {
        const { pnlUsd, liqDistPct } = computePositionPnl(pos, this.feedMap.get(pos.itemId));
        const liq = liqDistPct != null ? ` L:${liqDistPct.toFixed(0)}%` : '';
        return clipAscii(`${pos.side} ${pos.symbol} $${pos.sizeUsd} ${formatSignedUsd(pnlUsd, 1)}${liq}`, 44);
      });
      if (!rows.length) rows.push('No open positions (Tap to return)');
      else rows.push('FLATTEN ALL POSITIONS');
      rows.push('< BACK TO FEED');

      const latest = this.state.receipts[0];
      const summary = computePortfolioSummary(this.state, this.feedMap);
      const statsTxt = clipLines(
        [
          `REAL ${formatSignedUsd(this.state.realizedPnlUsd, 2)}`,
          `OPEN POS: ${this.state.positions.length}`,
          latest ? latest.summary : 'Desk Ready',
        ],
        18
      );

      return {
        containerTotalNum: 5,
        textObject: [
          new TextContainerProperty({
            containerID: 1,
            containerName: 'hdr-bar',
            xPosition: 8,
            yPosition: 2,
            width: 560,
            height: 32,
            content: this.getHeaderText(),
            textColor: 3,
            isEventCapture: 0,
            zOrderIndex: 1,
          }),
          new TextContainerProperty({
            containerID: 4,
            containerName: 'port-stats',
            xPosition: 344,
            yPosition: 158,
            width: 224,
            height: 94,
            borderWidth: 1,
            borderColor: 5,
            borderRadius: 4,
            paddingLength: 6,
            content: statsTxt,
            textColor: 3,
            isEventCapture: 0,
            zOrderIndex: 4,
          }),
          new TextContainerProperty({
            containerID: 5,
            containerName: 'ftr-bar',
            xPosition: 8,
            yPosition: 256,
            width: 560,
            height: 32,
            content: clipAscii(
              `TAP Close | Cash $${this.state.cashUsd.toFixed(0)} | Eq $${summary.equityUsd.toFixed(0)}`,
              52
            ),
            textColor: 1,
            isEventCapture: 0,
            zOrderIndex: 5,
          }),
        ],
        listObject: [
          new ListContainerProperty({
            containerID: 2,
            containerName: 'list-portfolio',
            xPosition: 8,
            yPosition: 34,
            width: 328,
            height: 218,
            borderWidth: 1,
            borderColor: 4,
            borderRadius: 4,
            paddingLength: 4,
            isEventCapture: 1,
            zOrderIndex: 2,
            itemContainer: new ListItemContainerProperty({
              itemCount: rows.length,
              itemWidth: 316,
              isItemSelectBorderEn: 1,
              itemName: rows,
            }),
          }),
        ],
        imageObject: [
          new ImageContainerProperty({
            containerID: 3,
            containerName: 'img-chart',
            xPosition: 344,
            yPosition: 34,
            width: 224,
            height: 118,
            zOrderIndex: 3,
          }),
        ],
        menuObject,
      };
    }

    if (this.screen === 'alerts') {
      const rows = this.state.alerts.slice(0, 10).map((a) => {
        const tag = a.triggered ? '[HIT]' : '[ARM]';
        return clipAscii(
          `${tag} ${a.symbol} ${a.direction.toUpperCase()} ${formatRawPrice(a.source, a.threshold)}`,
          48
        );
      });
      if (!rows.length) rows.push('No alerts yet — open a market to set one');
      rows.push('CLEAR TRIGGERED ALERTS');
      rows.push('< BACK TO FEED');

      return {
        containerTotalNum: 3,
        textObject: [
          new TextContainerProperty({
            containerID: 1,
            containerName: 'hdr-bar',
            xPosition: 8,
            yPosition: 4,
            width: 560,
            height: 26,
            content: clipAscii(`EVENPULSE ALERTS (${this.state.alerts.length} ACTIVE)`, 78),
            textColor: 4,
            isEventCapture: 0,
            zOrderIndex: 1,
          }),
          new TextContainerProperty({
            containerID: 5,
            containerName: 'ftr-bar',
            xPosition: 8,
            yPosition: 258,
            width: 560,
            height: 26,
            content: clipAscii('TAP Alert to Inspect Market  |  DBL Back to Live Feed', 78),
            textColor: 1,
            isEventCapture: 0,
            zOrderIndex: 3,
          }),
        ],
        listObject: [
          new ListContainerProperty({
            containerID: 2,
            containerName: 'list-alerts',
            xPosition: 8,
            yPosition: 36,
            width: 560,
            height: 216,
            borderWidth: 1,
            borderColor: 5,
            borderRadius: 4,
            paddingLength: 6,
            isEventCapture: 1,
            zOrderIndex: 2,
            itemContainer: new ListItemContainerProperty({
              itemCount: rows.length,
              itemWidth: 544,
              isItemSelectBorderEn: 1,
              itemName: rows,
            }),
          }),
        ],
        menuObject,
      };
    }

    // Voice Trade HUD screen
    const micBar = '#'.repeat(Math.min(18, Math.round(this.voiceRms * 18))).padEnd(18, '-');
    const voiceActions = [
      'MIC: Toggle Glasses Voice Listen',
      'QUICK VOICE: "Long BTC 100 5x"',
      'QUICK VOICE: "Buy Yes 100"',
      'QUICK VOICE: "Short ETH 100 5x"',
      'QUICK VOICE: "Close All"',
      '< BACK TO FEED',
    ];
    return {
      containerTotalNum: 4,
      textObject: [
        new TextContainerProperty({
          containerID: 1,
          containerName: 'hdr-bar',
          xPosition: 8,
          yPosition: 4,
          width: 560,
          height: 26,
          content: clipAscii(
            `VOICE TRADE HUD  |  MIC: ${this.voiceListening ? 'LIVE' : 'STANDBY'}  [${micBar}]`,
            78
          ),
          textColor: 4,
          isEventCapture: 0,
          zOrderIndex: 1,
        }),
        new TextContainerProperty({
          containerID: 4,
          containerName: 'voice-transcript',
          xPosition: 8,
          yPosition: 36,
          width: 560,
          height: 54,
          borderWidth: 1,
          borderColor: 6,
          borderRadius: 4,
          paddingLength: 6,
          content: clipAscii(this.voiceTranscript, 160),
          textColor: 4,
          isEventCapture: 0,
          zOrderIndex: 2,
        }),
        new TextContainerProperty({
          containerID: 5,
          containerName: 'ftr-bar',
          xPosition: 8,
          yPosition: 258,
          width: 560,
          height: 26,
          content: clipAscii('TAP Preset or Glasses MIC  |  DBL Back to Live Feed', 78),
          textColor: 1,
          isEventCapture: 0,
          zOrderIndex: 4,
        }),
      ],
      listObject: [
        new ListContainerProperty({
          containerID: 2,
          containerName: 'list-voice',
          xPosition: 8,
          yPosition: 96,
          width: 560,
          height: 156,
          borderWidth: 1,
          borderColor: 4,
          borderRadius: 4,
          paddingLength: 4,
          isEventCapture: 1,
          zOrderIndex: 3,
          itemContainer: new ListItemContainerProperty({
            itemCount: voiceActions.length,
            itemWidth: 544,
            isItemSelectBorderEn: 1,
            itemName: voiceActions,
          }),
        }),
      ],
      menuObject,
    };
  }

  private lastPngBytes: number[] | null = null;

  private async renderChartBuffer(): Promise<void> {
    if (this.screen === 'feed') {
      const item = this.getSelectedItem();
      if (!item) return;
      const pos = this.state.positions.find((p) => p.itemId === item.id);
      this.lastPngBytes = await renderSparklinePng(item, 216, 118, pos);
      this.chartDataUrl = bytesToPngDataUrl(this.lastPngBytes);
    } else if (this.screen === 'detail') {
      const item = this.getSelectedItem() || this.allItems[0];
      if (!item) return;
      const pos = this.state.positions.find((p) => p.itemId === item.id);
      this.lastPngBytes = await renderSparklinePng(item, 264, 126, pos);
      this.chartDataUrl = bytesToPngDataUrl(this.lastPngBytes);
    } else if (this.screen === 'portfolio') {
      const summary = computePortfolioSummary(this.state, this.feedMap);
      this.lastPngBytes = await renderPortfolioChartPng(
        summary.equityUsd,
        summary.unrealizedPnlUsd,
        this.state.cashUsd,
        summary.marginUsedUsd,
        224,
        118
      );
      this.chartDataUrl = bytesToPngDataUrl(this.lastPngBytes);
    }
  }

  private async pushChartToGlasses(): Promise<void> {
    if (!this.bridge || !this.lastPngBytes) return;
    if (this.screen !== 'feed' && this.screen !== 'detail' && this.screen !== 'portfolio') return;
    await this.bridge.updateImageRawData(
      new ImageRawDataUpdate({
        containerID: 3,
        containerName: 'img-chart',
        imageData: this.lastPngBytes,
      })
    );
  }

  private async updateActiveChartOnly(): Promise<void> {
    await this.renderChartBuffer();
    await this.pushChartToGlasses();
  }

  private async updateLiveTextsAndChart(): Promise<void> {
    await this.renderChartBuffer();
    if (!this.bridge || !this.startupCreated) {
      this.emit();
      return;
    }
    try {
      await this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: 1,
          containerName: 'hdr-bar',
          content: this.getHeaderText(),
        })
      );
      if (this.screen === 'feed') {
        await this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: 4,
            containerName: 'feed-metric',
            content: this.getFeedMetricText(this.getSelectedItem()),
          })
        );
      } else if (this.screen === 'detail') {
        const item = this.getSelectedItem();
        if (item) {
          await this.bridge.textContainerUpgrade(
            new TextContainerUpgrade({
              containerID: 4,
              containerName: 'detail-pos',
              content: this.getDetailStatusText(item),
            })
          );
        }
      }
      await this.pushChartToGlasses();
    } catch {
      // If incremental update fails, fall back cleanly on next user action
    }
  }

  private async handleEvenHubEvent(event: EvenHubEvent): Promise<void> {
    // 1. Contextual menu click
    if (event.menuItemClickEvent?.itemID) {
      await this.handleMenuAction(event.menuItemClickEvent.itemID);
      return;
    }

    // 2. Audio PCM frames (Glasses MIC RMS meter)
    if (event.audioEvent) {
      const pcm = event.audioEvent.audioPcm;
      if (pcm && pcm.length >= 2) {
        let sumSq = 0;
        const samples = Math.floor(pcm.length / 2);
        for (let i = 0; i < samples; i++) {
          const lo = pcm[i * 2];
          const hi = pcm[i * 2 + 1];
          let v = (hi << 8) | lo;
          if (v >= 0x8000) v -= 0x10000;
          const norm = v / 32768;
          sumSq += norm * norm;
        }
        this.voiceRms = Math.min(1, Math.sqrt(sumSq / Math.max(1, samples)) * 4);
        this.emit();
      }
      return;
    }

    // 3. System events (Long press / double click / exit)
    if (event.sysEvent) {
      const et = event.sysEvent.eventType;
      if (et === OsEventTypeList.LONG_PRESS_EVENT) {
        this.longPressArmed = true;
        this.longPressSource =
          event.sysEvent.eventSource === EventSourceType.TOUCH_EVENT_FROM_RING
            ? 'R1 RING'
            : event.sysEvent.eventSource === EventSourceType.TOUCH_EVENT_FROM_GLASSES_L
            ? 'LEFT TEMPLE'
            : 'RIGHT TEMPLE';
        await this.updateFooterOnly();
        this.emit();
        return;
      }
      if (et === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) {
        if (this.longPressArmed) {
          this.longPressArmed = false;
          await this.executeQuickHoldAction();
        }
        return;
      }
      if (et === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        await this.handleDoubleClick();
        return;
      }
    }

    // 4. List events (scroll / click / double click)
    if (event.listEvent) {
      const le = event.listEvent;
      const idx = typeof le.currentSelectItemIndex === 'number' ? le.currentSelectItemIndex : undefined;
      const et = le.eventType;

      if (et === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        await this.handleDoubleClick();
        return;
      }
      if (et === OsEventTypeList.LONG_PRESS_EVENT) {
        this.longPressArmed = true;
        this.longPressSource = 'GLASSES';
        await this.updateFooterOnly();
        this.emit();
        return;
      }
      if (et === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) {
        this.longPressArmed = false;
        await this.executeQuickHoldAction();
        return;
      }

      if (et === OsEventTypeList.SCROLL_TOP_EVENT || et === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
        if (idx !== undefined) {
          await this.onSelectionIndexChanged(idx);
        } else {
          await this.stepSelection(et === OsEventTypeList.SCROLL_BOTTOM_EVENT ? 1 : -1);
        }
        return;
      }

      // Click event (protobuf3 omits default 0 fields, so undefined index on click === item 0!)
      if (et === OsEventTypeList.CLICK_EVENT || et === undefined) {
        this.setCurrentScreenIndex(idx ?? 0);
        await this.handlePrimaryClick();
      }
    }
  }

  private setCurrentScreenIndex(idx: number): void {
    if (this.screen === 'feed') this.selectedIndex = idx;
    else if (this.screen === 'detail' || this.screen === 'voice') this.detailActionIndex = idx;
    else if (this.screen === 'portfolio') this.portfolioIndex = idx;
    else if (this.screen === 'alerts') this.alertIndex = idx;
  }

  private async onSelectionIndexChanged(idx: number): Promise<void> {
    this.setCurrentScreenIndex(idx);
    if (this.screen === 'feed') {
      const active = this.getSelectedItem();
      if (active && !this.candleFetched.has(active.id)) {
        void this.hydrateSeries(active);
      }
      await this.updateLiveTextsAndChart();
    }
    this.emit();
  }

  private async updateFooterOnly(): Promise<void> {
    if (!this.bridge || !this.startupCreated) return;
    try {
      await this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: 5,
          containerName: 'ftr-bar',
          content: clipAscii(
            this.longPressArmed ? `ARMED (${this.longPressSource}) — RELEASE FOR QUICK ORDER` : this.banner,
            78
          ),
          textColor: this.longPressArmed ? 4 : 1,
        })
      );
    } catch {
      // Ignore
    }
  }

  public async stepSelection(delta: number): Promise<void> {
    if (this.screen === 'feed') {
      const len = Math.max(1, this.getFilteredItems().length);
      this.selectedIndex = (this.selectedIndex + delta + len) % len;
      const active = this.getSelectedItem();
      if (active && !this.candleFetched.has(active.id)) void this.hydrateSeries(active);
      await this.updateLiveTextsAndChart();
    } else if (this.screen === 'detail') {
      const item = this.getSelectedItem();
      const len = item ? this.getDetailActions(item).length : 1;
      this.detailActionIndex = (this.detailActionIndex + delta + len) % len;
    } else if (this.screen === 'portfolio') {
      const len = Math.max(2, this.state.positions.length + 2);
      this.portfolioIndex = (this.portfolioIndex + delta + len) % len;
    } else if (this.screen === 'alerts') {
      const len = Math.max(2, this.state.alerts.length + 2);
      this.alertIndex = (this.alertIndex + delta + len) % len;
    }
    this.emit();
  }

  public async handleDoubleClick(): Promise<void> {
    if (this.screen === 'feed') {
      this.screen = 'portfolio';
      this.portfolioIndex = 0;
    } else {
      this.screen = 'feed';
    }
    await this.renderHud(true);
  }

  public async handlePrimaryClick(): Promise<void> {
    if (this.screen === 'feed') {
      if (!this.getSelectedItem()) return;
      this.screen = 'detail';
      this.detailActionIndex = 0;
      await this.renderHud(true);
      return;
    }

    if (this.screen === 'detail') {
      const item = this.getSelectedItem();
      if (!item) {
        this.screen = 'feed';
        await this.renderHud(true);
        return;
      }
      const actions = this.getDetailActions(item);
      const chosen = actions[this.detailActionIndex] || actions[0];
      await this.runDetailAction(item, chosen);
      return;
    }

    if (this.screen === 'portfolio') {
      const posCount = this.state.positions.length;
      if (posCount === 0) {
        this.screen = 'feed';
        await this.renderHud(true);
        return;
      }
      if (this.portfolioIndex < posCount) {
        const pos = this.state.positions[this.portfolioIndex];
        const receipt = closePosition(this.state, pos.id, this.feedMap);
        if (receipt) this.banner = `${receipt.summary}: ${receipt.detail}`;
        this.portfolioIndex = 0;
        await this.persist();
        await this.renderHud(true);
        return;
      }
      if (this.portfolioIndex === posCount) {
        const receipt = flattenAllPositions(this.state, this.feedMap);
        this.banner = `${receipt.summary}: ${receipt.detail}`;
        await this.persist();
        await this.renderHud(true);
        return;
      }
      this.screen = 'feed';
      await this.renderHud(true);
      return;
    }

    if (this.screen === 'alerts') {
      const activeCount = this.state.alerts.length;
      if (activeCount > 0 && this.alertIndex < activeCount) {
        const a = this.state.alerts[this.alertIndex];
        const idx = this.getFilteredItems().findIndex((x) => x.id === a.itemId);
        if (idx !== -1) {
          this.selectedIndex = idx;
          this.screen = 'detail';
          this.detailActionIndex = 0;
          await this.renderHud(true);
          return;
        }
      }
      if (this.alertIndex === Math.max(1, activeCount)) {
        this.state.alerts = this.state.alerts.filter((a) => !a.triggered);
        this.banner = 'Cleared triggered alerts';
        await this.persist();
        await this.renderHud(true);
        return;
      }
      this.screen = 'feed';
      await this.renderHud(true);
      return;
    }

    if (this.screen === 'voice') {
      const idx = this.detailActionIndex;
      if (idx === 0) {
        await this.toggleVoiceMic();
      } else if (idx === 1) {
        await this.executeVoiceTranscript('Long BTC 100 5x');
      } else if (idx === 2) {
        await this.executeVoiceTranscript('Buy Yes 100');
      } else if (idx === 3) {
        await this.executeVoiceTranscript('Short ETH 100 5x');
      } else if (idx === 4) {
        await this.executeVoiceTranscript('Close all');
      } else {
        this.screen = 'feed';
        await this.renderHud(true);
      }
    }
  }

  private async runDetailAction(item: FeedItem, label: string): Promise<void> {
    if (label.startsWith('< BACK')) {
      this.screen = 'feed';
      await this.renderHud(true);
      return;
    }
    if (label.startsWith('CLOSE')) {
      const pos = this.state.positions.find((p) => p.itemId === item.id);
      if (pos) {
        const rec = closePosition(this.state, pos.id, this.feedMap);
        if (rec) this.banner = `${rec.summary} (${rec.detail})`;
      }
    } else if (label.includes('ALERT') && label.includes('Up')) {
      const alt = addSmartAlert(this.state, item, 'above');
      this.banner = `Alert set: ${alt.symbol} > ${formatRawPrice(alt.source, alt.threshold)}`;
    } else if (label.includes('ALERT') && label.includes('Down')) {
      const alt = addSmartAlert(this.state, item, 'below');
      this.banner = `Alert set: ${alt.symbol} < ${formatRawPrice(alt.source, alt.threshold)}`;
    } else if (label.startsWith('BUY YES')) {
      const amt = label.includes(`$${this.state.defaultPmSize * 2}`)
        ? this.state.defaultPmSize * 2
        : this.state.defaultPmSize;
      const { receipt } = executePaperOrder(this.state, item, 'YES', amt, 1);
      this.banner = `${receipt.summary}: ${receipt.detail}`;
    } else if (label.startsWith('BUY NO')) {
      const { receipt } = executePaperOrder(this.state, item, 'NO', this.state.defaultPmSize, 1);
      this.banner = `${receipt.summary}: ${receipt.detail}`;
    } else if (label.startsWith('LONG')) {
      const { receipt } = executePaperOrder(
        this.state,
        item,
        'LONG',
        this.state.defaultHlMargin,
        this.state.defaultLeverage
      );
      this.banner = `${receipt.summary}: ${receipt.detail}`;
    } else if (label.startsWith('SHORT')) {
      const { receipt } = executePaperOrder(
        this.state,
        item,
        'SHORT',
        this.state.defaultHlMargin,
        this.state.defaultLeverage
      );
      this.banner = `${receipt.summary}: ${receipt.detail}`;
    }

    await this.persist();
    await this.renderHud(true);
  }

  public async executeQuickHoldAction(): Promise<void> {
    const item = this.getSelectedItem();
    if (!item) return;
    let receipt: TradeReceipt;
    if (item.source === 'polymarket') {
      receipt = executePaperOrder(this.state, item, 'YES', this.state.defaultPmSize, 1).receipt;
    } else {
      receipt = executePaperOrder(
        this.state,
        item,
        'LONG',
        this.state.defaultHlMargin,
        this.state.defaultLeverage
      ).receipt;
    }
    this.banner = `HOLD EXEC: ${receipt.summary} | ${receipt.detail}`;
    await this.persist();
    await this.renderHud(true);
  }

  public async handleMenuAction(itemID: number): Promise<void> {
    if (itemID === MENU_ALL) {
      this.filter = 'all';
      this.selectedIndex = 0;
      this.screen = 'feed';
      this.banner = 'Filter: All Live (Polymarket + Hyperliquid)';
    } else if (itemID === MENU_PM) {
      this.filter = 'polymarket';
      this.selectedIndex = 0;
      this.screen = 'feed';
      this.banner = 'Filter: Polymarket Live Prediction Odds';
    } else if (itemID === MENU_HL) {
      this.filter = 'hyperliquid';
      this.selectedIndex = 0;
      this.screen = 'feed';
      this.banner = 'Filter: Hyperliquid Live Perps';
    } else if (itemID === MENU_PORTFOLIO) {
      this.screen = 'portfolio';
      this.portfolioIndex = 0;
    } else if (itemID === MENU_ALERTS) {
      this.screen = 'alerts';
      this.alertIndex = 0;
    } else if (itemID === MENU_VOICE) {
      this.screen = 'voice';
      this.detailActionIndex = 0;
    } else if (itemID === MENU_REFRESH) {
      this.banner = 'Refreshing live Polymarket + Hyperliquid feeds...';
      await this.refreshData(true);
      return;
    } else if (itemID === MENU_FLATTEN) {
      const rec = flattenAllPositions(this.state, this.feedMap);
      this.banner = `${rec.summary}: ${rec.detail}`;
      await this.persist();
    }
    await this.renderHud(true);
  }

  public async toggleVoiceMic(): Promise<void> {
    this.voiceListening = !this.voiceListening;
    if (this.bridge) {
      try {
        await this.bridge.audioControl(this.voiceListening, AudioInputSource.Glasses);
      } catch {
        // Fallback if simulator has no mic device selected
      }
    }
    this.voiceTranscript = this.voiceListening
      ? 'Listening via Even G2 MIC... say "Long BTC 200 5x" or "Buy Yes 100"'
      : 'MIC standby. Tap a preset or speak in companion bar.';
    await this.renderHud(true);
  }

  public async executeVoiceTranscript(raw: string): Promise<void> {
    const intent = parseVoiceCommand(raw, this.getSelectedItem() || undefined);
    this.voiceTranscript = `"${raw}" -> ${intent.summary}`;

    const findTarget = (wantSource?: 'polymarket' | 'hyperliquid'): FeedItem | undefined => {
      if (intent.symbolHint) {
        const hint = intent.symbolHint.toUpperCase();
        const match = this.allItems.find(
          (x) =>
            (!wantSource || x.source === wantSource) &&
            (x.symbol.toUpperCase().includes(hint) || x.fullTitle.toUpperCase().includes(hint))
        );
        if (match) return match;
      }
      const sel = this.getSelectedItem();
      if (sel && (!wantSource || sel.source === wantSource)) return sel;
      return this.allItems.find((x) => !wantSource || x.source === wantSource);
    };

    if (intent.action === 'close_all') {
      const rec = flattenAllPositions(this.state, this.feedMap);
      this.banner = `VOICE: ${rec.summary}`;
    } else if (intent.action === 'portfolio') {
      this.screen = 'portfolio';
    } else if (intent.action === 'feed') {
      this.screen = 'feed';
    } else if (intent.action === 'close') {
      const pos = this.state.positions.find(
        (p) => !intent.symbolHint || p.symbol.toUpperCase().includes(intent.symbolHint.toUpperCase())
      );
      if (pos) {
        const rec = closePosition(this.state, pos.id, this.feedMap);
        if (rec) this.banner = `VOICE: ${rec.summary}`;
      } else {
        this.banner = 'VOICE: No matching open position';
      }
    } else if (intent.action === 'alert') {
      const target = findTarget();
      if (target) {
        const alt = addSmartAlert(this.state, target, 'above');
        this.banner = `VOICE ALERT: ${alt.symbol} > ${formatRawPrice(alt.source, alt.threshold)}`;
      }
    } else if (intent.action === 'buy_yes' || intent.action === 'buy_no') {
      const target = findTarget('polymarket');
      if (target) {
        const { receipt } = executePaperOrder(
          this.state,
          target,
          intent.action === 'buy_yes' ? 'YES' : 'NO',
          intent.amountUsd ?? this.state.defaultPmSize,
          1
        );
        this.banner = `VOICE: ${receipt.summary}`;
      }
    } else if (intent.action === 'long' || intent.action === 'short') {
      const target = findTarget('hyperliquid');
      if (target) {
        const { receipt } = executePaperOrder(
          this.state,
          target,
          intent.action === 'long' ? 'LONG' : 'SHORT',
          intent.amountUsd ?? this.state.defaultHlMargin,
          intent.leverage ?? this.state.defaultLeverage
        );
        this.banner = `VOICE: ${receipt.summary}`;
      }
    }

    await this.persist();
    await this.renderHud(true);
  }

  public async setScreen(screen: HudScreen): Promise<void> {
    this.screen = screen;
    await this.renderHud(true);
  }

  public async selectFeedIndex(idx: number, openDetail = false): Promise<void> {
    this.screen = 'feed';
    this.selectedIndex = idx;
    const active = this.getSelectedItem();
    if (active && !this.candleFetched.has(active.id)) void this.hydrateSeries(active);
    if (openDetail) {
      this.screen = 'detail';
      this.detailActionIndex = 0;
      await this.renderHud(true);
    } else {
      await this.updateLiveTextsAndChart();
      this.emit();
    }
  }

  public async setExecutionMode(mode: ExecutionMode): Promise<void> {
    this.state.executionMode = mode;
    this.candleFetched.clear();
    this.banner =
      mode === 'hl-testnet'
        ? 'Switched Hyperliquid feed to Official Testnet'
        : 'Switched to Mainnet Read-Only + Paper Execution';
    await this.persist();
    await this.refreshData(true);
  }

  public async updateRiskDefaults(pmSize: number, hlMargin: number, leverage: number): Promise<void> {
    this.state.defaultPmSize = pmSize;
    this.state.defaultHlMargin = hlMargin;
    this.state.defaultLeverage = leverage;
    await this.persist();
    await this.renderHud(true);
  }

  public async resetPaperDesk(): Promise<void> {
    this.state.cashUsd = 10_000;
    this.state.realizedPnlUsd = 0;
    this.state.positions = [];
    this.state.alerts = [];
    this.state.receipts = [
      {
        id: `rst-${Date.now()}`,
        timestamp: Date.now(),
        summary: 'PAPER DESK RESET',
        detail: 'Restored $10,000.00 paper equity.',
        kind: 'info',
      },
    ];
    this.banner = 'Paper desk reset to $10,000';
    await this.persist();
    await this.renderHud(true);
  }
}

function bytesToPngDataUrl(bytes: number[]): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:image/png;base64,${btoa(bin)}`;
}
