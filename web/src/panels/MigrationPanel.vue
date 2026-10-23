<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { SERVER_SIZES, SERVER_TYPES, type ModelId, type ServerType, type SetupItem } from "@xaas/sim";
import type { MigrationQuoteView } from "@xaas/server/api-types";
import { api, formatCash, formatCount } from "../api";
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
  const kit = q.setupUpfront > 0 ? " and the new kit" : "";
  const setup = q.setup.length ? " and your new setup" : "";
  const rows = [
    { id: "upfront", label: "Upfront", detail: `${to} upfront cost${kit}, on the first day`, amount: q.upfrontCost },
    {
      id: "double",
      label: "Double billing",
      detail: `${to}${setup} billed in full for ${days(q.days)}, on top of ${from}`,
      amount: q.doubleBilling,
    },
    { id: "pro-rata", label: "Pro rata", detail: `${from} and your servers billed up to the day you leave`, amount: q.proRata },
    { id: "exit", label: "Exit penalty", detail: `${from} charges once for leaving`, amount: q.exitPenalty },
  ];
  if (q.sellBack > 0) {
    rows.push({ id: "sell-back", label: "Sell-back", detail: "Your old kit, sold back at a loss on the day you leave", amount: -q.sellBack });
  }
  return rows;
});

// A setup item in words: "3 × massive app server", or on PaaS "5 × app instance (15 CU each)".
const UNIT: Record<ServerType, string> = { app: "CU", database: "DBU", cache: "CH", loadBalancer: "app servers" };
const itemName = (i: { name: string; size: string; count: number; type: ServerType }) =>
  i.type === "app" && i.name === "App instance" ? `${i.count} × app instance` : `${i.count} × ${i.size} ${i.name.toLowerCase()}`;
const itemUnits = (i: { units: number; type: ServerType }) =>
  i.type === "loadBalancer" ? `serves ${i.units} app servers` : `${formatCount(i.units)} ${UNIT[i.type]} each`;
const quoteBuys = computed(() => (quote.value?.setupUpfront ?? 0) > 0);

// During a move, both setups side by side: the old one still serving, and the new one being built.
const oldSetup = computed(() => {
  const servers = game.company?.servers ?? [];
  return SERVER_TYPES.flatMap((type) =>
    SERVER_SIZES.map((size) => {
      const list = servers.filter((s) => s.type === type && s.size === size);
      const first = list[0];
      return first
        ? { type, size, name: first.name, count: list.length, units: first.units, monthly: list.reduce((sum, s) => sum + s.monthlyCost, 0), onOrder: list.filter((s) => s.status === "pending" && s.paid !== null).length }
        : null;
    }),
  ).filter((i) => i !== null);
});
const oldMonthly = computed(() => Math.round(oldSetup.value.reduce((sum, i) => sum + i.monthly, 0)));
const newStatus = (i: SetupItem) => (i.upfront > 0 && i.daysLeft > 0 ? `Arrives in ${days(i.daysLeft)}` : "Ready for the switch");
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

// For the playtest log: a quote shown is logged once the student starts the migration or drops it.
function quoteDone(confirmed: boolean) {
  if (quote.value) game.track("quote", { kind: "migration", target: quote.value.to, confirmed });
}
onBeforeUnmount(() => quoteDone(false));

function cancelMigration() {
  quoteDone(false);
  confirmingMigration.value = false;
  quote.value = undefined;
}

function pickTarget(id: ModelId) {
  quoteDone(false);
  migrationTarget.value = id;
  confirmingMigration.value = false;
  quote.value = undefined;
}

