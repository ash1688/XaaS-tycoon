<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { formatCash } from "../../api";
import { useGame } from "../../game";
import { formatShare, formatSharePrice } from "../../shares";

// The opening bell: once the IPO is approved, the student picks a float (15–40% of the company after the IPO, in new
// shares that dilute everyone) and rings the bell, which ends the game. The first day of trading then plays out
// half-hour by half-hour on a line chart, and the page ends with the cash raised, the market value at the close and
// what the student's stake is worth. Coming back later shows the day as it ended.
const game = useGame();
const ipo = computed(() => game.company?.ipo ?? null);
const offer = computed(() => ipo.value?.offer ?? null);
const result = computed(() => ipo.value?.result ?? null);

const percent = ref(25);
watch(
  offer,
  (o) => {
    if (!o) return;
    const lo = Math.round(o.minFloat * 100);
    const hi = Math.round(o.maxFloat * 100);
    percent.value = Math.min(hi, Math.max(lo, percent.value));
  },
  { immediate: true },
);
const preview = computed(() => offer.value?.floats.find((f) => Math.round(f.float * 100) === percent.value) ?? null);

// How many of the day's prices are drawn: all of them, unless the bell was just rung and the day is playing out.
const shown = ref(Number.POSITIVE_INFINITY);
let timer: ReturnType<typeof setInterval> | undefined;
const TICK_MS = 350;
const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const playing = computed(() => !!result.value && shown.value < result.value.prices.length);
onUnmounted(() => clearInterval(timer));

async function ring() {
  game.track("control", { control: "ipo-ring", value: String(percent.value) });
  // Only the open shows until the day plays out, so the result can't be seen before it.
  if (!reducedMotion) shown.value = 1;
  await game.act({ type: "ringBell", float: percent.value / 100 });
  if (game.error || !result.value) {
    shown.value = Number.POSITIVE_INFINITY;
    return;
  }
  if (!reducedMotion) {
    timer = setInterval(() => {
      shown.value++;
      if (shown.value >= result.value!.prices.length) clearInterval(timer);
    }, TICK_MS);
  }
  await game.loadSummary();
}

// The time of each price: the open at 09:30, then every half hour to the 16:00 close.
const timeOf = (i: number) => {
  const minutes = 9 * 60 + 30 + i * 30;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
};
const prices = computed(() => result.value?.prices.slice(0, Math.min(shown.value, result.value.prices.length)) ?? []);
const latest = computed(() => prices.value.at(-1) ?? 0);
const change = computed(() => (result.value ? latest.value / result.value.offerPrice - 1 : 0));

