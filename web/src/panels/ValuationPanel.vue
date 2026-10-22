<script setup lang="ts">
import { computed } from "vue";
import { formatCash } from "../api";
import { useGame } from "../game";
import { formatShare, formatSharePrice } from "../shares";

// What the company is worth today, live: the valuation, the share price it sets, and what's pushing it up or down.
// The drivers add up to the valuation.
const game = useGame();
const valuation = computed(() => game.company?.valuation ?? null);
const yours = computed(() => game.company?.capTable.rows.find((r) => r.id === "student") ?? null);
const signed = (n: number) => (n < 0 ? `−${formatCash(-n)}` : `+${formatCash(n)}`);
</script>

<template>
  <section
    v-if="valuation && yours"
    class="card cat-equity equity-panel"
    aria-labelledby="valuation-heading"
    data-testid="valuation-panel"
  >
    <h2 id="valuation-heading">Valuation</h2>
    <div class="stats">
      <div class="stat">
        <span class="label">Valuation</span>
        <span class="value" data-testid="valuation">{{ formatCash(valuation.valuation) }}</span>
        <small>What the company is worth today</small>
      </div>
      <div class="stat">
        <span class="label">Share price</span>
        <span class="value" data-testid="share-price">{{ formatSharePrice(valuation.sharePrice) }}</span>
        <small>{{ valuation.sharesInIssue.toLocaleString("en-GB") }} shares in issue</small>
      </div>
      <div class="stat">
        <span class="label">Your shares</span>
        <span class="value" data-testid="your-share">{{ formatShare(yours.share) }}</span>
        <small>Worth {{ formatCash(yours.value) }}</small>
      </div>
    </div>
    <div class="table-scroll">
      <table class="balance drivers" data-testid="valuation-drivers">
        <caption class="visually-hidden">What's pushing the valuation up or down</caption>
        <tbody>
          <tr v-for="d in valuation.drivers" :key="d.id" :data-testid="`driver-${d.id}`">
            <th scope="row">
              {{ d.label }}
              <small class="muted">{{ d.detail }}</small>
            </th>
            <td :class="['num', { pos: d.amount > 0, neg: d.amount < 0 }]">{{ signed(d.amount) }}</td>
          </tr>
          <tr class="subtotal">
            <th scope="row">Valuation</th>
            <td class="num">{{ formatCash(valuation.valuation) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="muted">
      Revenue counts at a multiple that growth raises and poor satisfaction or uptime lowers. Paying users count too, so
      a high price alone can't make the company worth more. Selling shares while the valuation is low costs you far more
      of the company.
    </p>
  </section>
</template>
