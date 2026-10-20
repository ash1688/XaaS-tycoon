<script setup lang="ts">
import { computed } from "vue";
import { SPEND_CATEGORIES, type DayLog } from "@xaas/sim";
import { CATEGORY_LABELS, formatCash } from "../api";

// One day's log: its events (outage, bankruptcy and the like) first, then its income, then its charges grouped by
// category.
// brief: each category's total without its lines, for the Home card.
const props = defineProps<{ log: DayLog; brief?: boolean }>();

const EVENT_LABELS = {
  outage: "Outage",
  bankrupt: "Bankrupt",
  finished: "The end",
  feature: "Feature",
  migration: "Migration",
  event: "Event",
  support: "Support",
  price: "Price",
  conversion: "Free to paid",
  loan: "Loan",
} as const;
const events = computed(() => props.log.entries.filter((e) => !e.category && e.kind !== "income"));
const income = computed(() => props.log.entries.filter((e) => e.kind === "income"));
const incomeTotal = computed(() => income.value.reduce((sum, e) => sum + e.cashDelta, 0));
const groups = computed(() =>
  SPEND_CATEGORIES.map((category) => {
    const entries = props.log.entries.filter((e) => e.category === category);
    return { category, entries, total: entries.reduce((sum, e) => sum + e.cashDelta, 0) };
  }).filter((g) => g.entries.length),
);
const total = computed(() => props.log.entries.reduce((sum, e) => sum + e.cashDelta, 0));
</script>

<template>
  <div :class="['day-log', { brief }]" :data-day="log.day">
    <div class="row-between">
      <h3 class="day-log-title">Day {{ log.day }}</h3>
      <span class="muted">
        Total <strong :class="total < 0 ? 'neg' : 'pos'">{{ formatCash(total) }}</strong>
      </span>
    </div>
    <ul v-if="events.length">
      <li v-for="(entry, i) in events" :key="i" :class="['event', entry.kind]" :data-kind="entry.kind">
        <span class="badge">{{ EVENT_LABELS[(entry.kind as keyof typeof EVENT_LABELS | undefined) ?? "outage"] }}</span>
        <span :data-testid="entry.kind">{{ entry.text }}</span>
      </li>
    </ul>
    <section v-if="income.length" class="log-group income" data-category="income">
      <h4 class="row-between">
        <span>Income</span>
        <span class="pos" data-testid="log-income">+{{ formatCash(incomeTotal) }}</span>
      </h4>
      <ul v-if="!brief">
        <li v-for="(entry, i) in income" :key="i">
          <span>{{ entry.text }}</span>
          <span class="pos">+{{ formatCash(entry.cashDelta) }}</span>
        </li>
      </ul>
    </section>
    <section v-for="group in groups" :key="group.category" :class="['log-group', `cat-${group.category}`]" :data-category="group.category">
      <h4 class="row-between">
        <span>{{ CATEGORY_LABELS[group.category] }}</span>
        <span class="neg">{{ formatCash(group.total) }}</span>
      </h4>
      <ul v-if="!brief">
        <li v-for="(entry, i) in group.entries" :key="i">
          <span>{{ entry.text }}</span>
          <span :class="entry.cashDelta < 0 ? 'neg' : 'pos'">{{ formatCash(entry.cashDelta) }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