// The chart: price against time, with the offer price dashed across it. Drawn to fill its box at any width, with the
// labels in HTML around it so they stay readable on a phone.
const W = 1000;
const H = 400;
const M = { top: 16, right: 8, bottom: 16, left: 8 };
const range = computed(() => {
  const all = [...(result.value?.prices ?? []), result.value?.offerPrice ?? 0];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pad = Math.max((hi - lo) * 0.15, hi * 0.02);
  return { lo: lo - pad, hi: hi + pad };
});
const x = (i: number) => M.left + ((W - M.left - M.right) * i) / Math.max(1, (result.value?.prices.length ?? 2) - 1);
const y = (p: number) => M.top + (H - M.top - M.bottom) * (1 - (p - range.value.lo) / (range.value.hi - range.value.lo));
const line = computed(() => prices.value.map((p, i) => `${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(" "));
const up = computed(() => latest.value >= (result.value?.offerPrice ?? 0));
const describe = computed(() =>
  result.value
    ? `The share price opened at ${formatSharePrice(result.value.offerPrice)} and closed at ${formatSharePrice(result.value.closePrice)}.`
    : "",
);
</script>

<template>
  <div v-if="ipo" class="page-grid bell-page" data-testid="bell-page">
    <section v-if="ipo.status === 'approved' && offer" class="card span-all" aria-labelledby="bell-heading">
      <h2 id="bell-heading">Your IPO is approved</h2>
      <p class="muted">
        Choose how much of the company to float: new shares sold to the public at the offer price. The cash raised goes
        to the company, and everyone, you included, owns a smaller share of it. A small float is more volatile on the
        first day; a large one is steadier.
      </p>
      <div class="stats">
        <div class="stat">
          <span class="label">Valuation</span>
          <span class="value">{{ formatCash(offer.valuation) }}</span>
        </div>
        <div class="stat">
          <span class="label">Offer price</span>
          <span class="value" data-testid="bell-offer-price">{{ formatSharePrice(offer.offerPrice) }}</span>
          <small>a share, the valuation ÷ {{ offer.sharesInIssue.toLocaleString("en-GB") }} shares</small>
        </div>
      </div>
      <label class="bell-float" for="bell-float">
        Float: <strong data-testid="bell-float-value">{{ percent }}%</strong> of the company after the IPO
      </label>
      <input
        id="bell-float"
        v-model.number="percent"
        type="range"
        :min="Math.round(offer.minFloat * 100)"
        :max="Math.round(offer.maxFloat * 100)"
        step="1"
        data-testid="bell-float"
      />
      <div class="bell-scale muted" aria-hidden="true">
        <span>{{ Math.round(offer.minFloat * 100) }}%: bigger swings</span>
        <span>{{ Math.round(offer.maxFloat * 100) }}%: steadier</span>
      </div>
      <table v-if="preview" class="balance bell-preview">
        <tbody>
          <tr>
            <th scope="row">New shares sold</th>
            <td class="num">{{ preview.newShares.toLocaleString("en-GB") }}</td>
          </tr>
          <tr>
            <th scope="row">Cash raised at the offer price</th>
            <td class="num" data-testid="bell-preview-cash">{{ formatCash(preview.cashRaised) }}</td>
          </tr>
          <tr>
            <th scope="row">Your stake</th>
            <td class="num" data-testid="bell-preview-stake">
              {{ formatShare(offer.studentShare) }} → {{ formatShare(preview.studentShareAfter) }}
            </td>
          </tr>
          <tr>
            <th scope="row">First-day swing</th>
            <td class="num">about ±{{ Math.round(preview.swing * 100) }}%</td>
          </tr>
        </tbody>
      </table>
      <button class="bell-ring" :disabled="game.busy" data-testid="bell-ring" @click="ring">
        <span aria-hidden="true">🔔</span> Ring the opening bell
      </button>
      <p class="muted">Ringing it ends the game.</p>
    </section>

    <section v-else-if="result" class="card span-all" aria-labelledby="trading-heading" data-testid="bell-trading">
      <div class="row-between">
        <h2 id="trading-heading">First day of trading</h2>
        <span class="muted" aria-live="polite">{{ playing ? timeOf(prices.length - 1) : "16:00 close" }}</span>
      </div>
      <p class="bell-price">
        <strong data-testid="bell-price">{{ formatSharePrice(latest) }}</strong>
        <span :class="up ? 'pos' : 'neg'">{{ change >= 0 ? "+" : "−" }}{{ (Math.abs(change) * 100).toFixed(1) }}%</span>
        <span class="muted">on the offer price of {{ formatSharePrice(result.offerPrice) }}</span>
      </p>
      <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="bell-chart" role="img" :aria-label="describe">
        <line
          :x1="M.left"
          :x2="W - M.right"
          :y1="y(result.offerPrice)"
          :y2="y(result.offerPrice)"
          class="bell-offer"
          vector-effect="non-scaling-stroke"
        />
        <polyline :points="line" :class="['bell-line', up ? 'up' : 'down']" vector-effect="non-scaling-stroke" />
      </svg>
      <div class="bell-axis muted" aria-hidden="true">
        <span>09:30</span>
        <span>- - - the offer price, {{ formatSharePrice(result.offerPrice) }}</span>
        <span>16:00</span>
      </div>

      <template v-if="!playing">
        <div class="stats bell-result" data-testid="bell-result">
          <div class="stat">
            <span class="label">Cash raised</span>
            <span class="value" data-testid="bell-cash-raised">{{ formatCash(result.cashRaised) }}</span>
            <small>{{ result.newShares.toLocaleString("en-GB") }} new shares: {{ formatShare(result.float) }} floated</small>
          </div>
          <div class="stat">
            <span class="label">Market value at the close</span>
            <span class="value" data-testid="bell-market-value">{{ formatCash(result.marketValue) }}</span>
            <small>
              {{ formatSharePrice(result.closePrice) }} × {{ result.sharesAfter.toLocaleString("en-GB") }} shares, the cash
              raised included
            </small>
          </div>
          <div class="stat">
            <span class="label">Your stake</span>
            <span class="value" data-testid="bell-stake">{{ formatCash(result.studentValue) }}</span>
            <small>{{ formatShare(result.studentShare) }} of the company</small>
          </div>
        </div>
        <h3>Why it moved</h3>
        <ul class="bell-reasons">
          <li v-for="r in result.reasons" :key="r">{{ r }}</li>
        </ul>
        <p><RouterLink :to="game.base" data-testid="bell-summary-link">See how you did</RouterLink></p>
      </template>
    </section>

    <section v-else class="card span-all">
      <h2>The opening bell</h2>
      <p>
        Your company can't float yet. Meet every condition on the IPO readiness checklist, then apply.
        <RouterLink :to="`${game.base}/finance?tab=ipo`">Open Finance</RouterLink>
      </p>
    </section>
  </div>
</template>
