<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { DayLog } from "@xaas/sim";
import type { ActionBody, CompanyView, MetaView } from "@xaas/server/api-types";
import { api, formatCash, formatCount, formatUptime } from "../api";

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

    <div class="stats">
      <div class="stat">
        <span class="label">Day</span>
        <span class="value" data-testid="day">{{ company.day }} <small>of {{ company.finalDay }}</small></span>
      </div>
      <div class="stat">
        <span class="label">Cash</span>
        <span class="value" data-testid="cash">{{ formatCash(company.cash) }}</span>
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

    <button class="continue" :disabled="busy" @click="continueDay">Continue</button>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <div v-if="lastDay" class="day-log">
      <h2>Day {{ lastDay.day }}</h2>
      <ul>
        <li v-for="(entry, i) in lastDay.entries" :key="i" :class="{ outage: entry.kind === 'outage' }">
          <template v-if="entry.kind === 'outage'">
            <span class="badge">Outage</span>
            <span data-testid="outage">{{ entry.text }}</span>
          </template>
          <template v-else>
            <span>{{ entry.text }}</span>
            <span :class="entry.cashDelta < 0 ? 'neg' : 'pos'">{{ formatCash(entry.cashDelta) }}</span>
          </template>
        </li>
      </ul>
    </div>
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
            :disabled="busy || company[pool.id] < 1"
            :aria-label="`Let go one ${pool.personName}`"
            @click="act({ type: 'letGo', pool: pool.id })"
          >
            −
          </button>
          <output :data-testid="`${pool.id}-count`" aria-live="polite">{{ company[pool.id] }}</output>
          <button
            class="ghost"
            :disabled="busy"
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
