<script setup lang="ts">
import { computed } from "vue";
import { formatCount, formatPrice } from "../api";
import { useGame } from "../game";

// The customer mix: who the users are, as a bar of each customer type's share, and where each type's price threshold
// sits against your price. A rise's reaction is each type's reaction weighted by its share, so this is the market
// you're pricing for.
const game = useGame();
const mix = computed(() => game.company?.customerMix);

/** A share as a whole percentage, or to one place under 1%: 0.7 → "70%", 0.004 → "0.4%". */
const percent = (share: number) => (share > 0 && share < 0.01 ? `${(100 * share).toFixed(1)}%` : `${Math.round(100 * share)}%`);

/** The price scale under the bar runs from £0 to a bit past the highest threshold or your price, if higher. */
const scaleTop = computed(() => {
  const m = mix.value;
  if (!m) return 1;
  return Math.max(m.price, ...m.types.map((t) => t.threshold)) * 1.15;
});
const along = (price: number) => `${Math.min(100, (100 * price) / scaleTop.value)}%`;
const over = computed(() => mix.value?.types.filter((t) => t.overThreshold && t.share > 0) ?? []);

/** What tilts a type's share of new users from the product's mix: "features ×1.5", "price ×0.25", "rivals ×0.8". */
const tilt = (t: { featureAppeal: number; priceFilter: number; rivalPull: number }) =>
  [
    t.featureAppeal !== 1 ? `features ×${+t.featureAppeal.toFixed(2)}` : "",
    t.priceFilter !== 1 ? `price ×${+t.priceFilter.toFixed(2)}` : "",
    t.rivalPull !== 1 ? `rivals ×${+t.rivalPull.toFixed(2)}` : "",
  ]
    .filter(Boolean)
    .join(", ");
</script>

<template>
  <section v-if="game.company && mix" class="card customer-mix" aria-labelledby="mix-heading" data-testid="customer-mix">
    <div class="row-between panel-head">
      <h2 id="mix-heading">Customer mix</h2>
      <span class="muted">Your price {{ formatPrice(mix.price) }} a month</span>
    </div>
    <p class="mix-caption muted">Share of users</p>
    <div class="mix-bar" role="img" :aria-label="mix.types.map((t) => `${t.name} ${percent(t.share)}`).join(', ')">
      <span
        v-for="t in mix.types.filter((t) => t.share > 0)"
        :key="t.id"
        :class="['mix-segment', t.id]"
        :style="{ width: `${100 * t.share}%` }"
        :title="`${t.name}: ${percent(t.share)}, threshold ${formatPrice(t.threshold)}`"
      >
        <span v-if="t.share >= 0.12" class="mix-segment-label">{{ percent(t.share) }}</span>
      </span>
    </div>
    <p class="mix-caption muted">Price thresholds, against your price</p>
    <div class="mix-scale" data-testid="mix-thresholds" aria-hidden="true">
      <span
        v-for="t in mix.types"
        :key="t.id"
        :class="['mix-threshold', t.id]"
        :style="{ left: along(t.threshold) }"
        :data-type="t.id"
      >
        <span class="mix-threshold-price">{{ formatPrice(t.threshold) }}</span>
      </span>
      <span class="mix-price" :style="{ left: along(mix.price) }"><span>You</span></span>
    </div>
    <table class="mix-table">
      <thead>
        <tr>
          <th scope="col">Customer type</th>
          <th scope="col" class="num">Share</th>
          <th scope="col" class="num">Users</th>
          <th scope="col" class="num">New users</th>
          <th scope="col" class="num">Threshold</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="t in mix.types" :key="t.id" :data-type="t.id">
          <th scope="row">
            <span :class="['mix-swatch', t.id]" aria-hidden="true"></span>
            {{ t.name }}
            <small class="muted">{{ t.blurb }}</small>
          </th>
          <td class="num">{{ percent(t.share) }}</td>
          <td class="num">{{ formatCount(t.users) }}</td>
          <td class="num" data-testid="mix-new">
            {{ percent(t.newShare) }}<small v-if="tilt(t)" class="mix-over-note">{{ tilt(t) }}</small>
          </td>
          <td :class="['num', { neg: t.overThreshold }]">
            {{ formatPrice(t.threshold) }}<small v-if="t.overThreshold" class="mix-over-note">you're over</small>
          </td>
        </tr>
      </tbody>
    </table>
    <p>
      Each type has its own price threshold: the price at which it starts to react badly. When you raise your price,
      each type reacts in its own way, and the reaction you get is each type's reaction weighted by its share of
      users. A rise lands hardest on a mostly casual crowd; professionals and businesses put up with much more.
    </p>
    <p data-testid="mix-shifts">
      The mix shifts as users come and go. New users join in your product's usual mix, tilted by your features (each
      pulls in a customer type) and your price: above a type's threshold, fewer of them join. A rise loses casual users
      first, and downtime drives businesses and professionals away. A pricier company ends up more professional, so
      its next rise hurts less.
    </p>
    <p v-if="over.length" class="wave-note" data-testid="mix-over">
      <span class="badge">Over threshold</span>
      Your price is above what {{ over.map((t) => t.name.toLowerCase()).join(" and ") }} think it's worth, so some
      of them stop paying every day.
    </p>
  </section>
</template>
