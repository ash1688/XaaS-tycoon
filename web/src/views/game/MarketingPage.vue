<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import type { CampaignView, CustomerTypeId } from "@xaas/sim";
import { formatCash, formatCount, formatPrice } from "../../api";
import { useGame } from "../../game";

// Marketing: open from the first angel investor's approach, whatever the student made of them. The student plans a
// campaign (a customer type, a budget and a length) and it runs from the next day, spending its budget evenly and
// bringing new users of that type directly, on top of normal growth. A pound buys fewer users as the market fills up
// and when another campaign targets the same type; one started just before a holiday works better. Each campaign shows
// its spend, users brought in and cost per user as it runs.
const game = useGame();
const id = useId();
const view = computed(() => game.company?.campaigns ?? null);

const type = ref<CustomerTypeId>("casual");
const budget = ref<number | "">(1_000);
const days = ref<number | "">(14);
watch(
  () => view.value?.minDays,
  (min) => {
    if (min !== undefined && typeof days.value === "number" && days.value < min) days.value = min;
  },
  { immediate: true },
);

const picked = computed(() => view.value?.types.find((t) => t.id === type.value) ?? null);
const budgetOk = computed(
  () => typeof budget.value === "number" && Number.isInteger(budget.value) && !!view.value && budget.value >= view.value.minBudget && budget.value <= view.value.maxBudget,
);
const daysOk = computed(
  () => typeof days.value === "number" && Number.isInteger(days.value) && !!view.value && days.value >= view.value.minDays && days.value <= view.value.maxDays,
);
/** About how many users the planned campaign brings in all, at what a pound buys today. */
const estimate = computed(() => (picked.value && budgetOk.value ? Math.floor((budget.value as number) * picked.value.usersPerPound) : null));
const perDay = computed(() => (budgetOk.value && daysOk.value ? Math.round((budget.value as number) / (days.value as number)) : null));
const tooDear = computed(() => budgetOk.value && !!game.company && (budget.value as number) > game.company.cash);
const canSubmit = computed(() => !!view.value?.canStart && budgetOk.value && daysOk.value && !tooDear.value && !game.busy && !game.over);

const onNow = computed(() => view.value?.campaigns.filter((c) => c.status === "starting" || c.status === "running") ?? []);
const past = computed(() => view.value?.campaigns.filter((c) => c.status === "finished" || c.status === "stopped") ?? []);

const STATUS: Record<CampaignView["status"], string> = { starting: "Starts tomorrow", running: "Running", finished: "Finished", stopped: "Stopped" };
const each = (c: CampaignView) => (c.costPerUser === null ? "—" : formatPrice(c.costPerUser));

function start() {
  if (!canSubmit.value) return;
  void game.actFrom("campaign-start", { type: "startCampaign", customerType: type.value, budget: budget.value as number, days: days.value as number });
}
const stop = (c: CampaignView) => game.actFrom("campaign-stop", { type: "stopCampaign", id: c.id });
</script>