// Fetches the quote for the confirm step, so the student sees what it costs before committing.
async function planMigration() {
  if (!migrationTarget.value) return;
  quoteDone(false);
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
    quoteDone(true);
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
      <div class="setups" data-testid="migration-setups">
        <section class="setup" aria-labelledby="old-setup-heading" data-testid="old-setup">
          <h3 id="old-setup-heading">
            Now: {{ game.modelName(game.migration.from) }}
            <span class="muted">Serving until the switch</span>
          </h3>
          <ul v-if="oldSetup.length">
            <li v-for="i in oldSetup" :key="`${i.type}-${i.size}`">
              <span>{{ itemName(i) }}<span v-if="i.onOrder" class="muted"> ({{ i.onOrder }} on order)</span></span>
              <span class="muted">{{ formatCash(i.monthly) }}/mo</span>
            </li>
          </ul>
          <p v-else class="muted">No servers: the provider scales.</p>
          <p class="setup-total">
            <span>{{ oldSetup.length ? "Servers a month" : "" }}</span>
            <strong v-if="oldSetup.length">{{ formatCash(oldMonthly) }}</strong>
          </p>
        </section>
        <section class="setup new" aria-labelledby="new-setup-heading" data-testid="new-setup">
          <h3 id="new-setup-heading">
            Next: {{ game.modelName(game.migration.to) }}
            <span class="muted">Being built, billed from day 1</span>
          </h3>
          <ul v-if="game.migration.setup.length">
            <li v-for="i in game.migration.setup" :key="`${i.type}-${i.size}`" :data-setup-item="`${i.type}-${i.size}`">
              <span>{{ itemName(i) }} <span class="muted">· {{ newStatus(i) }}</span></span>
              <span class="muted">{{ formatCash(i.monthly) }}/mo</span>
            </li>
          </ul>
          <p v-else class="muted">No servers: the provider scales.</p>
          <p class="setup-total">
            <span>{{ game.migration.setup.length ? "Servers a month" : "" }}</span>
            <strong v-if="game.migration.setup.length" data-testid="new-setup-monthly">{{ formatCash(game.migration.setupMonthly) }}</strong>
          </p>
        </section>
      </div>
      <p v-if="game.migration.overrunDays" class="overrun" role="status" data-testid="migration-overrun">
        <span class="badge">Overrun</span>
        <span>
          Moving infrastructure is taking <strong>{{ days(game.migration.overrunDays) }}</strong> longer than planned,
          and both providers bill for every extra day.
        </span>
      </p>
      <p class="muted migration-note">
        It runs in the background: your staff aren't tied up. You stay on {{ game.modelName(game.migration.from) }}
        until the move completes, paying for both setups at the same time. Then the new setup takes over, and your old
        servers go: rentals cancelled, bought kit sold back at a loss.
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
        <table class="quote setup-table" data-testid="quote-setup">
          <caption>
            Your new setup
            <span class="muted">
              Built for you on the first day, sized to today's demand ({{ formatCount(quote.sizedFor.cu) }} CU,
              {{ formatCount(quote.sizedFor.dbu) }} DBU) with {{ Math.round(100 * quote.headroom) }}% room to grow
            </span>
          </caption>
          <thead v-if="quote.setup.length">
            <tr>
              <th scope="col">Item</th>
              <th v-if="quoteBuys" scope="col" class="num">Up front</th>
              <th scope="col" class="num">A month</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="i in quote.setup" :key="`${i.type}-${i.size}`" :data-setup-item="`${i.type}-${i.size}`">
              <th scope="row">
                {{ itemName(i) }}
                <span class="muted">{{ itemUnits(i) }}</span>
              </th>
              <td v-if="quoteBuys">{{ formatCash(i.upfront) }}</td>
              <td>{{ formatCash(i.monthly) }}</td>
            </tr>
            <tr v-if="!quote.setup.length">
              <th scope="row" data-testid="quote-setup-none">
                No servers to set up
                <span class="muted">{{ game.modelName(quote.to) }} scales for you: you pay per user instead</span>
              </th>
            </tr>
          </tbody>
          <tfoot v-if="quote.setup.length">
            <tr>
              <th scope="row">New setup</th>
              <td v-if="quoteBuys" data-testid="quote-setup-upfront">{{ formatCash(quote.setupUpfront) }}</td>
              <td data-testid="quote-setup-monthly">{{ formatCash(quote.setupMonthly) }}</td>
            </tr>
          </tfoot>
        </table>
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
          <li v-if="quote.deliveryDays !== null" data-testid="quote-delivery">
            The new kit takes {{ days(quote.deliveryDays) }} to arrive,
            {{ quote.deliveryDays < quote.days ? `inside the ${quote.days}-day move` : "longer than the move: it serves once it arrives" }}.
            Its power and upkeep start once it's in.
          </li>
          <li v-if="game.company.servers.length">
            On the day you leave, your old servers go:
            {{ quote.sellBack > 0 ? "bought kit is sold back at a loss" : "rentals are cancelled, billed only for the days you had them" }}.
          </li>
          <li v-if="quote.setup.length">Once you've switched, fine-tune the sizes here on Infrastructure.</li>
          <li>
            Then {{ targetModel.name }} needs <strong data-testid="quote-ops">{{ quote.opsNeeded }}</strong> ops staff. Yours do the
            work of {{ formatCount(game.opsWork) }}.
          </li>
        </ul>
        <div class="confirm-buttons">
          <button :disabled="game.busy" @click="startMigration">Start migration</button>
          <button class="ghost" :disabled="game.busy" @click="cancelMigration">Cancel</button>
        </div>
      </div>
    </template>
  </section>
</template>
