<script setup lang="ts">
import { computed, ref } from "vue";
import type { ManagedOption, ManagedService, ServerSize } from "@xaas/sim";
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
// PaaS autoscaling (#261): the instances set by hand are the minimum, and a maximum caps the burst instances.
const scale = computed(() => game.company?.autoscale ?? null);
const setMax = (max: number) => game.act({ type: "setAutoscaleMax", max });
// With a paid API: API instances, the instance size, each giving APIU for its calls.
const hasApi = computed(() => !!game.company?.api?.owned);
const apiu = computed(() => (m.value ? m.value.apiInstances * m.value.apiInstanceUnits : 0));
const setApiInstances = (count: number) => game.act({ type: "setApiInstances", count });

// The database and cache: you run at most one of each, grown by picking a bigger size. Each shows what runs now, a size
// picker and one button: add one at the size picked with none running, or resize to it, saying what that does to
// capacity and the monthly bill. The cache can be removed; the database can't, since every product stores data.
const SERVICES: ManagedService[] = ["database", "cache"];
const picked = ref<Partial<Record<ManagedService, ServerSize>>>({});
// A server from before databases could be missing sent the smallest with no units for none: that's none too.
const current = (service: ManagedService) => {
  const now = (service === "database" ? m.value?.database : m.value?.cache) ?? null;
  return now && now.units > 0 ? now : null;
};
const sizes = (service: ManagedService): ManagedOption[] =>
  (service === "database" ? (m.value?.databaseOptions ?? m.value?.database?.options) : m.value?.cacheOptions) ?? [];
// The size picked: with one running and nothing picked yet, the next size up, so the button says what growing gives.
function sizeOf(service: ManagedService): ServerSize {
  const choice = picked.value[service];
  if (choice) return choice;
  const now = current(service);
  const all = sizes(service);
  if (!now) return all[0]?.size ?? "small";
  return all[all.findIndex((o) => o.size === now.size) + 1]?.size ?? now.size;
}
const option = (service: ManagedService) => sizes(service).find((o) => o.size === sizeOf(service));
const unitOf = (service: ManagedService) => (service === "database" ? "DBU" : "CH");
const optionText = (service: ManagedService, o: ManagedOption) =>
  `${o.size} · ${formatCount(o.units)} ${unitOf(service)} · ${formatCash(o.monthlyCost)}/mo`;

// The button: add, resize, or nothing to do when the size picked is the one running.
function buttonText(service: ManagedService) {
  const o = option(service);
  if (!o) return "";
  const what = `${formatCount(o.units)} ${unitOf(service)}, ${formatCash(o.monthlyCost)} a month`;
  return current(service) ? `Resize to ${o.size} (${what})` : `Add a ${o.size} ${service} (${what})`;
}
const unchanged = (service: ManagedService) => current(service)?.size === sizeOf(service);
// What a resize changes: "15 DBU more, £1,375 a month more".
function changeText(service: ManagedService) {
  const now = current(service);
  const o = option(service);
  if (!now || !o || now.size === o.size) return "";
  const units = o.units - now.units;
  const cost = o.monthlyCost - now.monthlyCost;
  const unitPart = `${formatCount(Math.abs(units))} ${unitOf(service)} ${units > 0 ? "more" : "less"}`;
  return `${unitPart}, ${formatCash(Math.abs(cost))} a month ${cost > 0 ? "more" : "less"}. Ready at once.`;
}

function pick(service: ManagedService, size: string) {
  picked.value[service] = size as ServerSize;
}
async function apply(service: ManagedService) {
  game.track("control", { control: `managed-${service}`, value: current(service) ? "resize" : "add" });
  await game.act({ type: "setManagedService", service, size: sizeOf(service) });
  delete picked.value[service];
}
async function remove(service: ManagedService) {
  game.track("control", { control: `managed-${service}`, value: "remove" });
  await game.act({ type: "setManagedService", service, size: null });
  delete picked.value[service];
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

      <li v-if="scale" data-testid="platform-autoscale">
        <div class="server-info">
          <strong>{{ scale.managed ? "Managed autoscaling" : "Basic autoscaling" }}</strong>
          <span class="muted" data-testid="autoscale-summary">
            Instances {{ scale.instances }} (min {{ scale.min }}, max {{ scale.max }}). Each night the platform sets
            them to {{ scale.baseline }}× yesterday's demand, never below the {{ scale.min }} you set. During a day, burst instances cover
            spikes up to your maximum, at {{ formatCash(scale.burstDayCost) }} each for the day. Demand over the maximum
            is an outage.
          </span>
          <span class="managed-note">Your minimum is your insurance if the autoscaler fails.</span>
        </div>
        <StepperControl
          label="Autoscaling maximum"
          :value="String(scale.max)"
          down-label="Lower the autoscaling maximum"
          up-label="Raise the autoscaling maximum"
          :down-why="scale.max <= scale.min ? `It can't go below your minimum of ${scale.min} instances.` : undefined"
          :up-why="scale.max >= m.maxInstances ? `The platform runs at most ${m.maxInstances} instances.` : undefined"
          :disabled="game.busy || game.over"
          testid="autoscale-max"
          @down="setMax(scale.max - 1)"
          @up="setMax(scale.max + 1)"
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

      <li v-for="service in SERVICES" :key="service" :data-testid="`platform-${service}`">
        <div class="server-info">
          <strong>Managed {{ service }}</strong>
          <span v-if="current(service)" class="managed-now" :data-testid="`managed-${service}-current`">
            1 {{ current(service)!.size }} · {{ formatCount(current(service)!.units) }} {{ unitOf(service) }} ·
            {{ formatCash(current(service)!.monthlyCost) }}/mo
          </span>
          <span v-else-if="service === 'database'" class="muted warn-text" data-testid="no-database">
            None yet. Your product needs a database to serve users: pick a size and add it.
          </span>
          <span v-else class="muted" :data-testid="`managed-${service}-current`">None</span>
          <span class="muted">
            <template v-if="service === 'database'">
              Stores your data. You run one, grown by resizing it; it can't be removed.
            </template>
            <template v-else>Answers repeat reads: each cache hit takes a DBU off the database. Optional.</template>
          </span>
          <span class="managed-note">Managed by provider: no ops needed.</span>
        </div>
        <div class="managed-controls">
          <label class="size-select">
            <span>Size</span>
            <select
              :value="sizeOf(service)"
              :disabled="game.busy || game.over"
              :data-testid="`managed-${service}-size`"
              @change="pick(service, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="o in sizes(service)" :key="o.size" :value="o.size">{{ optionText(service, o) }}</option>
            </select>
          </label>
          <div class="managed-actions">
            <button
              v-if="!unchanged(service)"
              type="button"
              class="small"
              :disabled="game.busy || game.over"
              :data-testid="`managed-${service}-apply`"
              @click="apply(service)"
            >
              {{ buttonText(service) }}
            </button>
            <button
              v-if="service === 'cache' && current(service)"
              type="button"
              class="ghost small"
              :disabled="game.busy || game.over"
              data-testid="managed-cache-remove"
              @click="remove(service)"
            >
              Remove the cache
            </button>
          </div>
        </div>
        <p v-if="changeText(service)" class="muted step-note" :data-testid="`managed-${service}-change`">
          {{ changeText(service) }}
        </p>
        <p v-else-if="unchanged(service)" class="muted step-note" :data-testid="`managed-${service}-change`">
          This is the size you run: pick another to resize it.
        </p>
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
