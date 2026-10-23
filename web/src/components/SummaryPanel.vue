<script setup lang="ts">
import { computed } from "vue";
import { SPEND_CATEGORIES, type SpendCategory } from "@xaas/sim";
import type { SummaryView } from "@xaas/server/api-types";
import { formatCash, formatCount, formatUptime } from "../api";
import { dayOf } from "../game";
import { formatShare, formatSharePrice } from "../shares";
import CostChart from "./CostChart.vue";
import CashChart from "./CashChart.vue";
import IncomeChart from "./IncomeChart.vue";

// How a company did, from its summary. Takes everything it shows as props, so the teacher's dashboard can show it too.
// retired: the student stopped playing it, which the summary's ending can't tell from a game still being played.
const props = defineProps<{ summary: SummaryView; modelName: string; retired?: boolean }>();

const CATEGORY_LABELS: Record<SpendCategory, string> = {
  staff: "Staff",
  infrastructure: "Infrastructure",
  cabling: "Cabling",
  power: "Power and cooling",
  addons: "Add-ons",
  debt: "Debt",
};
const share = (c: SpendCategory) =>
  props.summary.totalSpend ? Math.round((100 * props.summary.spend[c]) / props.summary.totalSpend) : 0;
const loss = computed(() => props.summary.profit < 0);
// The sign says profit or loss as well as the colour and the label.
const signed = (n: number) => `${n < 0 ? "−" : "+"}${formatCash(Math.abs(n))}`;
const free = (users: number, paid: number) => users - paid;
const loan = computed(() => props.summary.loan);
const biggest = computed(() =>
  SPEND_CATEGORIES.reduce((a, b) => (props.summary.spend[b] > props.summary.spend[a] ? b : a)),
);
</script>

