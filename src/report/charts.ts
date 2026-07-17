import { THEME_COLORS } from "./theme.js";

export interface CurveInput {
  baselineCumulative: number[];
  effectiveCumulative: number[];
  /** Actual plotted turn numbers. Omit to retain the legacy index-based scale. */
  turnNumbers?: number[];
  longSessionThreshold: number;
  firstPruneTurn: number | null;
}

const W = 720;
const H = 320;
const PAD = 40;

function points(
  series: number[],
  xValues: number[],
  maxY: number,
  xAt: (value: number) => number,
): string {
  return series
    .map((y, i) => {
      const x = xAt(xValues[i] ?? i);
      const yy = H - PAD - (maxY === 0 ? 0 : (y / maxY) * (H - 2 * PAD));
      return `${x.toFixed(1)},${yy.toFixed(1)}`;
    })
    .join(" ");
}

export function renderCurveSvg(input: CurveInput): string {
  if (input.baselineCumulative.length === 0) {
    return `<svg viewBox="0 0 ${W} ${H}" class="cl-chart"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${THEME_COLORS.fgFaint}">No data yet</text></svg>`;
  }
  const n = input.baselineCumulative.length;
  const hasTurnNumbers =
    input.turnNumbers !== undefined &&
    input.turnNumbers.length === n &&
    input.turnNumbers.every(Number.isFinite);
  const xValues = hasTurnNumbers
    ? input.turnNumbers!
    : Array.from({ length: n }, (_, index) => index);
  let minX = xValues[0] ?? 0;
  let maxX = minX;
  for (const value of xValues) {
    if (value < minX) minX = value;
    if (value > maxX) maxX = value;
  }
  let maxY = 1;
  for (const value of input.baselineCumulative) {
    if (value > maxY) maxY = value;
  }
  for (const value of input.effectiveCumulative) {
    if (value > maxY) maxY = value;
  }
  const xAt = (value: number) =>
    PAD +
    ((value - minX) / Math.max(1, maxX - minX)) *
      (W - 2 * PAD);
  const baseline = points(
    input.baselineCumulative,
    xValues,
    maxY,
    xAt,
  );
  const effective = points(
    input.effectiveCumulative,
    xValues,
    maxY,
    xAt,
  );

  const pruneMarker =
    input.firstPruneTurn !== null &&
    input.firstPruneTurn >= minX &&
    input.firstPruneTurn <= maxX
      ? `<line x1="${xAt(input.firstPruneTurn).toFixed(1)}" y1="${PAD}" x2="${xAt(input.firstPruneTurn).toFixed(1)}" y2="${H - PAD}" stroke="${THEME_COLORS.accent}" stroke-dasharray="4" /><text x="${(xAt(input.firstPruneTurn) + 4).toFixed(1)}" y="${PAD + 12}" fill="${THEME_COLORS.accent}" font-size="11">pruning</text>`
      : "";

  const thresholdValue = hasTurnNumbers
    ? input.longSessionThreshold
    : input.longSessionThreshold - 1;
  const longRegionStart = Math.max(minX, thresholdValue);
  const longRegion =
    thresholdValue <= maxX
      ? `<rect x="${xAt(longRegionStart).toFixed(1)}" y="${PAD}" width="${(W - PAD - xAt(longRegionStart)).toFixed(1)}" height="${H - 2 * PAD}" fill="${THEME_COLORS.warn}" opacity="0.08" /><text x="${(xAt(longRegionStart) + 4).toFixed(1)}" y="${(H - PAD - 4).toFixed(1)}" fill="${THEME_COLORS.warn}" font-size="11">long session (≥${input.longSessionThreshold} turns)</text>`
      : "";

  return `<svg viewBox="0 0 ${W} ${H}" class="cl-chart">
  ${longRegion}
  <polyline points="${baseline}" fill="none" stroke="${THEME_COLORS.danger}" stroke-width="2" />
  <polyline points="${effective}" fill="none" stroke="${THEME_COLORS.success}" stroke-width="2" />
  ${pruneMarker}
  <text x="${PAD}" y="${H - 8}" fill="${THEME_COLORS.fgFaint}" font-size="11">turn →</text>
  <text x="${W - PAD}" y="${PAD - 8}" text-anchor="end" fill="${THEME_COLORS.danger}" font-size="11">naive prefix cache</text>
  <text x="${W - PAD}" y="${PAD + 8}" text-anchor="end" fill="${THEME_COLORS.success}" font-size="11">CacheLane</text>
</svg>`;
}

export function renderStackedBarSvg(segments: { label: string; value: number }[]): string {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const colors = [THEME_COLORS.accent, THEME_COLORS.success, THEME_COLORS.warn, THEME_COLORS.danger];
  let x = 0;
  const rects = segments
    .map((seg, i) => {
      const w = (seg.value / total) * 100;
      const rect = `<rect x="${x.toFixed(2)}%" y="0" width="${w.toFixed(2)}%" height="20" fill="${colors[i % colors.length]}"><title>${seg.label}: ${seg.value}</title></rect>`;
      x += w;
      return rect;
    })
    .join("");
  return `<svg viewBox="0 0 100 20" preserveAspectRatio="none" class="cl-bar" width="100%" height="20">${rects}</svg>`;
}
