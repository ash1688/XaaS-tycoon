<script setup lang="ts">
import { computed } from "vue";
import type { ConversionDriver } from "@xaas/sim";
import { formatCount, formatPrice, formatUptime } from "../api";
import { useGame } from "../game";

// Free-to-paid conversion: how many free users started paying, the daily rate, and what's helping or hurting it
// (features, recent uptime, satisfaction and price). Free users are an investment: this is where they pay back.
const game = useGame();
const conversion = computed(() => game.company?.conversion);

/** A share as a percentage to two places: 0.0045 → "0.45%". */
const percent = (share: number) => `${(100 * share).toFixed(2)}%`;
/** Free users expected to start paying on the next day played, at today's free users and rate. */
const expected = computed(() =>
  game.company && conversion.value ? Math.round(game.company.freeUsers * conversion.value.rate) : 0,
);

const LABELS: Record<ConversionDriver["id"], string> = {
  features: "Features",
  uptime: "Uptime",
  satisfaction: "Satisfaction",
  price: "Price",
};

/** What each driver is measured on, in a few words. */
function detail(d: ConversionDriver): string {
  const c = game.company!;
  switch (d.id) {
    case "features": {
      const what = c.model === "saas" ? "add-on" : "feature";
      return d.value === 0 ? `No ${what}s live yet` : `${d.value} ${what}${d.value === 1 ? "" : "s"} live`;
    }
    case "uptime":
      return `${formatUptime(d.value)} over the last ${game.meta?.conversionUptimeDays ?? 7} days`;
    case "satisfaction":
      return `${Math.round(d.value)}% satisfied (good is ${game.meta?.goodSatisfaction ?? 70}%)`;
    case "price":
      return d.value > 1
        ? `${formatPrice(c.price)} against a fair price of ${formatPrice(c.fairPrice)}`
        : `At or below the fair price of ${formatPrice(c.fairPrice)}`;
  }
}

/** The multiplier as a change: "+25%", "−40%", or "No effect". */
function effect(d: ConversionDriver): string {
  const change = Math.round(100 * (d.multiplier - 1));
  if (change === 0) return "No effect";
  return `${change > 0 ? "+" : "−"}${Math.abs(change)}%`;
}
</script>

<template>
  <section
    v-if="game.company && conversion"
    class="card conversion"
    aria-labelledby="conversion-heading"
    data-testid="conversion"
  >
    <div class="row-between panel-head">
      <h2 id="conversion-heading">Free to paid</h2>
      <span class="muted">Base rate {{ percent(conversion.baseRate) }} a day</span>
    </div>
    <div class="stats">
      <div class="stat">
        <span class="label">Started paying</span>
        <span class="value pos" data-testid="conversions-today">{{ formatCount(conversion.today) }}</span>
        <small>{{ game.lastDay ? `on day ${game.lastDay.day}, ` : "" }}{{ formatCount(conversion.total) }} in all</small>
      </div>
      <div class="stat">
        <span class="label">Daily rate</span>
        <span class="value" data-testid="conversion-rate">{{ percent(conversion.rate) }}</span>
        <small>of free users a day</small>
      </div>
      <div class="stat">
        <span class="label">Expected next day</span>
        <span class="value">{{ formatCount(expected) }}</span>
        <small>of {{ formatCount(game.company.freeUsers) }} free users</small>
      </div>
    </div>
    <h3 class="drivers-heading">Helping or hurting</h3>
    <ul class="drivers" data-testid="conversion-drivers">
      <li v-for="d in conversion.drivers" :key="d.id" :class="['driver', d.effect]" :data-driver="d.id">
        <span class="driver-name">{{ LABELS[d.id] }}</span>
        <span class="driver-detail muted">{{ detail(d) }}</span>
        <strong :class="['driver-effect', { pos: d.effect === 'helping', neg: d.effect === 'hurting' }]">{{
          effect(d)
        }}</strong>
      </li>
    </ul>
    <p>
      Free users are an investment: you pay for their load and support, and a few start paying each day. More do when
      you have features they want, keep the service up and answer their tickets. Fewer do when your price is above
      what the product is worth to them.
    </p>
  </section>
</template>
