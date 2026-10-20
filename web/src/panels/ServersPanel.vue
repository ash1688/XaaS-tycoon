<script setup lang="ts">
import { computed, ref } from "vue";
import { SERVER_SIZES, SERVER_TYPES, type ServerSize, type ServerType, type ServerView } from "@xaas/sim";
import { formatCash, formatCount, formatPrice } from "../api";
import { useGame } from "../game";
import AppModal from "../components/AppModal.vue";

// The company's servers on IaaS, grouped by type and size, with renting and cancelling. Each type gives one kind of
// unit; a load balancer gives none, but without enough of them extra app servers don't count.
const game = useGame();
const UNIT: Record<ServerType, string> = { app: "CU", database: "DBU", cache: "CH", loadBalancer: "app servers" };
const PLURAL: Record<ServerType, string> = {
  app: "App servers",
  database: "Databases",
  cache: "Caches",
  loadBalancer: "Load balancers",
};

const options = computed(() => game.company?.serverOptions ?? []);
const servers = computed(() => game.company?.servers ?? []);
const typeName = (type: ServerType) => options.value.find((o) => o.type === type)?.name ?? type;
const monthlyRent = computed(() => servers.value.reduce((sum, s) => sum + s.monthlyCost, 0));

// Grouped by type, then size: the order the rent modal offers them in.
const groups = computed(() =>
  SERVER_TYPES.map((type) => ({
    type,
    sizes: SERVER_SIZES.map((size) => {
      const list = servers.value.filter((s) => s.type === type && s.size === size);
      const pending = list.filter((s) => s.status === "pending");
      return { size, list, pending, units: list.reduce((sum, s) => sum + s.units, 0) };
    }).filter((g) => g.list.length),
  })).filter((g) => g.sizes.length),
);

const readyWhen = (s: ServerView) =>
  game.company && s.readyDay - game.company.day === 1 ? "ready after the next day" : `ready after day ${s.readyDay}`;

// Load balancers against app servers, counting ones still being set up so a student renting a second app server is
// told straight away. What counts today (ready servers only) is in game.units.loadBalancer.
const lb = computed(() => game.units?.loadBalancer);
const lbStatus = computed(() => {
  const from = game.meta?.loadBalancerFrom ?? 2;
  const appCount = servers.value.filter((s) => s.type === "app").length;
  const balancers = servers.value.filter((s) => s.type === "loadBalancer");
  const coverage = balancers.reduce((sum, s) => sum + s.units, 0);
  const apps = `${appCount} app server${appCount === 1 ? "" : "s"}`;
  const lbs = `${balancers.length} load balancer${balancers.length === 1 ? "" : "s"}`;
  if (appCount < from) {
    return { tone: "ok", text: `${apps}: no load balancer needed until you run ${from} or more.` };
  }
  if (!balancers.length) {
    return {
      tone: "warn",
      text: `${apps} need a load balancer: without one, traffic only reaches 1 of them. Rent a load balancer to use them all.`,
    };
  }
  if (coverage < appCount) {
    const short = appCount - coverage;
    return {
      tone: "warn",
      text: `${lbs} can serve ${coverage} app servers, but you have ${appCount}: ${short} get${short === 1 ? "s" : ""} no traffic. Rent a bigger or extra load balancer.`,
    };
  }
  if (lb.value?.uncovered) {
    return { tone: "warn", text: `Until your new load balancer is ready, only ${lb.value.counted} app server gets traffic.` };
  }
  const verb = balancers.length === 1 ? "serves" : "serve";
  const room = coverage - appCount;
  const more = room ? `with room for ${room} more` : `and ${balancers.length === 1 ? "is" : "are"} full: another app server needs another load balancer`;
  return { tone: "ok", text: `${lbs} ${verb} your ${apps}, ${more}.` };
});

// Ops a set of servers needs: each one's share, added up and rounded up, as the game counts it.
const opsShare = (type: ServerType) => options.value.find((o) => o.type === type)?.ops ?? 0;
const opsFor = (types: ServerType[]) =>
  Math.ceil(Math.round(types.reduce((sum, t) => sum + opsShare(t), 0) * 1e6) / 1e6);

// Renting: pick a type and a size, see the units and price, then confirm.
const renting = ref(false);
const rentType = ref<ServerType>("app");
const rentSize = ref<ServerSize>("small");
const choice = computed(() => options.value.find((o) => o.type === rentType.value && o.size === rentSize.value));
const opsAfter = computed(() => opsFor([...servers.value.map((s) => s.type), rentType.value]));
const perDay = (monthly: number) => formatPrice(Math.round((100 * monthly) / 30) / 100);

function openRent(type: ServerType = "app") {
  rentType.value = type;
  rentSize.value = "small";
  renting.value = true;
}

async function rent() {
  await game.act({ type: "rentServer", server: rentType.value, size: rentSize.value });
  if (!game.error) renting.value = false;
}

// Cancelling one of a group: one still being set up first, then the newest.
const cancelling = ref<ServerView>();
function pickToCancel(list: ServerView[]) {
  cancelling.value = list.findLast((s) => s.status === "pending") ?? list.at(-1);
}

async function cancel() {
  if (!cancelling.value) return;
  await game.act({ type: "cancelServer", id: cancelling.value.id });
  if (!game.error) cancelling.value = undefined;
}
</script>

