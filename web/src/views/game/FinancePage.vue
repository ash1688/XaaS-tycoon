<script setup lang="ts">
import { computed, watch } from "vue";
import { formatCash } from "../../api";
import { days, useGame } from "../../game";
import CashChart from "../../components/CashChart.vue";
import CostsFigure from "../../components/CostsFigure.vue";
import SubTabs from "../../components/SubTabs.vue";
import BalanceSheet from "../../panels/BalanceSheet.vue";
import CapTablePanel from "../../panels/CapTablePanel.vue";
import FundingPanel from "../../panels/FundingPanel.vue";
import InvestorPanel from "../../panels/InvestorPanel.vue";
import IpoPanel from "../../panels/IpoPanel.vue";
import LoanPanel from "../../panels/LoanPanel.vue";
import RescuePanel from "../../panels/RescuePanel.vue";
import SpendPanel from "../../panels/SpendPanel.vue";
import ValuationPanel from "../../panels/ValuationPanel.vue";

// Finance: cash and runway, then sub-tabs (the open one in ?tab=): an overview of the balance sheet of income against
// costs, where the money went and cash over time; the valuation and who owns the company; funding, with any rescue
// buyout, investors, friends and family and the grant, and the bank loan; and the IPO readiness checklist, from the Scale
// phase, when the IPO opens (#236). Links about one of these, such as an investor's offer, open its tab. The chart's figures come from the summary
// so far, fetched again only once a new day has been played.
const game = useGame();

type TabId = "overview" | "valuation" | "funding" | "ipo";
const tabs = computed(() => {
  const list: { id: TabId; name: string }[] = [
    { id: "overview", name: "Overview" },
    { id: "valuation", name: "Valuation" },
    { id: "funding", name: "Funding" },
  ];
  if (game.isOpen("ipo")) list.push({ id: "ipo", name: "IPO" });
  return list;
});

watch(
  () => game.company?.day,
  () => game.ensureSummary(),
  { immediate: true },
);
</script>

<template>
  <div v-if="game.company" class="page-grid full">
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
        <div class="stat" data-testid="finance-costs">
          <span class="label">Costs a day</span>
          <span class="value"><CostsFigure /></span>
          <small>Hover for the breakdown</small>
        </div>
        <div v-if="game.company.runway.oneOffsThisWeek > 0" class="stat" data-testid="finance-one-offs">
          <span class="label">One-offs this week</span>
          <span class="value">{{ formatCash(game.company.runway.oneOffsThisWeek) }}</span>
          <small>Not in costs a day</small>
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
            {{ game.company.runway.dailyNet < 0 ? "−" : "+" }}{{ formatCash(Math.abs(game.company.runway.dailyNet)) }} a day
            against the last 7 days' income
          </small>
        </div>
      </div>
      <p class="muted">
        <template v-if="game.company.rescue">
          Below £0 again, the company goes into liquidation and the game ends: there's no second rescue.
        </template>
        <template v-else>
          The first time cash goes below £0, a vulture VC rescues the company for most of its shares; the second time
          is liquidation, and the game ends.
        </template>
        Runway is how long your cash lasts at today's costs against your income averaged over the last 7 days.
        One-offs, such as kit bought or severance, aren't in the daily costs.
      </p>
    </section>
    <SubTabs v-slot="{ current }" name="finance" label="Finance" :tabs="tabs" fallback="overview">
      <div v-if="current === 'overview'" class="page-grid">
        <BalanceSheet />
        <SpendPanel />
        <section class="card" aria-labelledby="cash-chart-heading">
          <h2 id="cash-chart-heading">Cash over time</h2>
          <CashChart v-if="game.summary" :days="game.summary.days" :final-day="game.summary.finalDay" />
          <p v-else class="muted">Loading…</p>
        </section>
      </div>
      <div v-else-if="current === 'valuation'" class="page-grid">
        <ValuationPanel />
        <CapTablePanel />
      </div>
      <div v-else-if="current === 'funding'" class="page-grid">
        <RescuePanel />
        <InvestorPanel />
        <FundingPanel />
        <LoanPanel />
      </div>
      <div v-else class="page-grid">
        <IpoPanel />
      </div>
    </SubTabs>
  </div>
</template>
