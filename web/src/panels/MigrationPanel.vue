<script setup lang="ts">
import { computed, ref } from "vue";
import type { ModelId } from "@xaas/sim";
import type { MigrationQuoteView } from "@xaas/server/api-types";
import { api, formatCash } from "../api";
import { days, namesList, useGame } from "../game";

// Migration: pick a target, see the quote and confirm, then it runs in the background while you keep playing.
const game = useGame();
const migrationTarget = ref<ModelId>();
const confirmingMigration = ref(false);
const quote = ref<MigrationQuoteView>();
const migrationTargets = computed(() => game.meta?.models.filter((m) => m.id !== game.company?.model) ?? []);
const targetModel = computed(() => game.meta?.models.find((m) => m.id === migrationTarget.value));
const migrationDays = computed(() => game.meta?.migrationPhases.reduce((sum, p) => sum + p.days, 0) ?? 0);
const phaseName = (id: string) => game.meta?.migrationPhases.find((p) => p.id === id)?.name ?? id;
const phaseIndex = computed(() => game.meta?.migrationPhases.findIndex((p) => p.id === game.migration?.phase) ?? -1);
const phaseState = (i: number) => (i < phaseIndex.value ? "done" : i === phaseIndex.value ? "current" : "next");
// An overrun adds its days to moving infrastructure.
const phaseDays = (phase: { id: string; days: number }) =>
  phase.days + (phase.id === "moving" ? (game.migration?.overrunDays ?? 0) : 0);
// Each charge the migration brings, in the order they land. Every one is infrastructure.
const quoteRows = computed(() => {
  const q = quote.value;
  if (!q) return [];
  const [from, to] = [game.modelName(q.from), game.modelName(q.to)];
  return [
    { id: "upfront", label: "New setup", detail: `${to} upfront cost, on the first day`, amount: q.upfrontCost },
    {
      id: "double",
      label: "Double billing",
      detail: `${to} billed in full for ${days(q.days)}, on top of ${from}`,
      amount: q.doubleBilling,
    },
    { id: "pro-rata", label: "Pro rata", detail: `${from} billed up to the day you leave`, amount: q.proRata },
    { id: "exit", label: "Exit penalty", detail: `${from} charges once for leaving`, amount: q.exitPenalty },
  ];
});
// Per-user fees are priced at today's users, so they're an estimate if users grow.
const quotePerUser = computed(() =>
  [quote.value?.from, quote.value?.to].some(
    (id) => (game.meta?.models.find((m) => m.id === id)?.monthlyCostPerUser ?? 0) > 0,
  ),
);
// Vendor lock-in: add-ons are the SaaS provider's, so leaving SaaS leaves them behind, to rebuild in developer-days.
const lostAddons = computed(() => quote.value?.lostAddons ?? []);
const rebuildDays = computed(() => lostAddons.value.reduce((sum, a) => sum + a.devDays, 0));
// While leaving SaaS, the add-ons that go when the move completes.
const addonsAtRisk = computed(() =>
  game.migration?.from === "saas" && game.migration.to !== "saas"
    ? (game.company?.features.filter((f) => f.status === "addon") ?? [])
    : [],
);

function pickTarget(id: ModelId) {
  migrationTarget.value = id;
  confirmingMigration.value = false;
  quote.value = undefined;
}

// Fetches the quote for the confirm step, so the student sees what it costs before committing.
async function planMigration() {
  if (!migrationTarget.value) return;
  game.busy = true;
  game.error = "";
  try {
    quote.value = await api.migrationQuote(game.code, game.id, migrationTarget.value);
    confirmingMigration.value = true;
  } catch (e) {
    game.error = (e as Error).message;
  } finally {
    game.busy = false;
  }
}

async function startMigration() {
  if (!migrationTarget.value) return;
  await game.act({ type: "startMigration", model: migrationTarget.value });
  if (game.migration) {
    migrationTarget.value = undefined;
    confirmingMigration.value = false;
    quote.value = undefined;
  }
}
</script>