<template>
  <section class="card summary" aria-labelledby="summary-heading" data-testid="summary">
    <h2 id="summary-heading">How {{ summary.companyName }} did</h2>
    <p class="muted">
      <template v-if="summary.ending === 'completed'">Played all {{ summary.finalDay }} days</template>
      <template v-else-if="summary.ending === 'ipo'">Floated on {{ dayOf(summary.day, summary.finalDay) }}</template>
      <template v-else-if="summary.ending === 'liquidation'">
        Went into liquidation on {{ dayOf(summary.day, summary.finalDay) }}
      </template>
      <template v-else-if="summary.ending === 'ended'">Ended by the teacher on {{ dayOf(summary.day, summary.finalDay) }}</template>
      <template v-else-if="retired">Retired on {{ dayOf(summary.day, summary.finalDay) }}</template>
      <template v-else>So far: {{ dayOf(summary.day, summary.finalDay) }}</template>
      · ended on {{ modelName }}
    </p>
    <p v-if="summary.rescue" class="muted" data-testid="summary-rescue">
      Rescued by a vulture VC on day {{ summary.rescue.day }}: {{ formatCash(summary.rescue.amount) }} for
      {{ Math.round(summary.rescue.share * 100) }}% of the company<template v-if="summary.rescue.boughtBack">,
        bought back on day {{ summary.rescue.boughtBack.day }} for {{ formatCash(summary.rescue.boughtBack.price) }}</template>.
    </p>

    <div :class="['summary-headline', loss ? 'loss' : 'profit']" data-testid="summary-headline">
      <span class="headline-label" data-testid="summary-result">{{ loss ? "Loss" : "Profit" }}</span>
      <span class="headline-value" data-testid="summary-profit">{{ signed(summary.profit) }}</span>
      <span class="headline-sum">
        Income <strong data-testid="summary-income">{{ formatCash(summary.income) }}</strong>
        − costs <strong data-testid="summary-costs">{{ formatCash(summary.costs) }}</strong>
      </span>
    </div>

    <div v-if="summary.ipo" class="stats ipo-stats" data-testid="summary-ipo">
      <div class="stat">
        <span class="label">Cash raised</span>
        <span class="value">{{ formatCash(summary.ipo.cashRaised) }}</span>
        <small>{{ formatShare(summary.ipo.float) }} floated at {{ formatSharePrice(summary.ipo.offerPrice) }} a share</small>
      </div>
      <div class="stat">
        <span class="label">Market value at the close</span>
        <span class="value" data-testid="summary-market-value">{{ formatCash(summary.ipo.marketValue) }}</span>
        <small>closed at {{ formatSharePrice(summary.ipo.closePrice) }}</small>
      </div>
      <div class="stat">
        <span class="label">Your stake</span>
        <span class="value">{{ formatCash(summary.ipo.studentValue) }}</span>
        <small>{{ formatShare(summary.ipo.studentShare) }} of the company</small>
      </div>
    </div>

    <div class="stats">
      <div class="stat">
        <span class="label">Final cash</span>
        <span :class="['value', { neg: summary.cash < 0 }]" data-testid="summary-cash">{{ formatCash(summary.cash) }}</span>
      </div>
      <div class="stat">
        <span class="label">Peak users</span>
        <span class="value" data-testid="summary-peak">{{ formatCount(summary.peak.users) }}</span>
        <small data-testid="summary-peak-split">
          day {{ summary.peak.day }}: {{ formatCount(summary.peak.paidUsers) }} paying,
          {{ formatCount(free(summary.peak.users, summary.peak.paidUsers)) }} free
        </small>
      </div>
      <div class="stat">
        <span class="label">Users at the end</span>
        <span class="value" data-testid="summary-users">{{ formatCount(summary.users) }}</span>
        <small>
          {{ formatCount(summary.paidUsers) }} paying, {{ formatCount(free(summary.users, summary.paidUsers)) }} free
        </small>
      </div>
      <div class="stat">
        <span class="label">Satisfaction</span>
        <span class="value" data-testid="summary-satisfaction">{{ Math.round(summary.satisfaction) }}%</span>
        <small>on average</small>
      </div>
      <div class="stat">
        <span class="label">Uptime</span>
        <span class="value" data-testid="summary-uptime">{{ formatUptime(summary.uptime) }}</span>
        <small>
          on average<template v-if="summary.outageDays">
            · {{ summary.outageDays }} outage day{{ summary.outageDays === 1 ? "" : "s" }}</template>
        </small>
      </div>
      <div class="stat">
        <span class="label">Price changes</span>
        <span class="value" data-testid="summary-price-changes">{{ summary.priceChanges }}</span>
      </div>
      <div class="stat">
        <span class="label">Migrations</span>
        <span class="value" data-testid="summary-migrations">{{ summary.migrations }}</span>
      </div>
      <div class="stat">
        <span class="label">{{ loan && loan.loans > 1 ? `${loan.loans} bank loans` : "Bank loan" }}</span>
        <template v-if="loan">
          <span class="value" data-testid="summary-loan">{{ formatCash(loan.amount) }}</span>
          <small data-testid="summary-loan-status">
            {{ loan.day === 1 ? "first taken at the start" : `first taken on day ${loan.day}` }} ·
            {{ loan.fullyRepaid ? "repaid in full" : `${formatCash(loan.remaining)} still owed` }} ·
            <span data-testid="summary-loan-interest">{{ formatCash(loan.interestPaid) }} interest</span>
            <template v-if="loan.interestSaved">
              · <span data-testid="summary-loan-saved">{{ formatCash(loan.interestSaved) }} saved by paying early</span>
            </template>
          </small>
        </template>
        <template v-else>
          <span class="value" data-testid="summary-loan">None</span>
          <small data-testid="summary-loan-status">not taken</small>
        </template>
      </div>
    </div>

    <h3 class="summary-subhead">Income against costs</h3>
    <p class="muted summary-note">
      Everything paying users paid, and everything you spent, added up day by day. While the income line is above the
      costs line you're in profit overall; the gap at the end is your {{ loss ? "loss" : "profit" }}.
      <template v-if="loan">
        Of the loan repayments only the interest is a cost: paying back what you borrowed isn't, as borrowing it wasn't
        income.
      </template>
    </p>
    <IncomeChart :days="summary.incomeVsCosts" :final-day="summary.finalDay" />

    <h3 class="row-between summary-subhead">
      <span>Where the money went</span>
      <span class="muted">
        Total <strong data-testid="summary-spend-total">{{ formatCash(summary.totalSpend) }}</strong>
      </span>
    </h3>
    <div v-if="summary.totalSpend" class="spend-bar" aria-hidden="true">
      <span
        v-for="c in SPEND_CATEGORIES"
        :key="c"
        :class="`cat-${c}`"
        :style="{ width: `${(100 * summary.spend[c]) / summary.totalSpend}%` }"
      ></span>
    </div>
    <ul class="spend-list">
      <li v-for="c in SPEND_CATEGORIES" :key="c" :class="`cat-${c}`">
        <span class="swatch"></span>
        <span class="spend-name">{{ CATEGORY_LABELS[c] }}</span>
        <span class="muted" :data-testid="`summary-share-${c}`">{{ share(c) }}%</span>
        <strong :data-testid="`summary-spend-${c}`">{{ formatCash(summary.spend[c]) }}</strong>
      </li>
    </ul>
    <p v-if="summary.totalSpend" class="muted summary-note">
      {{ CATEGORY_LABELS[biggest] }} took the biggest share, {{ share(biggest) }}%.
    </p>

    <h3 class="summary-subhead">Cost over time</h3>
    <p class="muted summary-note">
      What you spent each day. Tall bars are days when spending jumped: buying kit upfront, the first day of a migration,
      or the bill for an event. Hover over a bar for the day's figures.
    </p>
    <CostChart :days="summary.days" :final-day="summary.finalDay" :labels="CATEGORY_LABELS" />

    <h3 class="summary-subhead">Cash over time</h3>
    <CashChart :days="summary.days" :final-day="summary.finalDay" />
  </section>
</template>
