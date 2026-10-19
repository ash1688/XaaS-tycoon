<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { SPEND_CATEGORIES, type DayLog, type SpendCategory } from "@xaas/sim";
import type { ActionBody, CompanyView, MetaView } from "@xaas/server/api-types";
import { api, formatCash, formatCount, formatPrice, formatUptime } from "../api";

const props = defineProps<{ code: string; id: string }>();

const meta = ref<MetaView>();
const company = ref<CompanyView>();
const lastDay = ref<DayLog>();
const error = ref("");
const busy = ref(false);

const productName = (id: string) => meta.value?.productTypes.find((p) => p.id === id)?.name ?? id;
const modelName = (id: string) => meta.value?.models.find((m) => m.id === id)?.name ?? id;
// Top layer first, so the stack reads like the diagram: your data on top, the building at the bottom.
const stack = computed(() => meta.value?.models.find((m) => m.id === company.value?.model)?.stack.toReversed() ?? []);
const OWNER_LABELS = { you: "You", provider: "Provider", shared: "Shared" } as const;
const understaffed = computed(() => !!company.value && company.value.ops < company.value.opsNeeded);
const loadPercent = computed(() => (company.value ? Math.round((100 * company.value.load) / company.value.capacity) : 0));
// Over 100% is an outage; close to it is a warning that one is coming.
const loadLevel = computed(() => (loadPercent.value > 100 ? "over" : loadPercent.value >= 80 ? "high" : "ok"));

const bankrupt = computed(() => company.value?.status === "bankrupt");
const currentModel = computed(() => meta.value?.models.find((m) => m.id === company.value?.model));

const CATEGORY_LABELS: Record<SpendCategory, string> = {
  staff: "Staff",
  infrastructure: "Infrastructure",
  addons: "Add-ons",
};
const spendTotal = computed(() =>
  company.value ? SPEND_CATEGORIES.reduce((sum, c) => sum + company.value!.spend[c], 0) : 0,
);
const spendShare = (c: SpendCategory) =>
  spendTotal.value ? Math.round((100 * company.value!.spend[c]) / spendTotal.value) : 0;

// The day's events (outage, bankruptcy) first, then its charges grouped by category.
const lastDayEvents = computed(() => lastDay.value?.entries.filter((e) => !e.category) ?? []);
const lastDayGroups = computed(() =>
  SPEND_CATEGORIES.map((category) => {
    const entries = lastDay.value?.entries.filter((e) => e.category === category) ?? [];
    return { category, entries, total: entries.reduce((sum, e) => sum + e.cashDelta, 0) };
  }).filter((g) => g.entries.length),
);
const lastDayTotal = computed(() => lastDay.value?.entries.reduce((sum, e) => sum + e.cashDelta, 0) ?? 0);

onMounted(async () => {
  try {
    [meta.value, company.value] = await Promise.all([api.meta(), api.company(props.code, props.id)]);
  } catch (e) {
    error.value = (e as Error).message;
  }
});

