<script setup lang="ts">
import { computed, ref, useId } from "vue";
import { SPEND_CATEGORIES, type SpendCategory, type SummaryDay } from "@xaas/sim";
import { formatCash } from "../api";
import { dayTicks, formatAxisCash, niceTicks, useWidth } from "../chart";

// Spend on each day as a stacked bar, so a day when spending jumped (an upfront purchase, the first day of a
// migration, an event's clean-up bill) stands out. The x axis runs to the final day, so a game that ended early
// shows how early.
const props = defineProps<{ days: SummaryDay[]; finalDay: number | null; labels: Record<SpendCategory, string> }>();

const el = ref<HTMLElement>();
const width = useWidth(el);
const id = useId();

const HEIGHT = 240;
const M = { top: 26, right: 12, bottom: 42, left: 70 };
const plotW = computed(() => Math.max(100, width.value - M.left - M.right));
const plotH = HEIGHT - M.top - M.bottom;

const lastDay = computed(() => Math.max(props.finalDay ?? 0, props.days.at(-1)?.day ?? 1));
const band = computed(() => plotW.value / lastDay.value);
const total = (d: SummaryDay) => SPEND_CATEGORIES.reduce((sum, c) => sum + d[c], 0);
const yTicks = computed(() => niceTicks(0, Math.max(1, ...props.days.map(total)), 4));
const yMax = computed(() => yTicks.value.at(-1)!);
const y = (v: number) => M.top + plotH * (1 - v / yMax.value);
const x = (day: number) => M.left + (day - 1) * band.value;
// Labels about every 60px, so they don't run into each other on a phone.
const xTicks = computed(() => dayTicks(lastDay.value, Math.max(2, Math.floor(plotW.value / 60))));

const bars = computed(() => {
  const gap = band.value > 4 ? 1 : 0;
  return props.days.map((d) => {
    let top = 0;
    const segments = SPEND_CATEGORIES.filter((c) => d[c] > 0).map((c) => {
      const from = top;
      top += d[c];
      return { category: c, y: y(top), height: y(from) - y(top) };
    });
    const parts = SPEND_CATEGORIES.filter((c) => d[c] > 0).map((c) => `${props.labels[c]} ${formatCash(d[c])}`);
    return {
      day: d.day,
      x: x(d.day) + gap / 2,
      width: Math.max(0.6, band.value - gap),
      segments,
      title: `Day ${d.day}: ${formatCash(total(d))}${parts.length ? ` (${parts.join(", ")})` : ""}`,
    };
  });
});

// The day with the most spend, labelled on the chart.
const peak = computed(() => {
  const top = props.days.reduce<SummaryDay | undefined>((best, d) => (!best || total(d) > total(best) ? d : best), undefined);
  if (!top || total(top) === 0) return undefined;
  const cx = x(top.day) + band.value / 2;
  const anchor = cx < M.left + plotW.value * 0.25 ? "start" : cx > M.left + plotW.value * 0.75 ? "end" : "middle";
  return { day: top.day, amount: total(top), x: cx, y: y(total(top)) - 6, anchor };
});

const description = computed(() => {
  const spent = props.days.reduce((sum, d) => sum + total(d), 0);
  const p = peak.value;
  return `${formatCash(spent)} spent over ${props.days.length} days.${p ? ` The most in one day was ${formatCash(p.amount)}, on day ${p.day}.` : ""}`;
});
</script>

<template>
  <figure class="chart" data-testid="cost-chart">
    <div ref="el" class="chart-canvas">
      <svg
        :width="M.left + plotW + M.right"
        :height="HEIGHT"
        role="img"
        :aria-labelledby="`${id}-title ${id}-desc`"
      >
        <title :id="`${id}-title`">Spend each day</title>
        <desc :id="`${id}-desc`">{{ description }}</desc>
        <g class="grid">
          <line
            v-for="t in yTicks"
            :key="t"
            :x1="M.left"
            :x2="M.left + plotW"
            :y1="y(t)"
            :y2="y(t)"
          />
        </g>
        <g class="axis-labels" text-anchor="end">
          <text v-for="t in yTicks" :key="t" :x="M.left - 6" :y="y(t)" dy="0.32em">{{ formatAxisCash(t) }}</text>
        </g>
        <g>
          <g v-for="bar in bars" :key="bar.day" :data-day="bar.day">
            <title>{{ bar.title }}</title>
            <rect
              v-for="s in bar.segments"
              :key="s.category"
              :class="['bar', `cat-${s.category}`]"
              :x="bar.x"
              :y="s.y"
              :width="bar.width"
              :height="Math.max(0, s.height)"
            />
          </g>
        </g>
        <line class="axis" :x1="M.left" :x2="M.left + plotW" :y1="M.top + plotH" :y2="M.top + plotH" />
        <g class="axis-labels" text-anchor="middle">
          <text v-for="t in xTicks" :key="t" :x="x(t) + band / 2" :y="M.top + plotH + 16">{{ t }}</text>
        </g>
        <text class="axis-title" :x="M.left + plotW / 2" :y="HEIGHT - 6" text-anchor="middle">Day</text>
        <text
          class="axis-title"
          :transform="`translate(14 ${M.top + plotH / 2}) rotate(-90)`"
          text-anchor="middle"
        >
          Spend a day
        </text>
        <text
          v-if="peak"
          class="peak-label"
          :x="peak.x"
          :y="peak.y"
          :text-anchor="peak.anchor"
          data-testid="cost-peak"
        >Day {{ peak.day }}: {{ formatCash(peak.amount) }}</text>
      </svg>
    </div>
    <figcaption>
      <ul class="chart-legend" aria-label="Key">
        <li v-for="c in SPEND_CATEGORIES" :key="c" :class="`cat-${c}`">
          <span class="swatch"></span>{{ labels[c] }}
        </li>
      </ul>
    </figcaption>
  </figure>
</template>
