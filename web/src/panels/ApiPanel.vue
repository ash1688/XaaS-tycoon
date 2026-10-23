<script setup lang="ts">
import { computed } from "vue";
import { formatCash, formatCount } from "../api";
import { days, useGame } from "../game";

// The paid API, on a product that has one: buy it, then watch its calls, what they earn and the APIU they need. Calls
// beyond the APIU are dropped with their income; on SaaS the provider runs it and takes a fee per call.
const game = useGame();
const api = computed(() => game.company?.api ?? null);
const pence = (n: number) => `${Math.round(n * 1000) / 10}p`;
const canAfford = computed(() => !!game.company && !!api.value && game.company.cash >= api.value.price);

// APIU against the calls, as a capacity bar: over 100% means calls are being dropped.
const apiuPercent = computed(() => {
  const u = api.value?.apiu;
  if (!u) return 0;
  return u.capacity > 0 ? Math.round((100 * u.demand) / u.capacity) : u.demand > 0 ? 999 : 0;
});
const level = computed(() => (apiuPercent.value > 100 ? "over" : apiuPercent.value >= 80 ? "high" : "ok"));
// Where to add APIU on this model.
const fix = computed(() =>
  game.managed
    ? "add API instances on the Infrastructure page"
    : `${game.addVerb} API servers, or switch app servers to APIU, on the Infrastructure page`,
);
</script>

<template>
  <section v-if="game.company && api" class="card" aria-labelledby="api-heading" data-testid="api-panel">
    <div class="row-between panel-head">
      <h2 id="api-heading">{{ api.name }}</h2>
      <span class="muted">About {{ pence(api.pricePerCall) }} a call</span>
    </div>
    <p class="muted">{{ api.blurb }}</p>

    <template v-if="!api.owned">
      <p data-testid="api-pitch">
        Other businesses pay about {{ pence(api.pricePerCall) }} for every call to your API. Calls start in the
        thousands a day and grow with your paying users, your uptime and your features. Each call needs capacity:
        <strong>1 APIU serves {{ formatCount(api.callsPerApiu) }} calls a day</strong>, and calls beyond your APIU are
        dropped, with their income.
        <template v-if="api.providerRuns">
          On SaaS the provider runs it for you, so you need no APIU, but it takes a fee for every call.
        </template>
      </p>
      <div class="confirm-buttons">
        <button
          :disabled="game.busy || game.over || !canAfford"
          :title="canAfford ? undefined : `It costs ${formatCash(api.price)} and you have ${formatCash(game.company.cash)}`"
          data-testid="buy-api"
          @click="game.act({ type: 'buyApi' })"
        >
          Buy your {{ api.name }} for {{ formatCash(api.price) }}
        </button>
      </div>
    </template>

    <template v-else>
      <div class="stats">
        <div class="stat">
          <span class="label">Calls a day</span>
          <span class="value" data-testid="api-calls">{{ formatCount(api.calls) }}</span>
          <small>heading for {{ formatCount(api.target) }}</small>
        </div>
        <div class="stat">
          <span class="label">Served</span>
          <span class="value pos" data-testid="api-served">{{ formatCount(api.served) }}</span>
          <small>
            {{ game.lastDay ? `on day ${game.lastDay.day}` : "on the day just played" }}<template v-if="api.dropped">,
              <strong class="warn-text" data-testid="api-dropped">{{ formatCount(api.dropped) }} dropped</strong></template
            >
          </small>
        </div>
        <div class="stat">
          <span class="label">Earns</span>
          <span class="value pos" data-testid="api-income">{{ formatCash(api.dailyIncome) }}</span>
          <small>a day at today's calls<template v-if="api.dailyFee">, less {{ formatCash(api.dailyFee) }} fee</template></small>
        </div>
      </div>

      <template v-if="api.apiu">
        <p class="capacity-note">
          <strong>APIU:</strong> {{ formatCount(api.apiu.demand) }} needed of
          <span data-testid="api-apiu">{{ formatCount(api.apiu.capacity) }}</span>
          ({{ formatCount(api.callsPerApiu) }} calls each)
        </p>
        <div
          class="meter"
          role="meter"
          aria-label="APIU used"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="Math.min(100, apiuPercent)"
          :aria-valuetext="`${apiuPercent}% of your APIU`"
        >
          <div :class="['meter-fill', level]" :style="{ width: `${Math.min(100, apiuPercent)}%` }"></div>
        </div>
        <p v-if="level !== 'ok'" class="warn-text" data-testid="api-full">
          <span class="badge">{{ level === "over" ? "Dropping calls" : "Nearly full" }}</span>
          {{ level === "over" ? "Calls beyond your APIU are dropped, with their income:" : "Before it's full," }}
          {{ fix }}.
        </p>
      </template>
      <p v-else class="capacity-note" data-testid="api-provider">
        <span class="badge provider-badge">Provider runs it</span>
        No APIU needed: the provider serves every call and takes {{ pence(api.feePerCall ?? 0) }} for each, so you keep
        {{ pence(api.pricePerCall - (api.feePerCall ?? 0)) }}.
      </p>
      <p v-if="api.slowDaysLeft" class="warn-text" data-testid="api-slow">
        <span class="badge">Trust knocked</span>
        After the outage, developers trust your API less: calls grow slowly for {{ days(api.slowDaysLeft) }} more.
      </p>
      <p class="muted">
        Calls grow towards what your paying users and features bring, more slowly while calls are dropped. An outage
        loses calls and slows growth for a while.
      </p>
    </template>
    <p v-if="game.error" class="error" role="alert">{{ game.error }}</p>
  </section>
</template>
