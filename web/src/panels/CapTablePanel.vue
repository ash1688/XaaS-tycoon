<script setup lang="ts">
import { computed } from "vue";
import { formatCash } from "../api";
import { useGame } from "../game";
import { formatShare } from "../shares";

// The cap table: who owns the company, the student first, with a bar of their shares.
const game = useGame();
const table = computed(() => game.company?.capTable ?? null);
</script>

<template>
  <section v-if="table" class="card cat-equity equity-panel" aria-labelledby="cap-table-heading" data-testid="cap-table">
    <h2 id="cap-table-heading">Cap table</h2>
    <div class="cap-bar" aria-hidden="true">
      <span
        v-for="(r, i) in table.rows"
        :key="`${r.id}-${i}`"
        :class="`holder-${i % 6}`"
        :style="{ width: `${r.share * 100}%` }"
        :title="`${r.name}: ${formatShare(r.share)}`"
      ></span>
    </div>
    <div class="table-scroll">
      <table class="balance">
        <thead>
          <tr>
            <th scope="col">Shareholder</th>
            <th scope="col" class="num">Shares</th>
            <th scope="col" class="num">Share</th>
            <th scope="col" class="num">Worth</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in table.rows" :key="`${r.id}-${i}`" :data-testid="`cap-${r.id}`">
            <th scope="row"><span :class="['cap-swatch', `holder-${i % 6}`]" aria-hidden="true"></span>{{ r.name }}</th>
            <td class="num">{{ r.shares.toLocaleString("en-GB") }}</td>
            <td class="num" data-testid="cap-share">{{ formatShare(r.share) }}</td>
            <td class="num">{{ formatCash(r.value) }}</td>
          </tr>
          <tr class="subtotal">
            <th scope="row">Shares in issue</th>
            <td class="num" data-testid="shares-in-issue">{{ table.sharesInIssue.toLocaleString("en-GB") }}</td>
            <td class="num">100%</td>
            <td class="num">{{ formatCash(game.company!.ipo.result?.marketValue ?? game.company!.valuation.valuation) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="muted">
      You keep the same number of shares, but each new shareholder's shares make yours a smaller part of the company.
    </p>
  </section>
</template>
