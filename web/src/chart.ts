// Shared bits for the plain-SVG charts: scales, ticks and the chart's own width.
import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";

/** A round step (1, 2 or 5 × a power of ten) that splits the range into about this many parts. */
export function niceStep(range: number, parts: number): number {
  const rough = Math.max(range, 1) / Math.max(parts, 1);
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].find((m) => m * power >= rough)! * power;
  return Math.max(1, step);
}

/** Ticks from a round number at or below min to one at or above max. */
export function niceTicks(min: number, max: number, parts: number): number[] {
  const step = niceStep(max - min, parts);
  const ticks: number[] = [];
  for (let t = Math.floor(min / step) * step; t < max + step; t += step) {
    ticks.push(t);
    if (t >= max) break;
  }
  return ticks;
}

/** Day ticks along the x axis: day 1, then round numbers, up to the last day. */
export function dayTicks(lastDay: number, parts: number): number[] {
  const step = niceStep(lastDay, parts);
  const ticks = [1];
  for (let d = step; d <= lastDay; d += step) if (d > 1) ticks.push(d);
  return ticks;
}

const compact = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  notation: "compact",
  maximumFractionDigits: 1,
});
/** Short money for axis labels: £500, £1.2K, £250K. */
export const formatAxisCash = (n: number) => compact.format(n);

/** The element's width, kept up to date, so charts draw at real size and text stays readable at phone width. */
export function useWidth(el: Ref<HTMLElement | undefined>, fallback = 640): Ref<number> {
  const width = ref(fallback);
  let observer: ResizeObserver | undefined;
  onMounted(() => {
    if (!el.value) return;
    width.value = el.value.clientWidth || fallback;
    observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) width.value = entry.contentRect.width;
    });
    observer.observe(el.value);
  });
  onBeforeUnmount(() => observer?.disconnect());
  return width;
}
