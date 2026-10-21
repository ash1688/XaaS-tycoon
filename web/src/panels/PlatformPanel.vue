<script setup lang="ts">
import { computed } from "vue";
import type { ManagedService, ServerSize } from "@xaas/sim";
import { formatCash, formatCount } from "../api";
import StepperControl from "../components/StepperControl.vue";
import { useGame } from "../game";

// PaaS: the platform runs the servers. You set how many app instances to run and pick the size of a managed database
// and cache; the provider runs them, so they need no ops, and the load balancer is built in and free. Every change
// takes effect at once, serving from the next day.
const game = useGame();
const m = computed(() => game.managed);
const instanceCu = computed(() => (m.value ? m.value.instances * m.value.instanceUnits : 0));

const setInstances = (count: number) => game.act({ type: "setInstances", count });

// The database and cache step through None, then each size smallest first. The database can't go back to None: every
// product stores data, so the platform refuses it.
const levels = (service: ManagedService) => (service === "database" ? m.value?.databaseOptions : m.value?.cacheOptions) ?? [];
const current = (service: ManagedService) => (service === "database" ? m.value?.database : m.value?.cache) ?? null;
const index = (service: ManagedService) => {
  const now = current(service);
  return now ? levels(service).findIndex((o) => o.size === now.size) : -1;
};
function levelText(service: ManagedService) {
  const now = current(service);
  if (!now) return "None";
  const unit = service === "database" ? "DBU" : "CH";
  return `${now.size} · ${formatCount(now.units)} ${unit} · ${formatCash(now.monthlyCost)}/mo`;
}
function downWhy(service: ManagedService) {
  const i = index(service);
  if (i < 0) return `You have no ${service} to remove.`;
  if (service === "database" && i === 0) return "Your product needs a database, so it can't go below small.";
  return undefined;
}
const upWhy = (service: ManagedService) =>
  index(service) >= levels(service).length - 1 ? `This is the biggest ${service} there is.` : undefined;
function step(service: ManagedService, by: number) {
  const next = levels(service)[index(service) + by];
  game.act({ type: "setManagedService", service, size: next ? (next.size as ServerSize) : null });
}
</script>

<template>
  <section v-if="game.company && m" class="card platform" aria-labelledby="platform-heading" data-testid="platform-panel">
    <div class="row-between panel-head">
      <h2 id="platform-heading">Platform</h2>
      <span class="muted">
        Instances and services <strong data-testid="platform-cost">{{ formatCash(m.monthlyCost) }}</strong> a month
      </span>
    </div>
    <p class="lb-status" role="status" data-testid="lb-builtin">
      <span class="badge provider-badge">Built in</span>
      <span>The load balancer comes with the platform, free. It spreads traffic over every instance, however many.</span>
    </p>

    <ul class="server-list platform-list">
      <li data-testid="platform-instances">
        <div class="server-info">
          <strong id="instances-label">App instances</strong>
          <span class="muted">
            {{ m.instanceSize }} instances, {{ formatCount(m.instanceUnits) }} CU and
            {{ formatCash(m.instanceMonthlyCost) }} a month each: <strong>{{ formatCount(instanceCu) }} CU</strong> in all.
            Up to {{ m.maxInstances }}.
          </span>
          <span class="managed-note">Runs your code. Managed by provider: no ops needed.</span>
        </div>
        <StepperControl
          label="App instances"
          :value="String(m.instances)"
          down-label="One fewer app instance"
          up-label="One more app instance"
          :down-why="
            m.instances === 0 ? 'You run no instances yet.' : m.instances === 1 ? 'Your code needs at least 1 instance to run.' : undefined
          "
          :up-why="m.instances >= m.maxInstances ? `The platform runs at most ${m.maxInstances} instances.` : undefined"
          :disabled="game.busy || game.over"
          testid="instances"
          @down="setInstances(m.instances - 1)"
          @up="setInstances(m.instances + 1)"
        />
      </li>

      <li data-testid="platform-database">
        <div class="server-info">
          <strong id="database-label">Managed database</strong>
          <span v-if="m.database" class="muted">
            {{ formatCount(m.database.units) }} DBU for {{ formatCash(m.database.monthlyCost) }} a month. One database,
            bigger as you grow.
          </span>
          <span v-else class="muted warn-text" data-testid="no-database">
            None yet. Your product needs a database to serve users: press + to add one.
          </span>
          <span class="managed-note">Stores your data. Managed by provider: no ops needed.</span>
        </div>
        <StepperControl
          label="Managed database size"
          :value="levelText('database')"
          :down-label="m.database ? 'Smaller database' : 'Remove the database'"
          :up-label="m.database ? 'Larger database' : 'Add a database'"
          :down-why="downWhy('database')"
          :up-why="upWhy('database')"
          :disabled="game.busy || game.over"
          testid="managed-database"
          @down="step('database', -1)"
          @up="step('database', 1)"
        />
      </li>

      <li data-testid="platform-cache">
        <div class="server-info">
          <strong id="cache-label">Managed cache</strong>
          <span v-if="m.cache" class="muted">
            {{ formatCount(m.cache.units) }} CH for {{ formatCash(m.cache.monthlyCost) }} a month: each cache hit takes
            a DBU off the database.
          </span>
          <span v-else class="muted">None. A cache answers repeat reads, taking load off the database.</span>
          <span class="managed-note">Managed by provider: no ops needed.</span>
        </div>
        <StepperControl
          label="Managed cache size"
          :value="levelText('cache')"
          :down-label="m.cache?.size === 'small' ? 'Remove the cache' : 'Smaller cache'"
          :up-label="m.cache ? 'Larger cache' : 'Add a cache'"
          :down-why="downWhy('cache')"
          :up-why="upWhy('cache')"
          :disabled="game.busy || game.over"
          testid="managed-cache"
          @down="step('cache', -1)"
          @up="step('cache', 1)"
        />
      </li>
    </ul>

    <p v-if="game.error" class="error" role="alert">{{ game.error }}</p>
    <p class="muted platform-note" data-testid="platform-note">
      Changes take effect at once, serving from the next day, and are billed monthly, a day's share at a time. The
      platform runs the servers, so you need just <strong>{{ game.company.opsNeeded }}</strong> ops to keep the service
      running, however big it gets; you have {{ game.company.ops }}.
    </p>
  </section>
</template>
