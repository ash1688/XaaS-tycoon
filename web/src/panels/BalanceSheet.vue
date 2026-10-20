<script setup lang="ts">
import { computed } from "vue";
import { SPEND_CATEGORIES } from "@xaas/sim";
import { CATEGORY_LABELS, formatCash } from "../api";
import { useGame } from "../game";

// The balance sheet: income against costs by category, and the profit or loss they leave, for the last day played
// and for the game so far. The day's figures come from the summary so far, which the Finance page keeps fresh.
const game = useGame();
const lastDay = computed(() => game.summary?.days.at(-1));
const costs = (s: Record<(typeof SPEND_CATEGORIES)[number], number>) => SPEND_CATEGORIES.reduce((sum, c) => sum + s[c], 0);
const totalCosts = computed(() => (game.company ? costs(game.company.spend) : 0));
const totalProfit = computed(() => (game.company ? game.company.income - totalCosts.value : 0));
const dayCosts = computed(() => (lastDay.value ? costs(lastDay.value) : 0));
const dayProfit = computed(() => (lastDay.value ? lastDay.value.income - dayCosts.value : 0));
const signed = (n: number) => (n < 0 ? `−${formatCash(-n)}` : formatCash(Math.abs(n)));
</script>

<template>
  <section v-if="game.company" class="card span-all" aria-labelledby="balance-heading" data-testid="balance-sheet">
    <div class="row-between panel-head">
      <h2 id="balance-heading">Balance sheet</h2>
      <span class="muted">
        Income now <strong class="pos">{{ formatCash(game.company.dailyIncome) }}</strong> a day
      </span>
    </div>
    <div class="table-scroll">
      <table class="balance">
        <thead>
          <tr>
            <th scope="col"><span class="visually-hidden">Line</span></th>
            <th scope="col" class="num">{{ lastDay ? `Day ${lastDay.day}` : "Last day" }}</th>
            <th scope="col" class="num">So far</th>
          </tr>
        </thead>
        <tbody>
          <tr class="income-row">
            <th scope="row">Income</th>
            <td class="num pos" data-testid="balance-day-income">{{ formatCash(lastDay?.income ?? 0) }}</td>
            <td class="num pos" data-testid="balance-income">{{ formatCash(game.company.income) }}</td>
          </tr>
          <tr v-for="c in SPEND_CATEGORIES" :key="c" :class="['cost-row', `cat-${c}`]">
            <th scope="row"><span class="swatch" aria-hidden="true"></span>{{ CATEGORY_LABELS[c] }}</th>
            <td class="num">{{ signed(-(lastDay?.[c] ?? 0)) }}</td>
            <td class="num" :data-testid="`balance-${c}`">{{ signed(-game.company.spend[c]) }}</td>
          </tr>
          <tr class="subtotal">
            <th scope="row">Costs</th>
            <td class="num">{{ signed(-dayCosts) }}</td>
            <td class="num">{{ signed(-totalCosts) }}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Profit or loss</th>
            <td :class="['num', dayProfit < 0 ? 'neg' : 'pos']" data-testid="balance-day-profit">
              {{ signed(dayProfit) }}
            </td>
            <td :class="['num', totalProfit < 0 ? 'neg' : 'pos']" data-testid="balance-profit">
              {{ signed(totalProfit) }}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
    <p class="muted">
      Income is what paying users pay, a day's share of the monthly price each. Profit is income less every cost. Day 1
      includes any upfront cost of your model.
    </p>
  </section>
</template>
