<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { SPEND_CATEGORIES, type DayLog, type ModelId, type SpendCategory, type StaffPool } from "@xaas/sim";
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
const stackFor = (id: ModelId | undefined) => meta.value?.models.find((m) => m.id === id)?.stack.toReversed() ?? [];
const stack = computed(() => stackFor(company.value?.model));
// After a migration completes, the layers whose owner changed are highlighted until the next day.
const previousModel = ref<ModelId>();
const previousOwners = computed(() => new Map(stackFor(previousModel.value).map((l) => [l.id, l.owner])));
const OWNER_LABELS = { you: "You", provider: "Provider", shared: "Shared" } as const;
const understaffed = computed(() => !!company.value && company.value.ops < company.value.opsNeeded);
const loadPercent = computed(() => (company.value ? Math.round((100 * company.value.load) / company.value.capacity) : 0));
// Over 100% is an outage; close to it is a warning that one is coming.
const loadLevel = computed(() => (loadPercent.value > 100 ? "over" : loadPercent.value >= 80 ? "high" : "ok"));

const bankrupt = computed(() => company.value?.status === "bankrupt");
const EVENT_LABELS = { outage: "Outage", bankrupt: "Bankrupt", feature: "Feature", migration: "Migration" } as const;

// One build at a time, and none on SaaS, where features come as add-ons instead.
const onSaas = computed(() => company.value?.model === "saas");
const building = computed(() => company.value?.features.find((f) => f.status === "building"));
const growthBoost = (multiplier: number) => `+${Math.round(100 * (multiplier - 1))}% growth`;
// Built features, or add-ons bought on SaaS.
const activeCount = computed(
  () => company.value?.features.filter((f) => f.status === "built" || f.status === "addon").length ?? 0,
);
// SaaS still needs a few developers to configure add-ons; without them, add-ons can't be bought.
const configTeamNeeded = computed(() => meta.value?.minConfigDevelopers ?? 0);
const configTeamShort = computed(() => (company.value ? Math.max(0, configTeamNeeded.value - company.value.developers) : 0));
const currentModel = computed(() => meta.value?.models.find((m) => m.id === company.value?.model));

// Migration: pick a target, confirm, then it runs in the background while you keep playing.
const migration = computed(() => company.value?.migration ?? null);
const migrationTarget = ref<ModelId>();
const confirmingMigration = ref(false);
const migrationTargets = computed(() => meta.value?.models.filter((m) => m.id !== company.value?.model) ?? []);
const targetModel = computed(() => meta.value?.models.find((m) => m.id === migrationTarget.value));
const migrationDays = computed(() => meta.value?.migrationPhases.reduce((sum, p) => sum + p.days, 0) ?? 0);
const phaseName = (id: string) => meta.value?.migrationPhases.find((p) => p.id === id)?.name ?? id;
const phaseIndex = computed(() => meta.value?.migrationPhases.findIndex((p) => p.id === migration.value?.phase) ?? -1);
const phaseState = (i: number) => (i < phaseIndex.value ? "done" : i === phaseIndex.value ? "current" : "next");
const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
// Add-ons are the SaaS provider's, so leaving SaaS leaves them behind.
const addonsLost = computed(() =>
  onSaas.value ? (company.value?.features.filter((f) => f.status === "addon") ?? []) : [],
);

function pickTarget(id: ModelId) {
  migrationTarget.value = id;
  confirmingMigration.value = false;
}

async function startMigration() {
  if (!migrationTarget.value) return;
  await act({ type: "startMigration", model: migrationTarget.value });
  if (migration.value) {
    migrationTarget.value = undefined;
    confirmingMigration.value = false;
  }
}

