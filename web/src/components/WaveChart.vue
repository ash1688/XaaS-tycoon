<script setup lang="ts">
import { computed } from "vue";
import type { PriceWaveView } from "@xaas/sim";
import { formatCount } from "../api";

// A price wave day by day, as a small bar chart: on a rise, paying users leaving and dropping to free; on a cut, new
// users and free users upgrading. Days already played are solid, days to come faded.
// played: wave days played so far (none for a preview).
const props = defineProps<{ days: PriceWaveView["days"]; direction: "rise" | "cut"; played?: number }>();

const rise = computed(() => props.direction === "rise");
// The two parts of each bar, bottom first.
const parts = computed(() =>
  props.days.map((d) => (rise.value ? [d.left, d.toFree] : [d.joined, d.upgraded])),
);
const most = computed(() => Math.max(1, ...parts.value.map(([a, b]) => a! + b!)));
const BAR = 24;
const HEIGHT = 60;
const width = computed(() => props.days.length * BAR);
const label = computed(() => {
  const each = parts.value.map(([a, b], i) =>
    rise.value
      ? `day ${i + 1}: ${formatCount(a!)} leave, ${formatCount(b!)} drop to free`
      : `day ${i + 1}: ${formatCount(a!)} join, ${formatCount(b!)} upgrade`,
  );
  return `The wave day by day. ${each.join("; ")}.`;
});
const h = (n: number) => (HEIGHT * n) / most.value;
</script>

<template>
  <figure :class="['wave-chart', direction]">
    <svg :viewBox="`0 0 ${width} ${HEIGHT}`" preserveAspectRatio="none" role="img" :aria-label="label">
      <line x1="0" :y1="HEIGHT" :x2="width" :y2="HEIGHT" class="axis" />
      <g v-for="([a, b], i) in parts" :key="i" :class="{ future: played !== undefined && i >= played }">
        <rect class="part-a" :x="i * BAR + 3" :y="HEIGHT - h(a!)" :width="BAR - 6" :height="h(a!)" />
        <rect class="part-b" :x="i * BAR + 3" :y="HEIGHT - h(a!) - h(b!)" :width="BAR - 6" :height="h(b!)" />
      </g>
    </svg>
    <div class="wave-days" aria-hidden="true">
      <span>Day 1</span>
      <span>Day {{ days.length }}</span>
    </div>
    <figcaption class="wave-legend">
      <span><span class="swatch part-a"></span>{{ rise ? "Leave" : "Join" }}</span>
      <span><span class="swatch part-b"></span>{{ rise ? "Drop to free" : "Upgrade to paid" }}</span>
    </figcaption>
  </figure>
</template>
