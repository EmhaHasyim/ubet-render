import { createMemo, type Accessor } from 'solid-js';

const OVERSCAN = 15;
const BASE_LINE_HEIGHT = 20;
const FALLBACK_CHAR_WIDTH = 7.2;

let charWidthPx = FALLBACK_CHAR_WIDTH;

function measureCharWidth(): void {
  try {
    const probe = document.createElement('span');
    probe.style.cssText =
      'position:absolute;visibility:hidden;white-space:pre;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;';
    probe.textContent = '0'.repeat(100);
    document.body.appendChild(probe);
    const measured = probe.getBoundingClientRect().width / 100;
    document.body.removeChild(probe);
    if (measured > 0) charWidthPx = measured;
  } catch {
    /* keep fallback */
  }
}

function findRowIndexAtOffset(sums: number[], offset: number): number {
  let low = 0;
  let high = sums.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    const sum = sums[middle];
    if (sum !== undefined && sum <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function useVirtualScroller(
  logs: Accessor<string[]>,
  scrollTop: Accessor<number>,
  viewportHeight: Accessor<number>,
  contentWidth: Accessor<number>,
) {
  const charsPerLine = createMemo(() => {
    const width = contentWidth();
    if (width <= 0) return 0;
    return Math.max(1, Math.floor((width - 24) / charWidthPx));
  });

  const rowHeights = createMemo(() => {
    const chars = charsPerLine();
    return logs().map((line) => {
      const lines = chars > 0 ? Math.max(1, Math.ceil(line.length / chars)) : 1;
      return lines * BASE_LINE_HEIGHT;
    });
  });

  const prefixSums = createMemo(() => {
    const heights = rowHeights();
    const sums = Array.from({ length: heights.length + 1 }, () => 0);
    for (let index = 0; index < heights.length; index++) {
      sums[index + 1] = (sums[index] ?? 0) + (heights[index] ?? 0);
    }
    return sums;
  });

  const startIndex = createMemo(() =>
    Math.max(0, findRowIndexAtOffset(prefixSums(), scrollTop()) - OVERSCAN),
  );

  const endIndex = createMemo(() => {
    if (viewportHeight() <= 0) return logs().length;
    return Math.min(
      logs().length,
      findRowIndexAtOffset(prefixSums(), scrollTop() + viewportHeight()) +
        1 +
        OVERSCAN,
    );
  });

  const visibleLogs = createMemo(() => logs().slice(startIndex(), endIndex()));
  const topPadding = createMemo(() => prefixSums()[startIndex()] ?? 0);
  const bottomPadding = createMemo(() => {
    const sums = prefixSums();
    return (sums[logs().length] ?? 0) - (sums[endIndex()] ?? 0);
  });

  return {
    measureCharWidth,
    visibleLogs,
    topPadding,
    bottomPadding,
  };
}