const otherPool = (pool: StaffPool): StaffPool => (pool === "developers" ? "ops" : "developers");
const personName = (pool: StaffPool) => meta.value?.staff.find((s) => s.id === pool)?.personName ?? pool;

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
    const before = company.value?.model;
    const result = await api.continueDay(props.code, props.id);
    previousModel.value = before !== result.company.model ? before : undefined;
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
          <span class="badge">{{ EVENT_LABELS[entry.kind ?? "outage"] }}</span>
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
      <strong>{{ formatCash(company.monthlyInfrastructureCost) }}</strong> a month<template v-if="onSaas"
        >, plus <strong>{{ formatCash(company.monthlyAddonCost) }}</strong> a month for add-ons</template
      >.
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
    <div class="move-staff" data-testid="move-staff">
      <span class="muted">Retrain someone into the other team (no cost, any time):</span>
      <div class="move-buttons">
        <button
          v-for="pool in meta.staff"
          :key="pool.id"
          class="ghost"
          :disabled="busy || bankrupt || company[otherPool(pool.id)] < 1"
          :aria-label="`Move one ${personName(otherPool(pool.id))} to ${pool.name.toLowerCase()}`"
          @click="act({ type: 'moveStaff', to: pool.id })"
        >
          {{ personName(otherPool(pool.id)) }} → {{ pool.name.toLowerCase() }}
        </button>
      </div>
    </div>
    <p :class="['ops-needed', { warn: understaffed }]" data-testid="ops-needed">
      <span>{{ modelName(company.model) }} needs <strong>{{ company.opsNeeded }}</strong> ops staff.</span>
      <span v-if="understaffed" class="badge">
        Understaffed: {{ company.opsNeeded - company.ops }} short, capacity cut
      </span>
    </p>
  </section>

  <section v-if="company && meta" class="card" aria-labelledby="migration-heading" data-testid="migration-panel">
    <div class="row-between">
      <h2 id="migration-heading">Migration</h2>
      <span class="muted" data-testid="migration-count">
        {{ company.migrations }} completed
      </span>
    </div>
    <template v-if="migration">
      <p class="migration-route">
        Moving from <strong>{{ modelName(migration.from) }}</strong> to
        <strong data-testid="migration-target">{{ modelName(migration.to) }}</strong>
      </p>
      <ol class="phases" aria-label="Migration phases">
        <li
          v-for="(phase, i) in meta.migrationPhases"
          :key="phase.id"
          :class="phaseState(i)"
          :data-phase="phase.id"
          :aria-current="phaseState(i) === 'current' ? 'step' : undefined"
        >
          <strong>{{ phase.name }}</strong>
          <span class="muted">{{ phaseState(i) === "done" ? "Done" : days(phase.days) }}</span>
        </li>
      </ol>
      <div
        class="meter"
        role="progressbar"
        aria-labelledby="migration-heading"
        aria-valuemin="0"
        :aria-valuemax="migration.totalDays"
        :aria-valuenow="migration.totalDays - migration.daysLeft"
        :aria-valuetext="`${migration.totalDays - migration.daysLeft} of ${migration.totalDays} days`"
      >
        <div
          class="meter-fill building"
          :style="{ width: `${(100 * (migration.totalDays - migration.daysLeft)) / migration.totalDays}%` }"
        ></div>
      </div>
      <p class="migration-status" data-testid="migration-status">
        <span>
          <strong data-testid="migration-phase">{{ phaseName(migration.phase) }}</strong>:
          <span data-testid="migration-phase-days">{{ days(migration.phaseDaysLeft) }} left</span> in this phase
        </span>
        <span>
          Switch to {{ modelName(migration.to) }} in
          <strong data-testid="migration-days-left">{{ days(migration.daysLeft) }}</strong>
        </span>
      </p>
      <p class="muted migration-note">
        It runs in the background: your staff aren't tied up. You stay on {{ modelName(migration.from) }}, and keep
        paying for it, until the move completes.
      </p>
    </template>
    <template v-else>
      <p class="muted migration-note">
        Change deployment model at any time. A migration takes {{ days(migrationDays) }}
        ({{ meta.migrationPhases.map((p) => `${p.name.toLowerCase()} ${p.days}`).join(", ") }}) and runs in the
        background, so your staff stay free. Your product stays the same.
      </p>
      <fieldset :disabled="busy || bankrupt">
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
        :disabled="busy || bankrupt || !targetModel"
        @click="confirmingMigration = true"
      >
        Plan migration
      </button>
      <div v-else-if="targetModel" class="confirm" role="group" aria-labelledby="confirm-migration-heading">
        <h3 id="confirm-migration-heading">Migrate to {{ targetModel.name }}?</h3>
        <ul>
          <li>Takes {{ days(migrationDays) }}. You switch on day {{ company.day + migrationDays }}.</li>
          <li>You stay on {{ modelName(company.model) }}, and keep paying for it, until then.</li>
          <li>
            Then {{ targetModel.name }} needs <strong>{{ targetModel.opsNeeded }}</strong> ops staff. You have
            {{ company.ops }}.
          </li>
          <li v-if="addonsLost.length" class="warn-text" data-testid="addons-lost">
            Your add-ons stay behind on SaaS: {{ addonsLost.map((f) => f.name).join(", ") }}.
          </li>
        </ul>
        <div class="confirm-buttons">
          <button :disabled="busy || bankrupt" @click="startMigration">Start migration</button>
          <button class="ghost" :disabled="busy" @click="confirmingMigration = false">Cancel</button>
        </div>
      </div>
    </template>
  </section>

  <section v-if="company" class="card" aria-labelledby="features-heading" data-testid="features">
    <div class="row-between">
      <h2 id="features-heading">{{ onSaas ? "Add-on shop" : "Features" }}</h2>
      <span class="muted">
        {{ activeCount }} of {{ company.features.length }} {{ onSaas ? "active" : "built" }}
      </span>
    </div>
    <template v-if="onSaas">
      <p class="features-note" data-testid="features-saas-note">
        On SaaS you don't build features yourself: you buy them as add-ons from the provider. They work straight away,
        but each one is billed <strong>per user, every month</strong>, so the bill grows as your users grow.
      </p>
      <p :class="['ops-needed', 'config-team', { warn: configTeamShort }]" data-testid="config-team">
        <span>
          Add-ons still need a configuration team of at least <strong>{{ configTeamNeeded }}</strong>
          developer{{ configTeamNeeded === 1 ? "" : "s" }}. You have {{ company.developers }}.
        </span>
        <span v-if="configTeamShort" class="badge">Hire {{ configTeamShort }} more to buy add-ons</span>
      </p>
      <p class="addon-bill" data-testid="addon-bill">
        Add-on bill at today's users: <strong>{{ formatCash(company.monthlyAddonCost) }}</strong> a month
      </p>
    </template>
    <p v-else class="muted features-intro">
      Your developers build features, one at a time. Each developer does one developer-day of work a day.
    </p>
    <ul class="features">
      <li
        v-for="feature in company.features"
        :key="feature.id"
        :class="feature.status"
        :data-feature="feature.id"
        :data-status="feature.status"
      >
        <div class="row-between feature-head">
          <div class="feature-info">
            <strong :id="`feature-${feature.id}`">{{ feature.name }}</strong>
            <span class="muted">{{ feature.blurb }}</span>
            <span v-if="onSaas" class="muted feature-cost" :data-testid="`addon-price-${feature.id}`">
              {{ formatPrice(feature.addonPricePerUser) }} per user a month · {{ growthBoost(feature.growthMultiplier) }}
            </span>
            <span v-else class="muted feature-cost">
              {{ feature.devDays }} developer-days · {{ growthBoost(feature.growthMultiplier) }}
            </span>
          </div>
          <span v-if="feature.status === 'built'" class="badge built-badge">Built</span>
          <span v-else-if="feature.status === 'addon'" class="badge built-badge">Active</span>
          <button
            v-else-if="feature.status === 'notStarted' && onSaas"
            class="ghost"
            :disabled="busy || bankrupt || configTeamShort > 0"
            :aria-label="`Buy ${feature.name} add-on`"
            :title="configTeamShort ? `Hire ${configTeamShort} more developers to configure add-ons` : undefined"
            @click="act({ type: 'buyAddon', feature: feature.id })"
          >
            Buy
          </button>
          <button
            v-else-if="feature.status === 'notStarted' && !onSaas"
            class="ghost"
            :disabled="busy || bankrupt || !!building"
            :aria-label="`Build ${feature.name}`"
            :title="building ? `Your developers are busy building ${building.name}` : undefined"
            @click="act({ type: 'buildFeature', feature: feature.id })"
          >
            Build
          </button>
        </div>
        <div v-if="feature.status === 'building'" class="feature-progress">
          <div
            class="meter"
            role="progressbar"
            :aria-labelledby="`feature-${feature.id}`"
            aria-valuemin="0"
            :aria-valuemax="feature.devDays"
            :aria-valuenow="feature.progress"
            :aria-valuetext="`${feature.progress} of ${feature.devDays} developer-days`"
          >
            <div class="meter-fill building" :style="{ width: `${(100 * feature.progress) / feature.devDays}%` }"></div>
          </div>
          <p class="muted" :data-testid="`feature-progress-${feature.id}`">
            {{ feature.progress }} of {{ feature.devDays }} developer-days.
            <template v-if="feature.daysLeft !== null">
              {{ feature.daysLeft }} day{{ feature.daysLeft === 1 ? "" : "s" }} left with {{ company.developers }}
              developer{{ company.developers === 1 ? "" : "s" }}.
            </template>
            <strong v-else class="warn-text">No developers: hire some to carry on.</strong>
          </p>
        </div>
      </li>
    </ul>
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
    <p v-if="migration" class="muted stack-note" data-testid="stack-note">
      This changes to {{ modelName(migration.to) }} when your migration completes.
    </p>
    <p v-else-if="previousModel" class="stack-note changed-note" data-testid="stack-note">
      Migration complete: moved from {{ modelName(previousModel) }}. Highlighted layers changed hands.
    </p>
    <ol class="resp-stack" data-testid="stack">
      <li
        v-for="layer in stack"
        :key="layer.id"
        :class="[layer.owner, { changed: previousModel && previousOwners.get(layer.id) !== layer.owner }]"
        :data-layer="layer.id"
      >
        <span>{{ layer.name }}</span>
        <span class="owner">
          <small v-if="previousModel && previousOwners.get(layer.id) !== layer.owner" class="was">
            was {{ OWNER_LABELS[previousOwners.get(layer.id)!] }}
          </small>
          <strong>{{ OWNER_LABELS[layer.owner] }}</strong>
        </span>
      </li>
    </ol>
  </section>
</template>