<template>
  <section v-if="game.company && game.meta" class="card" aria-labelledby="migration-heading" data-testid="migration-panel">
    <div class="row-between panel-head">
      <h2 id="migration-heading">Migration</h2>
      <span class="muted" data-testid="migration-count">{{ game.company.migrations }} completed</span>
    </div>
    <template v-if="game.migration">
      <p class="migration-route">
        Moving from <strong>{{ game.modelName(game.migration.from) }}</strong> to
        <strong data-testid="migration-target">{{ game.modelName(game.migration.to) }}</strong>
      </p>
      <ol class="phases" aria-label="Migration phases">
        <li
          v-for="(phase, i) in game.meta.migrationPhases"
          :key="phase.id"
          :class="phaseState(i)"
          :data-phase="phase.id"
          :aria-current="phaseState(i) === 'current' ? 'step' : undefined"
        >
          <strong>{{ phase.name }}</strong>
          <span class="muted">{{ phaseState(i) === "done" ? "Done" : days(phaseDays(phase)) }}</span>
        </li>
      </ol>
      <div
        class="meter"
        role="progressbar"
        aria-labelledby="migration-heading"
        aria-valuemin="0"
        :aria-valuemax="game.migration.totalDays"
        :aria-valuenow="game.migration.totalDays - game.migration.daysLeft"
        :aria-valuetext="`${game.migration.totalDays - game.migration.daysLeft} of ${game.migration.totalDays} days`"
      >
        <div
          class="meter-fill building"
          :style="{ width: `${(100 * (game.migration.totalDays - game.migration.daysLeft)) / game.migration.totalDays}%` }"
        ></div>
      </div>
      <p class="migration-status" data-testid="migration-status">
        <span>
          <strong data-testid="migration-phase">{{ phaseName(game.migration.phase) }}</strong>:
          <span data-testid="migration-phase-days">{{ days(game.migration.phaseDaysLeft) }} left</span> in this phase
        </span>
        <span>
          Switch to {{ game.modelName(game.migration.to) }} in
          <strong data-testid="migration-days-left">{{ days(game.migration.daysLeft) }}</strong>
        </span>
      </p>
      <p v-if="game.migration.overrunDays" class="overrun" role="status" data-testid="migration-overrun">
        <span class="badge">Overrun</span>
        <span>
          Moving infrastructure is taking <strong>{{ days(game.migration.overrunDays) }}</strong> longer than planned,
          and both providers bill for every extra day.
        </span>
      </p>
      <p class="muted migration-note">
        It runs in the background: your staff aren't tied up. You stay on {{ game.modelName(game.migration.from) }}
        until the move completes, paying for it and for {{ game.modelName(game.migration.to) }} at the same time.
      </p>
      <p v-if="addonsAtRisk.length" class="warn-text migration-note" data-testid="addons-at-risk">
        Your add-ons ({{ namesList(addonsAtRisk.map((f) => f.name)) }}) keep working, and keep being billed, until the
        move completes. Then they stay behind with the SaaS provider.
      </p>
    </template>
    <p v-else-if="game.over" class="muted migration-note">
      The game has ended, so there's no more migrating. It ended on {{ game.modelName(game.company.model) }}.
    </p>
    <template v-else>
      <p class="muted migration-note">
        Change deployment model at any time. A migration takes {{ days(migrationDays) }}
        ({{ game.meta.migrationPhases.map((p) => `${p.name.toLowerCase()} ${p.days}`).join(", ") }}) and runs in the
        background, so your staff stay free. Your product stays the same.
      </p>
      <fieldset :disabled="game.busy">
        <legend>Migrate to</legend>
        <div class="choices">
          <label v-for="m in migrationTargets" :key="m.id" :class="['choice', { on: migrationTarget === m.id }]">
            <input
              type="radio"
              name="migration-target"
              :value="m.id"
              :checked="migrationTarget === m.id"
              @change="pickTarget(m.id)"
            />
            <strong>{{ m.name }}</strong>
            <span class="muted">Needs {{ m.opsNeeded }} ops staff · {{ m.comparison.control }} control</span>
          </label>
        </div>
      </fieldset>
      <button
        v-if="!confirmingMigration"
        class="plan-migration"
        :disabled="game.busy || !targetModel"
        @click="planMigration"
      >
        Plan migration
      </button>
      <div v-else-if="targetModel && quote" class="confirm" role="group" aria-labelledby="confirm-migration-heading">
        <h3 id="confirm-migration-heading">Migrate to {{ targetModel.name }}?</h3>
        <div v-if="lostAddons.length" class="lockin" role="alert" data-testid="lockin-warning">
          <p class="lockin-title">
            <span class="badge">Vendor lock-in</span>
            You'll lose {{ lostAddons.length }} add-on{{ lostAddons.length === 1 ? "" : "s" }}
          </p>
          <ul class="lockin-addons">
            <li v-for="a in lostAddons" :key="a.id" :data-addon="a.id">
              <strong>{{ a.name }}</strong>
              <span class="muted">{{ a.devDays }} developer-days to rebuild</span>
            </li>
          </ul>
          <p>
            Add-ons belong to the SaaS provider, not you, so they stay behind when you leave: your developers must
            rebuild them, {{ rebuildDays }} developer-days in all. Until then, you lose their growth boost.
          </p>
        </div>
        <table class="quote" data-testid="migration-quote">
          <caption>
            What it costs
          </caption>
          <tbody>
            <tr data-quote="days">
              <th scope="row">
                Duration
                <span class="muted">You switch on day {{ game.company.day + quote.days }}</span>
              </th>
              <td data-testid="quote-days">{{ days(quote.days) }}</td>
            </tr>
            <tr v-for="row in quoteRows" :key="row.id" :data-quote="row.id">
              <th scope="row">
                {{ row.label }}
                <span class="muted">{{ row.detail }}</span>
              </th>
              <td :data-testid="`quote-${row.id}`">{{ formatCash(row.amount) }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td data-testid="quote-total">{{ formatCash(quote.total) }}</td>
            </tr>
          </tfoot>
        </table>
        <ul>
          <li v-if="quote.overrun.chance > 0" data-testid="quote-overrun">
            Migrations slip: a {{ Math.round(100 * quote.overrun.chance) }}% chance of
            {{ quote.overrun.minDays }}–{{ quote.overrun.maxDays }} extra days, with both providers billing for them.
          </li>
          <li v-if="quotePerUser">Per-user fees are priced at today's users, so they'll be more if you grow.</li>
          <li>
            Then {{ targetModel.name }} needs <strong>{{ targetModel.opsNeeded }}</strong> ops staff. You have
            {{ game.company.ops }}.
          </li>
        </ul>
        <div class="confirm-buttons">
          <button :disabled="game.busy" @click="startMigration">Start migration</button>
          <button class="ghost" :disabled="game.busy" @click="confirmingMigration = false">Cancel</button>
        </div>
      </div>
    </template>
  </section>
</template>
