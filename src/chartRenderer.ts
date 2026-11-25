import type { FeedItem, PaperPosition } from './types';
import { formatPrice, formatRawPrice } from './markets';

/**
 * Renders a high-contrast 4-bit monochrome chart into an offscreen HTMLCanvasElement
 * and returns encoded PNG bytes (`number[]`) compatible with EvenHub `updateImageRawData`.
 *
 * Firmware constraints respected:
 * - Image container width in 20..288, height in 20..144.
 * - Pure black background (0) -> transparent on waveguide; bright white/green pixels (255) -> max phosphor.
 */
export async function renderSparklinePng(
  item: FeedItem,
  width: number,
  height: number,
  position?: PaperPosition
): Promise<number[]> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // Pure black background (waveguide transparent)
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);

  // Outer hairline frame (subtle 25% brightness)
  ctx.strokeStyle = '#404040';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1);

  const series = item.series.length >= 2 ? item.series : [item.price, item.price];

  // Header strip inside image
  ctx.fillStyle = '#B8B8B8';
  ctx.font = 'bold 11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'top';
  const hdrLeft = item.source === 'polymarket' ? '24H ODDS' : '24H PERP';
  ctx.fillText(hdrLeft, 6, 5);

  const hdrRight = formatPrice(item);
  const wRight = ctx.measureText(hdrRight).width;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(hdrRight, width - wRight - 6, 5);

  // Subtle horizontal divider under header
  ctx.strokeStyle = '#383838';
  ctx.beginPath();
  ctx.moveTo(4, 20.5);
  ctx.lineTo(width - 4, 20.5);
  ctx.stroke();

  if (item.source === 'polymarket') {
    // Draw YES/NO probability bar at bottom + 24h odds sparkline above
    const chartTop = 26;
    const chartBottom = height - 34;
    drawSeries(ctx, series, 8, chartTop, width - 16, chartBottom - chartTop, 0.5);

    // Probability split bar
    const barX = 8;
    const barY = height - 25;
    const barW = width - 16;
    const barH = 10;
    const yesW = Math.max(2, Math.min(barW - 2, Math.round(barW * item.price)));

    ctx.fillStyle = '#2A2A2A';
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(barX, barY, yesW, barH);

    // Tick at 50%
    ctx.fillStyle = '#000000';
    ctx.fillRect(barX + Math.floor(barW / 2), barY, 1, barH);

    // YES / NO labels below bar (always sum to 100%)
    const yesPctInt = Math.round(item.price * 100);
    const noPctInt = 100 - yesPctInt;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(`YES ${yesPctInt}%`, barX, height - 13);
    const noStr = `NO ${noPctInt}%`;
    ctx.fillStyle = '#909090';
    ctx.fillText(noStr, width - barX - ctx.measureText(noStr).width, height - 13);
  } else {
    // Hyperliquid 24h candle close sparkline + high/low bounds + entry line
    const chartTop = 26;
    const chartBottom = height - 18;
    const minVal = Math.min(...series);
    const maxVal = Math.max(...series);
    const refLine = position ? position.entryPrice : series[0];
    drawSeries(ctx, series, 8, chartTop, width - 16, chartBottom - chartTop, refLine);

    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = '#888888';
    ctx.fillText(`L ${formatRawPrice('hyperliquid', minVal)}`, 6, height - 13);
    const hiStr = `H ${formatRawPrice('hyperliquid', maxVal)}`;
    ctx.fillText(hiStr, width - 6 - ctx.measureText(hiStr).width, height - 13);
  }

  return canvasToPngBytes(canvas);
}

function drawSeries(
  ctx: CanvasRenderingContext2D,
  series: number[],
  x: number,
  y: number,
  w: number,
  h: number,
  refValue: number
): void {
  let min = Math.min(...series, refValue);
  let max = Math.max(...series, refValue);
  if (Math.abs(max - min) < 1e-9) {
    min -= 0.01;
    max += 0.01;
  }
  const pad = (max - min) * 0.12;
  min -= pad;
  max += pad;

  const toX = (i: number) => x + (i / Math.max(1, series.length - 1)) * w;
  const toY = (v: number) => y + h - ((v - min) / (max - min)) * h;

  // Dotted reference line (entry price or 50% midpoint)
  const ry = Math.round(toY(refValue)) + 0.5;
  if (ry >= y && ry <= y + h) {
    ctx.save();
    ctx.strokeStyle = '#555555';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, ry);
    ctx.lineTo(x + w, ry);
    ctx.stroke();
    ctx.restore();
  }

  // Subtle dithered/shaded fill under curve
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(toX(0), y + h);
  for (let i = 0; i < series.length; i++) {
    ctx.lineTo(toX(i), toY(series[i]));
  }
  ctx.lineTo(toX(series.length - 1), y + h);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.30)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0.02)');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();

  // Crisp bright polyline
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < series.length; i++) {
    const px = toX(i);
    const py = toY(series[i]);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Live endpoint dot
  const lx = toX(series.length - 1);
  const ly = toY(series[series.length - 1]);
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(lx, ly, 3, 0, Math.PI * 2);
  ctx.fill();
}

export async function renderPortfolioChartPng(
  equityUsd: number,
  unrealizedPnlUsd: number,
  cashUsd: number,
  marginUsedUsd: number,
  width: number,
  height: number
): Promise<number[]> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#404040';
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1);

  ctx.fillStyle = '#B8B8B8';
  ctx.font = 'bold 11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'top';
  ctx.fillText('EQUITY ALLOCATION', 8, 6);

  const total = Math.max(1, cashUsd + marginUsedUsd);
  const cashFrac = Math.max(0, Math.min(1, cashUsd / total));
  const barX = 8;
  const barY = 28;
  const barW = width - 16;
  const barH = 14;

  ctx.fillStyle = '#303030';
  ctx.fillRect(barX, barY, barW, barH);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(barX, barY, Math.round(barW * (1 - cashFrac)), barH);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 16px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText(`$${equityUsd.toFixed(0)}`, 8, 52);

  const pnlStr = unrealizedPnlUsd >= 0 ? `+$${unrealizedPnlUsd.toFixed(2)}` : `-$${Math.abs(unrealizedPnlUsd).toFixed(2)}`;
  ctx.fillStyle = '#C8C8C8';
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText(`OPEN P&L ${pnlStr}`, 8, 76);
  ctx.fillStyle = '#888888';
  ctx.fillText(`CASH $${cashUsd.toFixed(0)} | IN USE $${marginUsedUsd.toFixed(0)}`, 8, 96);

  return canvasToPngBytes(canvas);
}

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<number[]> {
  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
  const buf = await blob.arrayBuffer();
  return Array.from(new Uint8Array(buf));
}
