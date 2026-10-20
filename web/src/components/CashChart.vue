<script setup lang="ts">
import { computed, ref, useId } from "vue";
import { SPEND_CATEGORIES, type SummaryDay } from "@xaas/sim";
import { formatCash } from "../api";
import { dayTicks, formatAxisCash, niceTicks, useWidth } from "../chart";

// Cash left at the end of each day, as a line on the same day axis as the cost chart. Below £0 is bankruptcy.
const props = defineProps<{ days: SummaryDay[]; finalDay: number }>();

const el = ref<HTMLElement>();
const width = useWidth(el);
const id = useId();

const HEIGHT = 190;
const M = { top: 12, right: 12, bottom: 42, left: 70 };
const plotW = computed(() => Math.max(100, width.value - M.left - M.right));
const plotH = HEIGHT - M.top - M.bottom;

const lastDay = computed(() => Math.max(props.finalDay, props.days.at(-1)?.day ?? 1));
const band = computed(() => plotW.value / lastDay.value);
// Cash before the first day's charges and any loan taken at the start, so the line starts at the starting cash.
const opening = computed(() => {
  const first = props.days[0];
  const spent = first && SPEND_CATEGORIES.reduce((sum, c) => sum + first[c], 0);
  return first && { day: first.day, cash: first.cash + spent! - first.income - first.borrowed };
});
const yTicks = computed(() => {
  const cash = [...props.days.map((d) => d.cash), opening.value?.cash ?? 0];
  return niceTicks(Math.min(0, ...cash), Math.max(1, ...cash), 4);
});
const y = (v: number) => {
  const [lo, hi] = [yTicks.value[0]!, yTicks.value.at(-1)!];
  return M.top + plotH * (1 - (v - lo) / (hi - lo));
};
// Each day's point sits in the middle of its slot, lining up with the cost chart's bars.
const x = (day: number) => M.left + (day - 0.5) * band.value;
const xTicks = computed(() => dayTicks(lastDay.value, Math.max(2, Math.floor(plotW.value / 60))));
const path = computed(() => {
  const o = opening.value;
  const start = o ? `M${(x(o.day) - band.value / 2).toFixed(1)},${y(o.cash).toFixed(1)}` : "";
  const points = props.days.map((d, i) => `${start || i ? "L" : "M"}${x(d.day).toFixed(1)},${y(d.cash).toFixed(1)}`);
  return start + points.join("");
});
const wentNegative = computed(() => props.days.some((d) => d.cash < 0));
const last = computed(() => props.days.at(-1));
</script>

<template>
  <figure class="chart" data-testid="cash-chart">
    <div ref="el" class="chart-canvas">
      <svg :width="M.left + plotW + M.right" :height="HEIGHT" role="img" :aria-labelledby="`${id}-title ${id}-desc`">
        <title :id="`${id}-title`">Cash at the end of each day</title>
        <desc :id="`${id}-desc`">
          <template v-if="last">
            {{ formatCash(opening!.cash) }} at the start, {{ formatCash(last.cash) }} after day {{ last.day }}.
          </template>
        </desc>
        <g class="grid">
          <line v-for="t in yTicks" :key="t" :x1="M.left" :x2="M.left + plotW" :y1="y(t)" :y2="y(t)" />
        </g>
        <line v-if="wentNegative" class="zero" :x1="M.left" :x2="M.left + plotW" :y1="y(0)" :y2="y(0)" />
        <g class="axis-labels" text-anchor="end">
          <text v-for="t in yTicks" :key="t" :x="M.left - 6" :y="y(t)" dy="0.32em">{{ formatAxisCash(t) }}</text>
        </g>
        <path class="cash-line" :d="path" />
        <line class="axis" :x1="M.left" :x2="M.left + plotW" :y1="M.top + plotH" :y2="M.top + plotH" />
        <g class="axis-labels" text-anchor="middle">
          <text v-for="t in xTicks" :key="t" :x="x(t)" :y="M.top + plotH + 16">{{ t }}</text>
        </g>
        <text class="axis-title" :x="M.left + plotW / 2" :y="HEIGHT - 6" text-anchor="middle">Day</text>
        <text class="axis-title" :transform="`translate(14 ${M.top + plotH / 2}) rotate(-90)`" text-anchor="middle">
          Cash
        </text>
      </svg>
    </div>
  </figure>
</template>
