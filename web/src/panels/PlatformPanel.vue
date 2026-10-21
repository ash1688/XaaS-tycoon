<script setup lang="ts">
import { computed, ref } from "vue";
import type { ManagedService, ServerSize } from "@xaas/sim";
import { formatCash, formatCount } from "../api";
import StepperControl from "../components/StepperControl.vue";
import { useGame } from "../game";

// PaaS: the platform runs the servers. You set how many app instances to run and add managed databases and caches;
// the provider runs them, so they need no ops, and the load balancer is built in and free. Every change
// takes effect at once, serving from the next day.
const game = useGame();
const m = computed(() => game.managed);
const instanceCu = computed(() => (m.value ? m.value.instances * m.value.instanceUnits : 0));

const setInstances = (count: number) => game.act({ type: "setInstances", count });

// The databases and caches: a size dropdown and a − / + pair. The dropdown picks a size: + adds another of it, like a
// read replica or shard, and − removes one of it. Their units add up, up to the platform's most of each. The dropdown
// never resizes one you run: to grow, add a bigger one, then remove the smaller. The cache can go, but the last
// database can't, since every product stores data.
const picked = ref<Partial<Record<ManagedService, ServerSize>>>({});
// A server from before databases could be missing sent the smallest with no units for none: that's none too.
const current = (service: ManagedService) => {
  const now = (service === "database" ? m.value?.database : m.value?.cache) ?? null;
  return now && now.units > 0 ? now : null;
};
const sizes = (service: ManagedService) =>
  (service === "database" ? (m.value?.databaseOptions ?? m.value?.database?.options) : m.value?.cacheOptions) ?? [];
// Until one is picked, the biggest size running, or the smallest there is.
const sizeOf = (service: ManagedService): ServerSize =>
  picked.value[service] ?? current(service)?.running[0]?.size ?? sizes(service)[0]?.size ?? "small";
const unitOf = (service: ManagedService) => (service === "database" ? "DBU" : "CH");
const countOf = (service: ManagedService) => current(service)?.count ?? 0;
const maxOf = (service: ManagedService) => m.value?.maxServices?.[service] ?? 1;
const runningOf = (service: ManagedService, size: ServerSize) =>
  current(service)?.running.find((r) => r.size === size)?.count ?? 0;

const countText = (service: ManagedService) => (countOf(service) ? String(countOf(service)) : "None");
// "2 × massive, 1 × large".
const summary = (service: ManagedService) =>
  current(service)?.running.map((r) => `${r.count} × ${r.size}`).join(", ") ?? "";
function downWhy(service: ManagedService) {
  const size = sizeOf(service);
  if (!countOf(service)) return `You have no ${service} to remove.`;
  if (service === "database" && countOf(service) === 1) {
    return "Your product needs a database: add another before removing this one.";
  }
  if (!runningOf(service, size)) return `You run no ${size} ${service}: pick a size you run to remove one.`;
  return undefined;
}
const upWhy = (service: ManagedService) =>
  countOf(service) >= maxOf(service) ? `The platform runs at most ${maxOf(service)} ${service}s.` : undefined;

const pick = (service: ManagedService, size: string) => (picked.value[service] = size as ServerSize);
const add = (service: ManagedService) => game.act({ type: "addManagedService", service, size: sizeOf(service) });
const remove = (service: ManagedService) => game.act({ type: "removeManagedService", service, size: sizeOf(service) });
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
          <strong>Managed databases</strong>
          <span v-if="m.database" class="muted">
            <strong data-testid="managed-database-summary">{{ summary("database") }}</strong> ·
            {{ formatCount(m.database.units) }} DBU · {{ formatCash(m.database.monthlyCost) }}/mo. Add more as you grow,
            like read replicas: their DBU add up, up to {{ maxOf("database") }}.
          </span>
          <span v-else class="muted warn-text" data-testid="no-database">
            None yet. Your product needs a database to serve users: pick a size and press +.
          </span>
          <span class="managed-note">Stores your data. Managed by provider: no ops needed.</span>
        </div>
        <div class="managed-controls">
          <label class="size-select">
            <span>{{ current("database") ? "Size to add or remove" : "Size to add" }}</span>
            <select
              :value="sizeOf('database')"
              :disabled="game.busy || game.over"
              data-testid="managed-database-size"
              @change="pick('database', ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="o in sizes('database')" :key="o.size" :value="o.size">
                {{ o.size }} · {{ formatCount(o.units) }} {{ unitOf("database") }} · {{ formatCash(o.monthlyCost) }}/mo
              </option>
            </select>
          </label>
          <StepperControl
            label="Managed databases"
            :value="countText('database')"
            :down-label="`Remove a ${sizeOf('database')} database`"
            :up-label="`Add a ${sizeOf('database')} database`"
            :down-why="downWhy('database')"
            :up-why="upWhy('database')"
            :disabled="game.busy || game.over"
            testid="managed-database"
            @down="remove('database')"
            @up="add('database')"
          />
        </div>
      </li>

      <li data-testid="platform-cache">
        <div class="server-info">
          <strong>Managed caches</strong>
          <span v-if="m.cache" class="muted">
            <strong data-testid="managed-cache-summary">{{ summary("cache") }}</strong> ·
            {{ formatCount(m.cache.units) }} CH · {{ formatCash(m.cache.monthlyCost) }}/mo: each cache hit takes a DBU
            off the databases. Up to {{ maxOf("cache") }}.
          </span>
          <span v-else class="muted">None. A cache answers repeat reads, taking load off the database.</span>
          <span class="managed-note">Managed by provider: no ops needed.</span>
        </div>
        <div class="managed-controls">
          <label class="size-select">
            <span>{{ current("cache") ? "Size to add or remove" : "Size to add" }}</span>
            <select
              :value="sizeOf('cache')"
              :disabled="game.busy || game.over"
              data-testid="managed-cache-size"
              @change="pick('cache', ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="o in sizes('cache')" :key="o.size" :value="o.size">
                {{ o.size }} · {{ formatCount(o.units) }} {{ unitOf("cache") }} · {{ formatCash(o.monthlyCost) }}/mo
              </option>
            </select>
          </label>
          <StepperControl
            label="Managed caches"
            :value="countText('cache')"
            :down-label="`Remove a ${sizeOf('cache')} cache`"
            :up-label="`Add a ${sizeOf('cache')} cache`"
            :down-why="downWhy('cache')"
            :up-why="upWhy('cache')"
            :disabled="game.busy || game.over"
            testid="managed-cache"
            @down="remove('cache')"
            @up="add('cache')"
          />
        </div>
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
