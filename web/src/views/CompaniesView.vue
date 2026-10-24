<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import type { CompanyView, MetaView } from "@xaas/server/api-types";
import { api, formatCash, formatPrice, RequestError } from "../api";
import LoanTerms from "../components/LoanTerms.vue";

const props = defineProps<{ code: string }>();
const router = useRouter();

const meta = ref<MetaView>();
const companies = ref<CompanyView[]>([]);
const loadError = ref("");

const name = ref("");
const productType = ref("");
const model = ref("");
const takeLoan = ref(false);
// Shares in issue at the start, all the student's. Set to the game's default once meta has loaded.
const shares = ref<number>();
const gameLength = ref("");
const difficulty = ref("");
const formError = ref("");
const nameError = ref("");
const busy = ref(false);

// Only games still being played count towards the limit; finished, liquidated and retired ones are history.
const active = computed(() => companies.value.filter((c) => c.status === "active"));
const history = computed(() => companies.value.filter((c) => c.status !== "active"));
const atLimit = computed(() => !!meta.value && active.value.length >= meta.value.maxActiveCompanies);
const STATUS_LABELS = { active: "Active", retired: "Retired", liquidated: "Liquidated", finished: "Finished" } as const;
const STATUS_BADGES = { active: "", retired: "retired-badge", liquidated: "warn-badge", finished: "done-badge" } as const;

// Retiring asks first, on the company's own row.
const confirmingRetire = ref<string>();
const retireError = ref("");
const retiring = ref(false);

const productName = (id: string) => meta.value?.productTypes.find((p) => p.id === id)?.name ?? id;
const modelName = (id: string) => meta.value?.models.find((m) => m.id === id)?.name ?? id;
// The cash of the student's own the company starts with, which the difficulty sets.
const ownCash = computed(() => {
  const m = meta.value;
  return m?.difficulties.find((d) => d.id === difficulty.value)?.startingCash ?? m?.startingCash ?? 0;
});
// A model that costs more up front than the company would start with can't be picked without the loan: on-prem.
const startCash = computed(() => ownCash.value + (takeLoan.value && meta.value ? meta.value.startLoan.amount : 0));
const chosenModel = computed(() => meta.value?.models.find((m) => m.id === model.value));
// A per-user fee is dearer for a product heavy on compute: priced for the product picked, if one is.
const feeMultiplier = computed(() => meta.value?.productTypes.find((p) => p.id === productType.value)?.perUserFeeMultiplier ?? 1);
const cantAfford = computed(() => !!chosenModel.value && chosenModel.value.upfrontCost > startCash.value);
const sharesOk = computed(() => {
  const m = meta.value;
  const n = shares.value;
  return !!m && typeof n === "number" && Number.isInteger(n) && n >= m.shares.min && n <= m.shares.max;
});
const canStart = computed(
  () => name.value.trim() && productType.value && model.value && sharesOk.value && !cantAfford.value && !busy.value,
);

