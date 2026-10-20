<script setup lang="ts">
import { watch } from "vue";
import { formatCash } from "../../api";
import { useGame } from "../../game";
import CashChart from "../../components/CashChart.vue";
import BalanceSheet from "../../panels/BalanceSheet.vue";
import SpendPanel from "../../panels/SpendPanel.vue";

// Finance: cash, the balance sheet of income against costs, where the money went, and cash over time. The chart's figures come from the summary so far, fetched
// again only once a new day has been played.
const game = useGame();
watch(
  () => game.company?.day,
  () => game.ensureSummary(),
  { immediate: true },
);
</script>

<template>
  <div v-if="game.company" class="page-grid">
    <section class="card span-all" aria-labelledby="cash-heading">
      <h2 id="cash-heading">Cash</h2>
      <div class="stats">
        <div class="stat">
          <span class="label">Cash</span>
          <span :class="['value', { neg: game.company.cash < 0 }]" data-testid="cash">
            {{ formatCash(game.company.cash) }}
          </span>
        </div>
        <div class="stat">
          <span class="label">Income a day</span>
          <span class="value pos" data-testid="finance-daily-income">{{ formatCash(game.company.dailyIncome) }}</span>
        </div>
        <div class="stat">
          <span class="label">Staff a day</span>
          <span class="value">{{ formatCash(game.company.dailyStaffCost) }}</span>
        </div>
        <div class="stat">
          <span class="label">Infrastructure a month</span>
          <span class="value">{{ formatCash(game.company.monthlyInfrastructureCost) }}</span>
        </div>
      </div>
      <p class="muted">Below £0 the company is bankrupt and the game ends.</p>
    </section>
    <BalanceSheet />
    <SpendPanel />
    <section class="card" aria-labelledby="cash-chart-heading">
      <h2 id="cash-chart-heading">Cash over time</h2>
      <CashChart v-if="game.summary" :days="game.summary.days" :final-day="game.summary.finalDay" />
      <p v-else class="muted">Loading…</p>
    </section>
  </div>
</template>