<template>
  <section v-if="game.company && game.units" class="card" aria-labelledby="servers-heading" data-testid="servers-panel">
    <div class="row-between panel-head">
      <h2 id="servers-heading">Servers</h2>
      <span class="muted">
        Rent <strong data-testid="servers-rent">{{ formatCash(monthlyRent) }}</strong> a month
      </span>
    </div>
    <p :class="['lb-status', lbStatus.tone]" role="status" data-testid="lb-status">
      <span v-if="lbStatus.tone === 'warn'" class="badge">Load balancer</span>
      <span>{{ lbStatus.text }}</span>
    </p>

    <p v-if="!servers.length" class="muted">You have no servers, so nothing can serve your users. Rent some.</p>
    <div v-for="g in groups" :key="g.type" class="server-group" :data-server-type="g.type">
      <h3>{{ PLURAL[g.type] }}</h3>
      <ul class="server-list">
        <li v-for="s in g.sizes" :key="s.size" :data-server="`${g.type}-${s.size}`">
          <div class="server-info">
            <strong>{{ typeName(g.type) }} · {{ s.size }} × {{ s.list.length }}</strong>
            <span class="muted">
              {{ formatCount(s.units) }} {{ UNIT[g.type] }} ·
              {{ formatCash(s.list.reduce((sum, x) => sum + x.monthlyCost, 0)) }} a month
            </span>
            <span v-if="s.pending.length" class="pending-note" :data-testid="`pending-${g.type}-${s.size}`">
              {{ s.pending.length }} setting up, {{ readyWhen(s.pending[0]!) }}
            </span>
          </div>
          <button
            class="ghost"
            :disabled="game.busy || game.over"
            :aria-label="`Cancel one ${s.size} ${typeName(g.type).toLowerCase()}`"
            @click="pickToCancel(s.list)"
          >
            Cancel one
          </button>
        </li>
      </ul>
    </div>

    <div class="server-actions">
      <button :disabled="game.busy || game.over" data-testid="rent-open" @click="openRent()">Rent a VM</button>
      <span class="muted">
        Billed monthly, a day's share at a time. Ready the next day. You need
        <strong>{{ game.company.opsNeeded }}</strong> ops for these servers; you have {{ game.company.ops }}.
      </span>
    </div>

    <AppModal :open="renting" title="Rent a VM" @close="renting = false">
      <p v-if="game.error" class="error" role="alert">{{ game.error }}</p>
      <fieldset :disabled="game.busy">
        <legend>Type</legend>
        <div class="choices">
          <label
            v-for="type in SERVER_TYPES"
            :key="type"
            :class="['choice', { on: rentType === type }]"
            :data-rent-type="type"
          >
            <input v-model="rentType" type="radio" name="rent-type" :value="type" />
            <strong>{{ typeName(type) }}</strong>
            <span class="muted">{{ options.find((o) => o.type === type)?.blurb }}</span>
          </label>
        </div>
      </fieldset>
      <fieldset :disabled="game.busy">
        <legend>Size</legend>
        <div class="choices size-choices">
          <label
            v-for="o in options.filter((x) => x.type === rentType)"
            :key="o.size"
            :class="['choice', { on: rentSize === o.size }]"
            :data-rent-size="o.size"
          >
            <input v-model="rentSize" type="radio" name="rent-size" :value="o.size" />
            <strong>{{ o.size }}</strong>
            <span>{{ formatCount(o.units) }} {{ UNIT[o.type] }}</span>
            <span class="muted">{{ formatCash(o.monthlyCost) }} a month</span>
          </label>
        </div>
      </fieldset>
      <p v-if="choice" class="rent-summary" data-testid="rent-summary">
        A {{ choice.size }} {{ choice.name.toLowerCase() }} gives
        <strong>{{ formatCount(choice.units) }} {{ UNIT[choice.type] }}</strong> for
        <strong>{{ formatCash(choice.monthlyCost) }} a month</strong> ({{ perDay(choice.monthlyCost) }} a day, from
        tomorrow). It's ready after the next day. You'd need {{ opsAfter }} ops in all; you have
        {{ game.company.ops }}.
        <template v-if="choice.type === 'app' && lb && lb.appServers + 1 >= (game.meta?.loadBalancerFrom ?? 2)">
          With {{ lb.appServers + 1 }} app servers, you'll need load balancers to serve them all.
        </template>
      </p>
      <div class="confirm-buttons">
        <button :disabled="game.busy || !choice" data-testid="rent-confirm" @click="rent">Rent it</button>
        <button class="ghost" :disabled="game.busy" @click="renting = false">Not now</button>
      </div>
    </AppModal>

    <AppModal :open="!!cancelling" title="Cancel a VM" @close="cancelling = undefined">
      <template v-if="cancelling">
        <p v-if="game.error" class="error" role="alert">{{ game.error }}</p>
        <p>
          Cancel a {{ cancelling.size }} {{ cancelling.name.toLowerCase() }}
          ({{ formatCount(cancelling.units) }} {{ UNIT[cancelling.type] }}, {{ formatCash(cancelling.monthlyCost) }} a
          month)?
        </p>
        <p class="muted" data-testid="pro-rata-note">
          Pro rata: its rent stops from tomorrow, so you only pay for the days you had it. It stops serving straight
          away, and renting another takes a day to set up.
        </p>
        <div class="confirm-buttons">
          <button :disabled="game.busy" data-testid="cancel-confirm" @click="cancel">Cancel it</button>
          <button class="ghost" :disabled="game.busy" @click="cancelling = undefined">Keep it</button>
        </div>
      </template>
    </AppModal>
  </section>
</template>
