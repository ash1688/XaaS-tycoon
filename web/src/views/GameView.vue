<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { DayLog } from "@xaas/sim";
import type { CompanyView, MetaView } from "@xaas/server/api-types";
import { api, formatCash } from "../api";

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

onMounted(async () => {
  try {
    [meta.value, company.value] = await Promise.all([api.meta(), api.company(props.code, props.id)]);
  } catch (e) {
    error.value = (e as Error).message;
  }
});

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
    </div>

    <button class="continue" :disabled="busy" @click="continueDay">Continue</button>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <div v-if="lastDay" class="day-log">
      <h2>Day {{ lastDay.day }}</h2>
      <ul>
        <li v-for="(entry, i) in lastDay.entries" :key="i">
          <span>{{ entry.text }}</span>
          <span :class="entry.cashDelta < 0 ? 'neg' : 'pos'">{{ formatCash(entry.cashDelta) }}</span>
        </li>
      </ul>
    </div>
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
