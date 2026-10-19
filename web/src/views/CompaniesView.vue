<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import type { CompanyView, MetaView } from "@xaas/server/api-types";
import { api, formatCash, formatPrice, RequestError } from "../api";

const props = defineProps<{ code: string }>();
const router = useRouter();

const meta = ref<MetaView>();
const companies = ref<CompanyView[]>([]);
const loadError = ref("");

const name = ref("");
const productType = ref("");
const model = ref("");
const formError = ref("");
const nameError = ref("");
const busy = ref(false);

// Only games still being played count towards the limit; finished, bankrupt and retired ones are history.
const active = computed(() => companies.value.filter((c) => c.status === "active"));
const history = computed(() => companies.value.filter((c) => c.status !== "active"));
const atLimit = computed(() => !!meta.value && active.value.length >= meta.value.maxActiveCompanies);
const STATUS_LABELS = { active: "Active", retired: "Retired", bankrupt: "Bankrupt", finished: "Finished" } as const;
const STATUS_BADGES = { active: "", retired: "retired-badge", bankrupt: "warn-badge", finished: "done-badge" } as const;

// Retiring asks first, on the company's own row.
const confirmingRetire = ref<string>();
const retireError = ref("");
const retiring = ref(false);

const productName = (id: string) => meta.value?.productTypes.find((p) => p.id === id)?.name ?? id;
const modelName = (id: string) => meta.value?.models.find((m) => m.id === id)?.name ?? id;
const canStart = computed(() => name.value.trim() && productType.value && model.value && !busy.value);

onMounted(async () => {
  try {
    const [m, c] = await Promise.all([api.meta(), api.code(props.code)]);
    meta.value = m;
    companies.value = c.companies;
  } catch (e) {
    loadError.value = (e as Error).message;
  }
});

async function reload() {
  companies.value = (await api.code(props.code)).companies;
}

function askRetire(id: string) {
  confirmingRetire.value = id;
  retireError.value = "";
}

async function retire(id: string) {
  retireError.value = "";
  retiring.value = true;
  try {
    await api.retire(props.code, id);
    confirmingRetire.value = undefined;
    await reload();
  } catch (e) {
    retireError.value = (e as Error).message;
  } finally {
    retiring.value = false;
  }
}