async function act(action: ActionBody) {
  busy.value = true;
  error.value = "";
  try {
    company.value = await api.act(props.code, props.id, action);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function continueDay() {
  busy.value = true;
  error.value = "";
  try {
    const result = await api.continueDay(props.code, props.id);
    company.value = result.company;
    lastDay.value = result.log.at(-1);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <p class="back"><RouterLink :to="`/play/${code}`">← Your companies</RouterLink></p>

  <section v-if="company" class="card">
    <h1>{{ company.name }}</h1>
    <p class="muted">{{ productName(company.productType) }} · {{ modelName(company.model) }}</p>

    <div v-if="bankrupt" class="bankrupt" role="alert" data-testid="bankrupt-screen">
      <span class="badge">Bankrupt</span>
      <h2>Game over: you ran out of cash</h2>
      <p>
        {{ company.name }} went below £0 on day {{ company.day }}, so the game has ended. You can't continue or change
        staff. Look at where your money went below, then
        <RouterLink :to="`/play/${code}`">start a new company</RouterLink> and try a different plan.
      </p>
    </div>

    <div class="stats">
      <div class="stat">
        <span class="label">Day</span>
        <span class="value" data-testid="day">{{ company.day }} <small>of {{ company.finalDay }}</small></span>
      </div>
      <div class="stat">
        <span class="label">Cash</span>
        <span :class="['value', { neg: company.cash < 0 }]" data-testid="cash">{{ formatCash(company.cash) }}</span>
      </div>
      <div class="stat">
        <span class="label">Users</span>
        <span class="value" data-testid="users">{{ formatCount(company.users) }}</span>
      </div>
      <div class="stat">
        <span class="label">Uptime</span>
        <span class="value" data-testid="uptime">{{ formatUptime(company.uptime) }}</span>
        <small v-if="company.outageDays">{{ company.outageDays }} outage day{{ company.outageDays === 1 ? "" : "s" }}</small>
      </div>
    </div>

    <div class="capacity" data-testid="capacity">
      <div class="row-between">
        <span id="capacity-label" class="label">Load vs capacity</span>
        <span class="figures">{{ formatCount(company.load) }} / {{ formatCount(company.capacity) }}</span>
      </div>
      <div
        class="meter"
        role="meter"
        aria-labelledby="capacity-label"
        aria-valuemin="0"
        :aria-valuemax="company.capacity"
        :aria-valuenow="company.load"
        :aria-valuetext="`${loadPercent}% of capacity`"
      >
        <div :class="['meter-fill', loadLevel]" :style="{ width: `${Math.min(100, loadPercent)}%` }"></div>
      </div>
      <p :class="['capacity-note', loadLevel]">
        <strong>{{ loadPercent }}%</strong> of capacity used.
        <template v-if="loadLevel === 'over'">Over capacity: expect outages.</template>
        <template v-else-if="loadLevel === 'high'">Getting close: an outage is coming if load keeps rising.</template>
        <template v-else>Load over 100% causes an outage.</template>
      </p>
    </div>

    <button class="continue" :disabled="busy || bankrupt" @click="continueDay">Continue</button>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <div v-if="lastDay" class="day-log" data-testid="day-log">
      <div class="row-between">
        <h2>Day {{ lastDay.day }}</h2>
        <span class="muted">
          Total <strong :class="lastDayTotal < 0 ? 'neg' : 'pos'">{{ formatCash(lastDayTotal) }}</strong>
        </span>
      </div>
      <ul v-if="lastDayEvents.length">
        <li v-for="(entry, i) in lastDayEvents" :key="i" :class="['event', entry.kind]">
          <span class="badge">{{ entry.kind === "bankrupt" ? "Bankrupt" : "Outage" }}</span>
          <span :data-testid="entry.kind">{{ entry.text }}</span>
        </li>
      </ul>
      <section
        v-for="group in lastDayGroups"
        :key="group.category"
        :class="['log-group', `cat-${group.category}`]"
        :data-category="group.category"
      >
        <h3 class="row-between">
          <span>{{ CATEGORY_LABELS[group.category] }}</span>
          <span class="neg">{{ formatCash(group.total) }}</span>
        </h3>
        <ul>
          <li v-for="(entry, i) in group.entries" :key="i">
            <span>{{ entry.text }}</span>
            <span :class="entry.cashDelta < 0 ? 'neg' : 'pos'">{{ formatCash(entry.cashDelta) }}</span>
          </li>
        </ul>
      </section>
    </div>
  </section>

  <section v-if="company" class="card" aria-labelledby="spend-heading" data-testid="spend">
    <div class="row-between">
      <h2 id="spend-heading">Spend so far</h2>
      <span class="muted">
        Total <strong data-testid="spend-total">{{ formatCash(spendTotal) }}</strong>
      </span>
    </div>
    <div v-if="spendTotal" class="spend-bar" aria-hidden="true">
      <span
        v-for="c in SPEND_CATEGORIES"
        :key="c"
        :class="`cat-${c}`"
        :style="{ width: `${(100 * company.spend[c]) / spendTotal}%` }"
      ></span>
    </div>
    <ul class="spend-list">
      <li v-for="c in SPEND_CATEGORIES" :key="c" :class="`cat-${c}`">
        <span class="swatch"></span>
        <span class="spend-name">{{ CATEGORY_LABELS[c] }}</span>
        <span class="muted">{{ spendShare(c) }}%</span>
        <strong :data-testid="`spend-${c}`">{{ formatCash(company.spend[c]) }}</strong>
      </li>
    </ul>
    <p v-if="currentModel" class="muted model-costs" data-testid="model-costs">
      {{ currentModel.name }}: {{ formatCash(currentModel.upfrontCost) }} upfront when you start, then
      {{ formatCash(currentModel.monthlyCost) }} a month<template v-if="currentModel.monthlyCostPerUser">
        plus {{ formatPrice(currentModel.monthlyCostPerUser) }} per user</template
      >, billed a day at a time. At today's users that's
      <strong>{{ formatCash(company.monthlyInfrastructureCost) }}</strong> a month.
    </p>
  </section>

  <section v-if="company && meta" class="card" aria-labelledby="staff-heading">
    <div class="row-between">
      <h2 id="staff-heading">Staff</h2>
      <span class="muted">
        Total <strong data-testid="staff-cost">{{ formatCash(company.dailyStaffCost) }}</strong> a day
      </span>
    </div>
    <ul class="staff">
      <li v-for="pool in meta.staff" :key="pool.id" :data-pool="pool.id">
        <div class="staff-info">
          <strong>{{ pool.name }}</strong>
          <span class="muted">{{ formatCash(pool.dayRate) }} each a day</span>
        </div>
        <div class="counter">
          <button
            class="ghost"
            :disabled="busy || bankrupt || company[pool.id] < 1"
            :aria-label="`Let go one ${pool.personName}`"
            @click="act({ type: 'letGo', pool: pool.id })"
          >
            −
          </button>
          <output :data-testid="`${pool.id}-count`" aria-live="polite">{{ company[pool.id] }}</output>
          <button
            class="ghost"
            :disabled="busy || bankrupt"
            :aria-label="`Hire one ${pool.personName}`"
            @click="act({ type: 'hire', pool: pool.id })"
          >
            +
          </button>
        </div>
      </li>
    </ul>
    <p :class="['ops-needed', { warn: understaffed }]" data-testid="ops-needed">
      <span>{{ modelName(company.model) }} needs <strong>{{ company.opsNeeded }}</strong> ops staff.</span>
      <span v-if="understaffed" class="badge">
        Understaffed: {{ company.opsNeeded - company.ops }} short, capacity cut
      </span>
    </p>
  </section>

  <section v-else-if="error" class="card narrow">
    <p class="error" role="alert">{{ error }}</p>
  </section>

  <section v-if="company && stack.length" class="card">
    <h2>Who looks after what</h2>
    <p class="teaching-line">
      Whatever you pick, your customers get your product as SaaS. You're the customer of the layer below.
    </p>
    <ul class="legend" aria-label="Key">
      <li v-for="(label, owner) in OWNER_LABELS" :key="owner"><span :class="['swatch', owner]"></span>{{ label }}</li>
    </ul>
    <ol class="resp-stack" data-testid="stack">
      <li v-for="layer in stack" :key="layer.id" :class="layer.owner" :data-layer="layer.id">
        <span>{{ layer.name }}</span>
        <strong>{{ OWNER_LABELS[layer.owner] }}</strong>
      </li>
    </ol>
  </section>
</template>
