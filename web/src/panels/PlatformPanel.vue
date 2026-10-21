<script setup lang="ts">
import { computed } from "vue";
import type { ManagedService, ServerSize } from "@xaas/sim";
import { formatCash, formatCount } from "../api";
import { useGame } from "../game";

// PaaS: the platform runs the servers. You set how many app instances to run and pick the size of a managed database
// and cache; the provider runs them, so they need no ops, and the load balancer is built in and free. Every change
// takes effect at once, serving from the next day.
const game = useGame();
const m = computed(() => game.managed);
const instanceCu = computed(() => (m.value ? m.value.instances * m.value.instanceUnits : 0));

const setInstances = (count: number) => game.act({ type: "setInstances", count });
const setService = (service: ManagedService, value: string) =>
  game.act({ type: "setManagedService", service, size: value ? (value as ServerSize) : null });
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
        <div class="counter" role="group" aria-labelledby="instances-label">
          <button
            class="ghost"
            :disabled="game.busy || game.over || m.instances <= 1"
            aria-label="One fewer app instance"
            data-testid="instances-down"
            @click="setInstances(m.instances - 1)"
          >
            −
          </button>
          <output data-testid="instances-count" aria-live="polite">{{ m.instances }}</output>
          <button
            class="ghost"
            :disabled="game.busy || game.over || m.instances >= m.maxInstances"
            aria-label="One more app instance"
            data-testid="instances-up"
            @click="setInstances(m.instances + 1)"
          >
            +
          </button>
        </div>
      </li>

      <li data-testid="platform-database">
        <div class="server-info">
          <label for="managed-database">Managed database</label>
          <span v-if="m.database" class="muted">
            {{ formatCount(m.database.units) }} DBU for {{ formatCash(m.database.monthlyCost) }} a month. One database,
            bigger as you grow.
          </span>
          <span v-else class="muted warn-text" data-testid="no-database">
            None yet. Your product needs a database to serve users: pick a size.
          </span>
          <span class="managed-note">Stores your data. Managed by provider: no ops needed.</span>
        </div>
        <select
          id="managed-database"
          :value="m.database?.size ?? ''"
          :disabled="game.busy || game.over"
          data-testid="managed-database"
          @change="setService('database', ($event.target as HTMLSelectElement).value)"
        >
          <!-- Shown only while there's none, so picking any size is a change. -->
          <option v-if="!m.database" value="" disabled>Choose a size…</option>
          <option v-for="o in m.databaseOptions" :key="o.size" :value="o.size">
            {{ o.size }} · {{ formatCount(o.units) }} DBU · {{ formatCash(o.monthlyCost) }}/mo
          </option>
        </select>
      </li>

      <li data-testid="platform-cache">
        <div class="server-info">
          <label for="managed-cache">Managed cache</label>
          <span v-if="m.cache" class="muted">
            {{ formatCount(m.cache.units) }} CH for {{ formatCash(m.cache.monthlyCost) }} a month: each cache hit takes
            a DBU off the database.
          </span>
          <span v-else class="muted">None. A cache answers repeat reads, taking load off the database.</span>
          <span class="managed-note">Managed by provider: no ops needed.</span>
        </div>
        <select
          id="managed-cache"
          :value="m.cache?.size ?? ''"
          :disabled="game.busy || game.over"
          data-testid="managed-cache"
          @change="setService('cache', ($event.target as HTMLSelectElement).value)"
        >
          <option value="">No cache</option>
          <option v-for="o in m.cacheOptions" :key="o.size" :value="o.size">
            {{ o.size }} · {{ formatCount(o.units) }} CH · {{ formatCash(o.monthlyCost) }}/mo
          </option>
        </select>
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
