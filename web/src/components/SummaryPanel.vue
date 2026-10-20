<script setup lang="ts">
import { computed } from "vue";
import { SPEND_CATEGORIES, type SpendCategory } from "@xaas/sim";
import type { SummaryView } from "@xaas/server/api-types";
import { formatCash, formatCount, formatUptime } from "../api";
import CostChart from "./CostChart.vue";
import CashChart from "./CashChart.vue";

// How a company did, from its summary. Takes everything it shows as props, so the teacher's dashboard can show it too.
// retired: the student stopped playing it, which the summary's ending can't tell from a game still being played.
const props = defineProps<{ summary: SummaryView; modelName: string; retired?: boolean }>();

const CATEGORY_LABELS: Record<SpendCategory, string> = {
  staff: "Staff",
  infrastructure: "Infrastructure",
  addons: "Add-ons",
};
const share = (c: SpendCategory) =>
  props.summary.totalSpend ? Math.round((100 * props.summary.spend[c]) / props.summary.totalSpend) : 0;
const biggest = computed(() =>
  SPEND_CATEGORIES.reduce((a, b) => (props.summary.spend[b] > props.summary.spend[a] ? b : a)),
);
</script>

<template>
  <section class="card summary" aria-labelledby="summary-heading" data-testid="summary">
    <h2 id="summary-heading">How {{ summary.companyName }} did</h2>
    <p class="muted">
      <template v-if="summary.ending === 'completed'">Played all {{ summary.finalDay }} days</template>
      <template v-else-if="summary.ending === 'bankrupt'">
        Ran out of cash on day {{ summary.day }} of {{ summary.finalDay }}
      </template>
      <template v-else-if="retired">Retired on day {{ summary.day }} of {{ summary.finalDay }}</template>
      <template v-else>So far: day {{ summary.day }} of {{ summary.finalDay }}</template>
      · ended on {{ modelName }}
    </p>

    <div class="stats">
      <div class="stat">
        <span class="label">Final cash</span>
        <span :class="['value', { neg: summary.cash < 0 }]" data-testid="summary-cash">{{ formatCash(summary.cash) }}</span>
      </div>
      <div class="stat">
        <span class="label">Users</span>
        <span class="value" data-testid="summary-users">{{ formatCount(summary.users) }}</span>
        <small>{{ formatCount(summary.paidUsers) }} paying</small>
      </div>
      <div class="stat">
        <span class="label">Income</span>
        <span class="value pos" data-testid="summary-income">{{ formatCash(summary.income) }}</span>
      </div>
      <div class="stat">
        <span class="label">{{ summary.profit < 0 ? "Loss" : "Profit" }}</span>
        <span :class="['value', summary.profit < 0 ? 'neg' : 'pos']" data-testid="summary-profit">
          {{ formatCash(summary.profit) }}
        </span>
      </div>
      <div class="stat">
        <span class="label">Uptime</span>
        <span class="value" data-testid="summary-uptime">{{ formatUptime(summary.uptime) }}</span>
        <small v-if="summary.outageDays">
          {{ summary.outageDays }} outage day{{ summary.outageDays === 1 ? "" : "s" }}
        </small>
      </div>
      <div class="stat">
        <span class="label">Migrations</span>
        <span class="value" data-testid="summary-migrations">{{ summary.migrations }}</span>
      </div>
    </div>

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
