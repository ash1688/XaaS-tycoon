<script setup lang="ts">
import { computed, ref } from "vue";
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
// With a paid API: API instances, the instance size, each giving APIU for its calls.
const hasApi = computed(() => !!game.company?.api?.owned);
const apiu = computed(() => (m.value ? m.value.apiInstances * m.value.apiInstanceUnits : 0));
const setApiInstances = (count: number) => game.act({ type: "setApiInstances", count });

// The database and cache: a size dropdown and a − / + pair. With none running, the dropdown picks the size + adds;
// with one running, changing it resizes it at once. You run at most one of each, so + only adds when there's none,
// and − removes it: the cache can go, but the database can't, since every product stores data.
const picked = ref<Partial<Record<ManagedService, ServerSize>>>({});
// A server from before databases could be missing sent the smallest with no units for none: that's none too.
const current = (service: ManagedService) => {
  const now = (service === "database" ? m.value?.database : m.value?.cache) ?? null;
  return now && now.units > 0 ? now : null;
};
const sizes = (service: ManagedService) =>
  (service === "database" ? (m.value?.databaseOptions ?? m.value?.database?.options) : m.value?.cacheOptions) ?? [];
const sizeOf = (service: ManagedService): ServerSize =>
  current(service)?.size ?? picked.value[service] ?? sizes(service)[0]?.size ?? "small";
const unitOf = (service: ManagedService) => (service === "database" ? "DBU" : "CH");

function countText(service: ManagedService) {
  const now = current(service);
  return now ? `1 ${now.size}` : "None";
}
function downWhy(service: ManagedService) {
  if (!current(service)) return `You have no ${service} to remove.`;
  if (service === "database") return "Your product needs a database: pick a size to resize it instead.";
  return undefined;
}
const upWhy = (service: ManagedService) =>
  current(service) ? `You run one ${service}: pick a bigger size to grow it.` : undefined;

function pick(service: ManagedService, size: string) {
  picked.value[service] = size as ServerSize;
  // One running: the dropdown resizes it.
  if (current(service)) game.act({ type: "setManagedService", service, size: size as ServerSize });
}
const add = (service: ManagedService) => game.act({ type: "setManagedService", service, size: sizeOf(service) });
const remove = (service: ManagedService) => game.act({ type: "setManagedService", service, size: null });
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

      <li v-if="hasApi" data-testid="platform-api-instances">
        <div class="server-info">
          <strong>API instances</strong>
          <span class="muted">
            {{ m.instanceSize }} instances, {{ formatCount(m.apiInstanceUnits) }} APIU and
            {{ formatCash(m.apiInstanceMonthlyCost) }} a month each: <strong>{{ formatCount(apiu) }} APIU</strong> in all.
            Up to {{ m.maxInstances }}.
          </span>
          <span class="managed-note">Serves your API's calls. Managed by provider: no ops needed.</span>
        </div>
        <StepperControl
          label="API instances"
          :value="String(m.apiInstances)"
          down-label="One fewer API instance"
          up-label="One more API instance"
          :down-why="m.apiInstances === 0 ? 'You run no API instances.' : undefined"
          :up-why="m.apiInstances >= m.maxInstances ? `The platform runs at most ${m.maxInstances} API instances.` : undefined"
          :disabled="game.busy || game.over"
          testid="api-instances"
          @down="setApiInstances(m.apiInstances - 1)"
          @up="setApiInstances(m.apiInstances + 1)"
        />
      </li>

      <li data-testid="platform-database">
        <div class="server-info">
          <strong>Managed database</strong>
          <span v-if="m.database" class="muted">
            {{ formatCount(m.database.units) }} DBU for {{ formatCash(m.database.monthlyCost) }} a month. One database,
            bigger as you grow: pick a size to resize it.
          </span>
          <span v-else class="muted warn-text" data-testid="no-database">
            None yet. Your product needs a database to serve users: pick a size and press +.
          </span>
          <span class="managed-note">Stores your data. Managed by provider: no ops needed.</span>
        </div>
        <div class="managed-controls">
          <label class="size-select">
            <span>{{ current("database") ? "Size" : "Size to add" }}</span>
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
            label="Managed database"
            :value="countText('database')"
            :down-label="'Remove the database'"
            :up-label="current('database') ? 'Add another database' : `Add a ${sizeOf('database')} database`"
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
          <strong>Managed cache</strong>
          <span v-if="m.cache" class="muted">
            {{ formatCount(m.cache.units) }} CH for {{ formatCash(m.cache.monthlyCost) }} a month: each cache hit takes
            a DBU off the database.
          </span>
          <span v-else class="muted">None. A cache answers repeat reads, taking load off the database.</span>
          <span class="managed-note">Managed by provider: no ops needed.</span>
        </div>
        <div class="managed-controls">
          <label class="size-select">
            <span>{{ current("cache") ? "Size" : "Size to add" }}</span>
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
            label="Managed cache"
            :value="countText('cache')"
            :down-label="'Remove the cache'"
            :up-label="current('cache') ? 'Add another cache' : `Add a ${sizeOf('cache')} cache`"
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
      running, however big it gets; yours do the work of {{ formatCount(game.opsWork) }}.
    </p>
  </section>
</template>