async function start() {
  formError.value = "";
  nameError.value = "";
  busy.value = true;
  try {
    const company = await api.createCompany(props.code, {
      name: name.value,
      productType: productType.value,
      model: model.value,
    });
    await router.push(`/play/${props.code}/${company.id}`);
  } catch (e) {
    // Name problems show by the name field; anything else above the button.
    if (e instanceof RequestError && e.code.startsWith("name_")) nameError.value = e.message;
    else formError.value = (e as Error).message;
    // Another tab may have started a company meanwhile: refresh the list, which then shows the limit message.
    if (e instanceof RequestError && e.code === "too_many_active") await reload().catch(() => {});
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section v-if="loadError" class="card narrow">
    <p class="error" role="alert">{{ loadError }}</p>
    <RouterLink to="/">Try another code</RouterLink>
  </section>

  <template v-else-if="meta">
    <section v-if="active.length" class="card" aria-labelledby="active-heading" data-testid="active-companies">
      <div class="row-between">
        <h1 id="active-heading">Active</h1>
        <span class="muted">{{ active.length }} of {{ meta.maxActiveCompanies }}</span>
      </div>
      <ul class="company-list">
        <li v-for="c in active" :key="c.id">
          <div class="company-item-main">
            <RouterLink :to="`/play/${code}/${c.id}`" class="company-row">
              <strong>{{ c.name }}</strong>
              <span class="muted">{{ productName(c.productType) }} · {{ modelName(c.model) }}</span>
              <span>Day {{ c.day }} of {{ c.finalDay }} · {{ formatCash(c.cash) }}</span>
            </RouterLink>
            <button
              v-if="confirmingRetire !== c.id"
              class="ghost"
              :aria-label="`Retire ${c.name}`"
              @click="askRetire(c.id)"
            >
              Retire
            </button>
          </div>
          <div v-if="confirmingRetire === c.id" class="retire-confirm" role="group" :aria-label="`Retire ${c.name}?`">
            <p>
              Retire <strong>{{ c.name }}</strong>? It moves to your history: you can still see how it did, but you can't
              play it again.
            </p>
            <p v-if="retireError" class="error" role="alert">{{ retireError }}</p>
            <div class="retire-actions">
              <button :disabled="retiring" @click="retire(c.id)">Yes, retire it</button>
              <button class="ghost" :disabled="retiring" @click="confirmingRetire = undefined">Cancel</button>
            </div>
          </div>
        </li>
      </ul>
    </section>

    <section v-if="atLimit" class="card limit-note" role="status" data-testid="limit-message">
      <h2>You have {{ meta.maxActiveCompanies }} active companies</h2>
      <p>
        That's the most you can run at once. To start a new company, retire one of them first. Retired companies move to
        your history, where you can still see how they did.
      </p>
    </section>

    <section v-else class="card">
      <h2>Start a new company</h2>
      <form @submit.prevent="start" class="stack">
        <label for="name">Company name</label>
        <input
          id="name"
          v-model="name"
          :maxlength="meta.maxCompanyNameLength"
          autocomplete="off"
          :aria-invalid="!!nameError"
          :aria-describedby="nameError ? 'name-error' : undefined"
          @input="nameError = ''"
        />
        <p v-if="nameError" id="name-error" class="error" role="alert">{{ nameError }}</p>

        <fieldset>
          <legend>What are you building?</legend>
          <p class="muted">You build one product for the whole game.</p>
          <div class="choices">
            <label v-for="p in meta.productTypes" :key="p.id" class="choice" :class="{ on: productType === p.id }">
              <input type="radio" name="productType" :value="p.id" v-model="productType" />
              <strong>{{ p.name }}</strong>
              <span class="muted">{{ p.profile }}</span>
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>How will you deploy it?</legend>
          <p class="muted">You can change this later by migrating.</p>
          <div class="table-scroll">
            <table class="compare">
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Upfront cost</th>
                  <th scope="col">Monthly cost</th>
                  <th scope="col">Ops staff needed</th>
                  <th scope="col">Control</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="m in meta.models" :key="m.id" :class="{ on: model === m.id }">
                  <th scope="row">{{ m.name }}</th>
                  <td>
                    {{ m.comparison.upfrontCost }}
                    <span class="muted price">{{ formatCash(m.upfrontCost) }}</span>
                  </td>
                  <td>
                    {{ m.comparison.monthlyCost }}
                    <span class="muted price">
                      {{ formatCash(m.monthlyCost) }}<template v-if="m.monthlyCostPerUser">
                        + {{ formatPrice(m.monthlyCostPerUser) }}/user</template
                      >
                    </span>
                  </td>
                  <td>{{ m.comparison.opsNeeded }}</td>
                  <td>{{ m.comparison.control }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="choices">
            <label v-for="m in meta.models" :key="m.id" class="choice" :class="{ on: model === m.id }">
              <input type="radio" name="model" :value="m.id" v-model="model" />
              <strong>{{ m.name }}</strong>
              <span class="muted">{{ m.blurb }}</span>
            </label>
          </div>
        </fieldset>

        <p class="muted">You start with {{ formatCash(meta.startingCash) }}.</p>
        <p v-if="formError" class="error" role="alert">{{ formError }}</p>
        <button type="submit" :disabled="!canStart">Start company</button>
      </form>
    </section>

    <section v-if="history.length" class="card" aria-labelledby="history-heading" data-testid="history">
      <h2 id="history-heading">History</h2>
      <p class="muted">Games that have ended. Open one to see how it did.</p>
      <ul class="company-list">
        <li v-for="c in history" :key="c.id">
          <RouterLink :to="`/play/${code}/${c.id}`" class="company-row">
            <strong>{{ c.name }}</strong>
            <span class="muted">{{ productName(c.productType) }} · {{ modelName(c.model) }}</span>
            <span>Day {{ c.day }} of {{ c.finalDay }} · {{ formatCash(c.cash) }}</span>
            <span :class="['badge', STATUS_BADGES[c.status]]">{{ STATUS_LABELS[c.status] }}</span>
          </RouterLink>
        </li>
      </ul>
    </section>
  </template>
</template>
