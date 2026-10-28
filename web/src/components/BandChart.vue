<script setup lang="ts">
import { computed } from "vue";
import { PRICE_BAND_NAMES, type PriceBand, type PriceBandsView } from "@xaas/sim";

// How customers split over a price: a stacked bar per customer type, then everyone together, with a key. A rise splits
// paying users (accept, grumble online, contact support, drop to free, leave); a cut the new users it could bring, and
// the opening price the launch users (join paying, join free, don't join). Each bar is also said in words.
const props = defineProps<{ bands: PriceBandsView; caption?: string }>();

const percent = (share: number) => `${(100 * share).toFixed(1).replace(/\.0$/, "")}%`;
const words = (bands: PriceBand[]) => bands.map((b) => `${PRICE_BAND_NAMES[b.id].toLowerCase()} ${percent(b.share)}`).join(", ");
const ids = computed(() => props.bands.total.map((b) => b.id));
const of = computed(
  () => ({ rise: "Paying users", cut: "The new users it could bring", launch: "Launch users", none: "" })[props.bands.kind],
);
const rows = computed(() => [
  ...props.bands.types.map((t) => ({ id: t.id, name: t.name, bands: t.bands, upgrade: t.upgrade })),
  { id: "total", name: "Everyone", bands: props.bands.total, upgrade: props.bands.upgrade },
]);
</script>

<template>
  <figure v-if="bands.kind !== 'none'" class="band-chart" data-testid="band-chart" :data-kind="bands.kind">
    <figcaption class="muted">{{ caption ?? `${of}, by customer type` }}</figcaption>
    <ul class="band-key" aria-label="Key">
      <li v-for="id in ids" :key="id"><span :class="['band-swatch', `band-${id}`]" aria-hidden="true"></span>{{ PRICE_BAND_NAMES[id] }}</li>
    </ul>
    <div v-for="r in rows" :key="r.id" :class="['band-row', { 'band-total': r.id === 'total' }]" :data-type="r.id" data-testid="band-row">
      <span class="band-name">{{ r.name }}</span>
      <div class="band-bar" role="img" :aria-label="`${r.name}: ${words(r.bands)}`">
        <span
          v-for="b in r.bands.filter((x) => x.share > 0.0005)"
          :key="b.id"
          :class="['band-part', `band-${b.id}`]"
          :style="{ width: `${100 * b.share}%` }"
          :title="`${PRICE_BAND_NAMES[b.id]}: ${percent(b.share)}`"
          :data-band="b.id"
        ></span>
      </div>
      <small v-if="bands.kind === 'cut'" class="muted band-upgrade">{{ percent(r.upgrade) }} of free users upgrade</small>
    </div>
  </figure>
</template>
