<script setup lang="ts">
import { computed } from "vue";
import { formatCount, formatPrice } from "../api";
import { useGame } from "../game";

// Market share: a pie of every user in the market, yours and each rival's, with each company's price and quality, and
// who wins each customer type's new users. Rivals answer a price change after a delay, so a pending answer is shown.
const game = useGame();
const market = computed(() => game.company?.market);
const rivals = computed(() => market.value?.companies.filter((c) => !c.you) ?? []);

const percent = (share: number) => (share > 0 && share < 0.01 ? `${(100 * share).toFixed(1)}%` : `${Math.round(100 * share)}%`);
/** The student's slice is "you"; rivals take the rival colours in order. */
const sliceClass = (id: string) => (id === "you" ? "you" : `rival-${(rivals.value.findIndex((r) => r.id === id) % 3) + 1}`);

/** Each company's slice as an SVG path on a circle of radius 1 centred on 0,0, starting at the top, clockwise. */
const slices = computed(() => {
  const m = market.value;
  if (!m) return [];
  let angle = 0;
  return m.companies
    .filter((c) => c.share > 0)
    .map((c) => {
      const start = angle;
      angle += 2 * Math.PI * c.share;
      const point = (a: number) => `${Math.sin(a).toFixed(5)} ${(-Math.cos(a)).toFixed(5)}`;
      const large = c.share > 0.5 ? 1 : 0;
      // A whole circle can't be one arc: draw it as two halves.
      const d =
        c.share >= 0.9999
          ? "M 0 -1 A 1 1 0 1 1 0 1 A 1 1 0 1 1 0 -1 Z"
          : `M 0 0 L ${point(start)} A 1 1 0 ${large} 1 ${point(angle)} Z`;
      return { id: c.id, name: c.name, share: c.share, d, cls: sliceClass(c.id) };
    });
});

const growthNote = computed(() => {
  const g = market.value?.growth ?? 1;
  if (g > 1.005) return `Rivals are speeding your growth: you win more than your share of new users (×${g.toFixed(2)}).`;
  if (g < 0.995) return `Rivals are slowing your growth: they win more of the new users than you (×${g.toFixed(2)}).`;
  return "You win about as many new users as the rivals.";
});
</script>

<template>
  <section v-if="game.company && market && rivals.length" class="card market-share" aria-labelledby="market-heading" data-testid="market-share">
    <div class="row-between panel-head">
      <h2 id="market-heading">Market share</h2>
      <span class="muted">{{ formatCount(market.companies.reduce((sum, c) => sum + c.users, 0)) }} users in the market</span>
    </div>
    <div class="market-layout">
      <svg
        class="market-pie"
        viewBox="-1.05 -1.05 2.1 2.1"
        role="img"
        :aria-label="market.companies.map((c) => `${c.you ? 'You' : c.name} ${percent(c.share)}`).join(', ')"
        data-testid="market-pie"
      >
        <path v-for="s in slices" :key="s.id" :d="s.d" :class="['market-slice', s.cls]" :data-company="s.id">
          <title>{{ s.name }}: {{ percent(s.share) }}</title>
        </path>
      </svg>
      <table class="mix-table market-table">
        <thead>
          <tr>
            <th scope="col">Company</th>
            <th scope="col" class="num">Share</th>
            <th scope="col" class="num">Users</th>
            <th scope="col" class="num">Price</th>
            <th scope="col" class="num">Quality</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in market.companies" :key="c.id" :data-company="c.id">
            <th scope="row">
              <span :class="['market-swatch', sliceClass(c.id)]" aria-hidden="true"></span>
              {{ c.you ? `${c.name} (you)` : c.name }}
              <small class="muted">{{ c.blurb || `${c.features} features live, ${c.uptime}% uptime` }}</small>
            </th>
            <td class="num" data-testid="market-share-value">{{ percent(c.share) }}</td>
            <td class="num">{{ formatCount(c.users) }}</td>
            <td class="num">{{ formatPrice(c.price) }}</td>
            <td class="num" :title="`${c.features} features, ${c.uptime}% uptime`">{{ Math.round(c.quality) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="mix-caption muted">Who wins each customer type's new users</p>
    <ul class="market-types">
      <li v-for="t in market.byType" :key="t.id" :data-type="t.id">
        <span>{{ t.name }}</span>
        <strong>{{ t.bestId === "you" ? "You" : t.bestName }}</strong>
        <small class="muted">you win {{ percent(t.shares[0] ?? 0) }}</small>
      </li>
    </ul>
    <p>
      New users go mostly to the best value for them. Casual users chase a low price; professionals and businesses pay
      for quality, which comes from your features and uptime. {{ growthNote }}
    </p>
    <p v-if="market.nextReaction" class="wave-note" data-testid="rival-reaction">
      <span class="badge">Rivals</span>
      Rivals take {{ market.reactionDays }} days to answer a price change. They'll answer your
      {{ formatPrice(market.nextReaction.price) }} on day {{ market.nextReaction.day }}, and may undercut it.
    </p>
  </section>
</template>