onMounted(async () => {
  try {
    const [m, c] = await Promise.all([api.meta(), api.code(props.code)]);
    meta.value = m;
    shares.value = m.shares.default;
    companies.value = c.companies;
    gameLength.value = m.gameLengths[0]?.id ?? "";
    difficulty.value = (m.difficulties.find((d) => d.id === "normal") ?? m.difficulties[0])?.id ?? "";
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
      takeLoan: takeLoan.value,
      shares: shares.value,
      gameLength: gameLength.value,
      difficulty: difficulty.value,
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
              <span class="muted">{{ productName(c.productType) }} · {{ modelName(c.model) }} · {{ c.difficultyName }}</span>
              <span>Day {{ c.day }}<template v-if="c.finalDay !== null"> of {{ c.finalDay }}</template> · {{ formatCash(c.cash) }}</span>
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

    <section v-else aria-labelledby="new-company-heading">
      <h2 id="new-company-heading">Start a new company</h2>
      <form @submit.prevent="start" class="new-company-grid">
        <!-- Four cards, two by two: who you are, what you build, where it runs, and how the game is set up. -->
        <div class="card stack" data-testid="card-company">
          <h3>Your company</h3>
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
            <legend>Shares</legend>
            <p class="muted">You own them all to start with. Investors buy new ones, and your share of the company is your score.</p>
            <label for="shares">Shares in issue</label>
            <input
              id="shares"
              v-model.number="shares"
              type="number"
              :min="meta.shares.min"
              :max="meta.shares.max"
              step="1000"
              inputmode="numeric"
              data-testid="shares"
            />
            <small v-if="!sharesOk" class="error" role="alert" data-testid="shares-error">
              Pick a whole number from {{ meta.shares.min.toLocaleString("en-GB") }} to
              {{ meta.shares.max.toLocaleString("en-GB") }}.
            </small>
            <small v-else class="muted">
              From {{ meta.shares.min.toLocaleString("en-GB") }} to {{ meta.shares.max.toLocaleString("en-GB") }}.
            </small>
          </fieldset>

          <fieldset>
            <legend>Bank loan</legend>
            <p class="muted">
              Your own cash is {{ formatCash(ownCash) }}. Borrow now on the bank's best terms, or later for more. One loan at a time.
            </p>
            <label :class="['loan-option', { on: takeLoan }]">
              <input v-model="takeLoan" type="checkbox" data-testid="take-loan" />
              <span>
                <strong>Take a bank loan of {{ formatCash(meta.startLoan.amount) }}</strong>
                <span class="muted">
                  {{ formatCash(meta.startLoan.dailyRepayment) }} a day until day {{ meta.startLoan.lastDay }}
                </span>
              </span>
            </label>
            <details class="loan-details" data-testid="loan-details">
              <summary>Loan terms</summary>
              <LoanTerms :quote="meta.startLoan" />
            </details>
          </fieldset>
        </div>

        <div class="card stack" data-testid="card-product">
          <fieldset>
            <legend>What are you building?</legend>
            <p class="muted">You build one product for the whole game.</p>
            <div class="choices choices-3">
              <label v-for="p in meta.productTypes" :key="p.id" class="choice" :class="{ on: productType === p.id }">
                <input type="radio" name="productType" :value="p.id" v-model="productType" />
                <strong>{{ p.name }}</strong>
                <span class="muted">{{ p.profile }}</span>
              </label>
            </div>
          </fieldset>
        </div>

        <div class="card stack" data-testid="card-deploy">
          <fieldset>
            <legend>How will you deploy it?</legend>
            <p class="muted">You can change this later by migrating.</p>
            <div class="table-scroll">
              <table class="compare">
                <thead>
                  <tr>
                    <th scope="col">Model</th>
                    <th scope="col">Upfront</th>
                    <th scope="col">Monthly</th>
                    <th scope="col">Ops staff</th>
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
                          + {{ formatPrice(m.monthlyCostPerUser * feeMultiplier) }}/user</template
                        >
                      </span>
                    </td>
                    <td>{{ m.comparison.opsNeeded }}</td>
                    <td>{{ m.comparison.control }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="choices choices-2">
              <label v-for="m in meta.models" :key="m.id" class="choice" :class="{ on: model === m.id }" :title="m.blurb">
                <input type="radio" name="model" :value="m.id" v-model="model" />
                <strong>{{ m.name }}</strong>
              </label>
            </div>
          </fieldset>
        </div>

        <div class="card stack" data-testid="card-settings">
          <h3>Game settings</h3>
          <fieldset data-testid="game-lengths">
            <legend>How long will you play?</legend>
            <p class="muted">The game ends on its last day, or sooner if you float on the stock market, it goes into liquidation or your teacher ends it.</p>
            <div class="choices">
              <label v-for="l in meta.gameLengths" :key="l.id" class="choice" :class="{ on: gameLength === l.id }">
                <input type="radio" name="gameLength" :value="l.id" v-model="gameLength" />
                <strong>{{ l.name }}</strong>
                <span class="muted">{{
                  l.finalDay === null ? "Ends only when you float" : `Ends on day ${l.finalDay.toLocaleString("en-GB")}`
                }}</span>
              </label>
            </div>
          </fieldset>

          <fieldset data-testid="difficulties">
            <legend>How hard?</legend>
            <div class="choices">
              <label v-for="d in meta.difficulties" :key="d.id" class="choice" :class="{ on: difficulty === d.id }">
                <input type="radio" name="difficulty" :value="d.id" v-model="difficulty" />
                <strong>{{ d.name }}</strong>
                <span class="muted">{{ d.blurb }} Starting cash {{ formatCash(d.startingCash) }}.</span>
              </label>
            </div>
          </fieldset>

          <p class="muted" data-testid="start-cash">
            You start with {{ formatCash(startCash) }}<template v-if="takeLoan"
              >, {{ formatCash(meta.startLoan.amount) }} of it borrowed</template
            >.
          </p>
          <p v-if="cantAfford" class="error" role="alert" data-testid="cant-afford">
            {{ chosenModel!.name }} costs {{ formatCash(chosenModel!.upfrontCost) }} up front: more than you'd start with.
            {{ takeLoan ? "Pick" : "Take the bank loan, or pick" }} a model that costs less to start.
          </p>
          <p v-if="formError" class="error" role="alert">{{ formError }}</p>
          <button type="submit" :disabled="!canStart">Start company</button>
        </div>
      </form>
    </section>

    <section v-if="history.length" class="card" aria-labelledby="history-heading" data-testid="history">
      <h2 id="history-heading">History</h2>
      <p class="muted">Games that have ended. Open one to see how it did.</p>
      <ul class="company-list">
        <li v-for="c in history" :key="c.id">
          <RouterLink :to="`/play/${code}/${c.id}`" class="company-row">
            <strong>{{ c.name }}</strong>
            <span class="muted">{{ productName(c.productType) }} · {{ modelName(c.model) }} · {{ c.difficultyName }}</span>
            <span>Day {{ c.day }}<template v-if="c.finalDay !== null"> of {{ c.finalDay }}</template> · {{ formatCash(c.cash) }}</span>
            <span :class="['badge', STATUS_BADGES[c.status]]">{{
              c.ipo.status === "floated" ? "Floated" : c.endedByTeacher ? "Ended by teacher" : STATUS_LABELS[c.status]
            }}</span>
          </RouterLink>
        </li>
      </ul>
    </section>
  </template>
</template>
