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
    <section v-if="companies.length" class="card">
      <h1>Your companies</h1>
      <ul class="company-list">
        <li v-for="c in companies" :key="c.id">
          <RouterLink :to="`/play/${code}/${c.id}`" class="company-row">
            <strong>{{ c.name }}</strong>
            <span class="muted">{{ productName(c.productType) }} · {{ modelName(c.model) }}</span>
            <span>Day {{ c.day }} of {{ c.finalDay }} · {{ formatCash(c.cash) }}</span>
            <span v-if="c.status === 'bankrupt'" class="badge warn-badge">Bankrupt</span>
          </RouterLink>
        </li>
      </ul>
    </section>

    <section class="card">
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
  </template>
</template>
