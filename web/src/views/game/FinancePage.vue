<script setup lang="ts">
import { watch } from "vue";
import { formatCash } from "../../api";
import { days, useGame } from "../../game";
import CashChart from "../../components/CashChart.vue";
import BalanceSheet from "../../panels/BalanceSheet.vue";
import CapTablePanel from "../../panels/CapTablePanel.vue";
import FundingPanel from "../../panels/FundingPanel.vue";
import LoanPanel from "../../panels/LoanPanel.vue";
import SpendPanel from "../../panels/SpendPanel.vue";
import ValuationPanel from "../../panels/ValuationPanel.vue";

// Finance: cash, the balance sheet of income against costs, the valuation and who owns the company, funding, the bank
// loan, where the money went, and cash over time.
// The chart's figures come from the summary so far, fetched again only once a new day has been played.
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
        <div v-if="game.company.loan?.remaining" class="stat">
          <span class="label">Loan repayment a day</span>
          <span class="value">{{ formatCash(game.company.loan.dailyRepayment) }}</span>
        </div>
        <div v-if="!game.over" class="stat" data-testid="finance-runway">
          <span class="label">Runway</span>
          <span :class="['value', { neg: game.lowCash }]">
            {{
              game.company.runway.days === null
                ? "Not losing money"
                : game.company.runway.days
                  ? days(game.company.runway.days)
                  : "Under a day"
            }}
          </span>
          <small>
            {{ game.company.runway.dailyNet < 0 ? "−" : "+" }}{{ formatCash(Math.abs(game.company.runway.dailyNet)) }} on a
            usual day
          </small>
        </div>
      </div>
      <p class="muted">
        Below £0 the company is bankrupt and the game ends. Runway is how long your cash lasts at today's income and costs.
      </p>
    </section>
    <BalanceSheet />
    <ValuationPanel />
    <CapTablePanel />
    <FundingPanel />
    <LoanPanel />
    <SpendPanel />
    <section class="card" aria-labelledby="cash-chart-heading">
      <h2 id="cash-chart-heading">Cash over time</h2>
      <CashChart v-if="game.summary" :days="game.summary.days" :final-day="game.summary.finalDay" />
      <p v-else class="muted">Loading…</p>
    </section>
  </div>
</template>