<template>
  <div v-if="game.company && view" class="page-grid single">
    <section class="card cat-campaigns" aria-labelledby="marketing-heading" data-testid="marketing">
      <h2 id="marketing-heading">Marketing</h2>
      <template v-if="view.unlocked">
        <div class="stats">
          <div class="stat">
            <span class="label">Campaigns running</span>
            <span class="value" data-testid="campaigns-running">{{ view.running }} of {{ view.capacity }}</span>
            <small>at once</small>
          </div>
          <div class="stat">
            <span class="label">Market filled</span>
            <span class="value" data-testid="campaigns-market">{{ Math.round(100 * (1 - view.saturation)) }}%</span>
            <small>a fuller market brings fewer users per pound</small>
          </div>
          <div class="stat">
            <span class="label">Spent on campaigns</span>
            <span class="value" data-testid="campaigns-spent">{{ formatCash(game.company.spend.campaigns) }}</span>
            <small>so far</small>
          </div>
        </div>
        <p class="muted">
          A campaign aims at one customer type. It spends its budget evenly over its days and brings new users of that
          type on top of your usual growth. Each type costs its own amount to win: casual users are cheap and businesses
          dear. Two campaigns on the same type at once each bring fewer users per pound, and a campaign started just
          before a holiday brings more.
        </p>
      </template>
      <p v-else class="muted" data-testid="marketing-locked">
        Marketing opens once your company grows up: when your first angel investor approaches.
      </p>
    </section>

    <section v-if="view.unlocked" class="card cat-campaigns" aria-labelledby="campaign-new-heading" data-testid="campaign-new">
      <h3 id="campaign-new-heading">New campaign</h3>
      <form class="price-form" novalidate @submit.prevent="start">
        <label :for="`${id}-type`">Customer type</label>
        <select :id="`${id}-type`" v-model="type" :disabled="!view.canStart || game.over" data-testid="campaign-type">
          <option v-for="t in view.types" :key="t.id" :value="t.id">
            {{ t.name }} · {{ formatPrice(t.costPerUser) }} a user{{ t.running ? ` · ${t.running} running` : "" }}
          </option>
        </select>
        <label :for="`${id}-budget`">Budget (£{{ formatCount(view.minBudget) }}–£{{ formatCount(view.maxBudget) }})</label>
        <input
          :id="`${id}-budget`"
          v-model.number="budget"
          type="number"
          inputmode="numeric"
          :min="view.minBudget"
          :max="view.maxBudget"
          step="100"
          :disabled="!view.canStart || game.over"
          data-testid="campaign-budget"
        />
        <label :for="`${id}-days`">Length in days ({{ view.minDays }}–{{ view.maxDays }})</label>
        <input
          :id="`${id}-days`"
          v-model.number="days"
          type="number"
          inputmode="numeric"
          :min="view.minDays"
          :max="view.maxDays"
          step="1"
          :disabled="!view.canStart || game.over"
          data-testid="campaign-days"
        />
        <p v-if="view.holiday" class="features-note" data-testid="campaign-holiday">
          Started now, it's timed for {{ view.holiday.name }} in {{ view.holiday.daysUntil }} days: ×{{ view.holiday.bonus }}
          users per pound for its whole run.
        </p>
        <p v-if="view.canStart && estimate !== null && perDay !== null" class="muted" data-testid="campaign-estimate">
          About {{ formatCount(estimate) }} {{ picked?.name.toLowerCase() }} at today's market, spending
          {{ formatCash(perDay) }} a day.
          <template v-if="estimate > 0">About {{ formatPrice(Math.round((100 * (budget as number)) / estimate) / 100) }} a user.</template>
        </p>
        <p v-if="tooDear" class="error" role="alert" data-testid="campaign-too-dear">
          That's more than the {{ formatCash(game.company.cash) }} you have.
        </p>
        <p v-if="!view.canStart && view.why" class="muted features-note" data-testid="campaign-why">{{ view.why }}</p>
        <div>
          <button type="submit" :disabled="!canSubmit" data-testid="campaign-start">Start campaign</button>
        </div>
      </form>
      <p v-if="game.error" class="error" role="alert">{{ game.error }}</p>
    </section>

    <section v-if="view.unlocked && view.campaigns.length" class="card cat-campaigns" aria-labelledby="campaigns-heading" data-testid="campaigns">
      <h3 id="campaigns-heading">Campaigns</h3>
      <table class="compare">
        <thead>
          <tr>
            <th scope="col">Aimed at</th>
            <th scope="col">Days</th>
            <th scope="col">Spent</th>
            <th scope="col">Users brought in</th>
            <th scope="col">Cost per user</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in [...onNow, ...past]" :key="c.id" :data-campaign="c.id" :data-status="c.status">
            <td>
              {{ c.customerTypeName }}
              <small v-if="c.holiday" class="muted"> · {{ c.holiday }} bonus</small>
            </td>
            <td data-testid="campaign-days-run">{{ c.daysRun }} of {{ c.days }}</td>
            <td data-testid="campaign-spent">{{ formatCash(c.spent) }} of {{ formatCash(c.budget) }}</td>
            <td data-testid="campaign-users">{{ formatCount(c.users) }}</td>
            <td data-testid="campaign-cost-per-user">{{ each(c) }}</td>
            <td>
              {{ STATUS[c.status] }}
              <button
                v-if="c.status === 'starting' || c.status === 'running'"
                type="button"
                class="ghost"
                :disabled="game.busy || game.over"
                :aria-label="`Stop the campaign for ${c.customerTypeName.toLowerCase()}`"
                @click="stop(c)"
              >
                Stop
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>
