<script setup lang="ts">
import { computed, ref, useId } from "vue";
import type { IncomeCostDay } from "@xaas/sim";
import { formatCash } from "../api";
import { dayTicks, formatAxisCash, niceTicks, useWidth } from "../chart";

// Income and costs added up from day 1, as two lines on the same day axis as the other charts. Where the income line is
// above the costs line, the company is in profit so far; the gap at the end is the profit or loss. Costs are dashed, so
// the lines differ by more than colour.
const props = defineProps<{ days: IncomeCostDay[]; finalDay: number | null }>();

const el = ref<HTMLElement>();
const width = useWidth(el);
const id = useId();

const HEIGHT = 220;
const M = { top: 12, right: 12, bottom: 42, left: 70 };
const plotW = computed(() => Math.max(100, width.value - M.left - M.right));
const plotH = HEIGHT - M.top - M.bottom;

const lastDay = computed(() => Math.max(props.finalDay ?? 0, props.days.at(-1)?.day ?? 1));
const band = computed(() => plotW.value / lastDay.value);
const yTicks = computed(() =>
  niceTicks(0, Math.max(1, ...props.days.map((d) => Math.max(d.totalIncome, d.totalCosts))), 4),
);
const yMax = computed(() => yTicks.value.at(-1)!);
const y = (v: number) => M.top + plotH * (1 - v / yMax.value);
// Each day's point sits in the middle of its slot, lining up with the cash chart.
const x = (day: number) => M.left + (day - 0.5) * band.value;
const xTicks = computed(() => dayTicks(lastDay.value, Math.max(2, Math.floor(plotW.value / 60))));

const line = (value: (d: IncomeCostDay) => number) =>
  props.days.map((d, i) => `${i ? "L" : "M"}${x(d.day).toFixed(1)},${y(value(d)).toFixed(1)}`).join("");
const incomePath = computed(() => line((d) => d.totalIncome));
const costsPath = computed(() => line((d) => d.totalCosts));

// A hover strip for each day, with the day's figures and the totals so far.
const strips = computed(() =>
  props.days.map((d) => ({
    day: d.day,
    x: x(d.day) - band.value / 2,
    title:
      `Day ${d.day}: ${formatCash(d.income)} in, ${formatCash(d.costs)} out. ` +
      `So far ${formatCash(d.totalIncome)} in, ${formatCash(d.totalCosts)} out.`,
  })),
);

const last = computed(() => props.days.at(-1));
const description = computed(() => {
  const l = last.value;
  if (!l) return "";
  const gap = l.totalIncome - l.totalCosts;
  return (
    `By day ${l.day}, ${formatCash(l.totalIncome)} of income against ${formatCash(l.totalCosts)} of costs: ` +
    `${gap < 0 ? "a loss" : "a profit"} of ${formatCash(Math.abs(gap))}.`
  );
});
</script>

<template>
  <figure class="chart" data-testid="income-chart">
    <div ref="el" class="chart-canvas">
      <svg :width="M.left + plotW + M.right" :height="HEIGHT" role="img" :aria-labelledby="`${id}-title ${id}-desc`">
        <title :id="`${id}-title`">Income against costs, added up from day 1</title>
        <desc :id="`${id}-desc`">{{ description }}</desc>
        <g class="grid">
          <line v-for="t in yTicks" :key="t" :x1="M.left" :x2="M.left + plotW" :y1="y(t)" :y2="y(t)" />
        </g>
        <g class="axis-labels" text-anchor="end">
          <text v-for="t in yTicks" :key="t" :x="M.left - 6" :y="y(t)" dy="0.32em">{{ formatAxisCash(t) }}</text>
        </g>
        <path class="costs-line" :d="costsPath" data-testid="income-chart-costs" />
        <path class="income-line" :d="incomePath" data-testid="income-chart-income" />
        <g>
          <rect
            v-for="s in strips"
            :key="s.day"
            class="hover-strip"
            :data-day="s.day"
            :x="s.x"
            :y="M.top"
            :width="band"
            :height="plotH"
          >
            <title>{{ s.title }}</title>
          </rect>
        </g>
        <line class="axis" :x1="M.left" :x2="M.left + plotW" :y1="M.top + plotH" :y2="M.top + plotH" />
        <g class="axis-labels" text-anchor="middle">
          <text v-for="t in xTicks" :key="t" :x="x(t)" :y="M.top + plotH + 16">{{ t }}</text>
        </g>
        <text class="axis-title" :x="M.left + plotW / 2" :y="HEIGHT - 6" text-anchor="middle">Day</text>
        <text class="axis-title" :transform="`translate(14 ${M.top + plotH / 2}) rotate(-90)`" text-anchor="middle">
          Total so far
        </text>
      </svg>
    </div>
    <figcaption>
      <ul class="chart-legend" aria-label="Key">
        <li class="key-income"><span class="line-swatch"></span>Income</li>
        <li class="key-costs"><span class="line-swatch"></span>Costs, debt included</li>
      </ul>
    </figcaption>
  </figure>
</template>
