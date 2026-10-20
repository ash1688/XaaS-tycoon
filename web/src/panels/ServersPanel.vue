<script setup lang="ts">
import { computed, ref } from "vue";
import { SERVER_SIZES, SERVER_TYPES, type ServerSize, type ServerType, type ServerView } from "@xaas/sim";
import { formatCash, formatCount, formatPrice } from "../api";
import { useGame } from "../game";
import AppModal from "../components/AppModal.vue";

// The company's servers, grouped by type and size. On IaaS they're rented and cancelled; on-prem they're bought, sit on
// order until they arrive, and are sold back at a loss. Each type gives one kind of unit; a load balancer gives none,
// but without enough of them extra app servers don't count.
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
const buying = computed(() => game.buysServers);
const typeName = (type: ServerType) => options.value.find((o) => o.type === type)?.name ?? type;
// What the servers cost a month: rent on IaaS, and on-prem the power and upkeep of the kit that has arrived.
const monthlyCost = computed(() =>
  servers.value.filter((s) => !buying.value || s.status === "ready").reduce((sum, s) => sum + s.monthlyCost, 0),
);
const readyDays = computed(() => options.value[0]?.readyDays ?? 1);
const sellBackPercent = computed(() => Math.round(100 * (options.value[0]?.sellBackShare ?? 0)));
const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

// Grouped by type, then size: the order the rent and buy modal offers them in. On-prem, kit on order is listed apart.
const groups = computed(() =>
  SERVER_TYPES.map((type) => ({
    type,
    sizes: SERVER_SIZES.map((size) => {
      const list = servers.value.filter((s) => s.type === type && s.size === size && (!buying.value || s.status === "ready"));
      const pending = list.filter((s) => s.status === "pending");
      return { size, list, pending, units: list.reduce((sum, s) => sum + s.units, 0) };
    }).filter((g) => g.list.length),
  })).filter((g) => g.sizes.length),
);

const readyWhen = (s: ServerView) =>
  game.company && s.readyDay - game.company.day === 1 ? "ready after the next day" : `ready after day ${s.readyDay}`;

// Kit on order, soonest first, with how far through its delivery it is.
const orders = computed(() =>
  [...game.onOrder]
    .sort((a, b) => a.readyDay - b.readyDay || a.id - b.id)
    .map((s) => ({ ...s, progress: Math.round((100 * (readyDays.value - s.daysLeft)) / Math.max(1, readyDays.value)) })),
);

// Load balancers against app servers, counting ones still being set up (or on order) so a student adding a second
// app server is told straight away. What counts today (ready servers only) is in game.units.loadBalancer.
const lb = computed(() => game.units?.loadBalancer);
const lbStatus = computed(() => {
  const from = game.meta?.loadBalancerFrom ?? 2;
  const verb = game.addVerb;
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
      text: `${apps} need a load balancer: without one, traffic only reaches 1 of them. ${verb === "buy" ? "Buy" : "Rent"} a load balancer to use them all.`,
    };
  }
  if (coverage < appCount) {
    const short = appCount - coverage;
    return {
      tone: "warn",
      text: `${lbs} can serve ${coverage} app servers, but you have ${appCount}: ${short} get${short === 1 ? "s" : ""} no traffic. ${verb === "buy" ? "Buy" : "Rent"} a bigger or extra load balancer.`,
    };
  }
  if (lb.value?.uncovered) {
    const until = buying.value ? "arrives" : "is ready";
    return { tone: "warn", text: `Until your new load balancer ${until}, only ${lb.value.counted} app server gets traffic.` };
  }
  const serves = balancers.length === 1 ? "serves" : "serve";
  const room = coverage - appCount;
  const more = room ? `with room for ${room} more` : `and ${balancers.length === 1 ? "is" : "are"} full: another app server needs another load balancer`;
  return { tone: "ok", text: `${lbs} ${serves} your ${apps}, ${more}.` };
});

// Ops a set of servers needs: each one's share, added up and rounded up, as the game counts it. On-prem, only kit that
// has arrived needs ops.
const opsShare = (type: ServerType) => options.value.find((o) => o.type === type)?.ops ?? 0;
const opsFor = (types: ServerType[]) =>
  Math.ceil(Math.round(types.reduce((sum, t) => sum + opsShare(t), 0) * 1e6) / 1e6);

// Renting or buying: pick a type and a size, see the units and price, then confirm.
const adding = ref(false);
const rentType = ref<ServerType>("app");
const rentSize = ref<ServerSize>("small");
const choice = computed(() => options.value.find((o) => o.type === rentType.value && o.size === rentSize.value));
const opsAfter = computed(() => opsFor([...servers.value.map((s) => s.type), rentType.value]));
const perDay = (monthly: number) => formatPrice(Math.round((100 * monthly) / 30) / 100);
const cantAfford = computed(() => !!game.company && (choice.value?.price ?? 0) > game.company.cash);

function openAdd(type: ServerType = "app") {
  rentType.value = type;
  rentSize.value = "small";
  adding.value = true;
}

async function add() {
  const type = buying.value ? "buyServer" : "rentServer";
  await game.act({ type, server: rentType.value, size: rentSize.value });
  if (!game.error) adding.value = false;
}

// Cancelling one of a group (IaaS): one still being set up first, then the newest. Selling one (on-prem): the newest.
const cancelling = ref<ServerView>();
function pickToCancel(list: ServerView[]) {
  cancelling.value = list.findLast((s) => s.status === "pending") ?? list.at(-1);
}

async function cancel() {
  if (!cancelling.value) return;
  await game.act({ type: buying.value ? "sellServer" : "cancelServer", id: cancelling.value.id });
  if (!game.error) cancelling.value = undefined;
}
</script>

<template>
  <section v-if="game.company && game.units" class="card" aria-labelledby="servers-heading" data-testid="servers-panel">
    <div class="row-between panel-head">
      <h2 id="servers-heading">Servers</h2>
      <span v-if="buying" class="muted">
        Running costs <strong data-testid="servers-running">{{ formatCash(monthlyCost) }}</strong> a month
      </span>
      <span v-else class="muted">
        Rent <strong data-testid="servers-rent">{{ formatCash(monthlyCost) }}</strong> a month
      </span>
    </div>
    <p :class="['lb-status', lbStatus.tone]" role="status" data-testid="lb-status">
      <span v-if="lbStatus.tone === 'warn'" class="badge">Load balancer</span>
      <span>{{ lbStatus.text }}</span>
    </p>

    <p v-if="!groups.length" class="muted">
      You have no {{ buying ? "servers in place" : "servers" }}, so nothing can serve your users.
      {{ buying ? "Buy some, and allow for the delivery time." : "Rent some." }}
    </p>
    <div v-for="g in groups" :key="g.type" class="server-group" :data-server-type="g.type">
      <h3>{{ PLURAL[g.type] }}</h3>
      <ul class="server-list">
        <li v-for="s in g.sizes" :key="s.size" :data-server="`${g.type}-${s.size}`">
          <div class="server-info">
            <strong>{{ typeName(g.type) }} · {{ s.size }} × {{ s.list.length }}</strong>
            <span class="muted">
              {{ formatCount(s.units) }} {{ UNIT[g.type] }} ·
              {{ formatCash(s.list.reduce((sum, x) => sum + x.monthlyCost, 0)) }} a month{{ buying ? " to run" : "" }}
            </span>
            <span v-if="s.pending.length" class="pending-note" :data-testid="`pending-${g.type}-${s.size}`">
              {{ s.pending.length }} setting up, {{ readyWhen(s.pending[0]!) }}
            </span>
          </div>
          <button
            v-if="buying"
            class="ghost"
            :disabled="game.busy || game.over"
            :aria-label="`Sell one ${s.size} ${typeName(g.type).toLowerCase()}`"
            :data-testid="`sell-${g.type}-${s.size}`"
            @click="pickToCancel(s.list)"
          >
            Sell one
          </button>
          <button
            v-else
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

    <div v-if="buying" class="server-group on-order" data-testid="on-order">
      <h3>On order</h3>
      <p v-if="!orders.length" class="muted">
        Nothing on order. New kit takes {{ days(readyDays) }} to arrive, so buy before you need it.
      </p>
      <ul v-else class="server-list">
        <li v-for="o in orders" :key="o.id" :data-testid="`order-${o.id}`" :data-order="`${o.type}-${o.size}`">
          <div class="server-info">
            <strong>{{ o.name }} · {{ o.size }}</strong>
            <span class="muted">
              {{ formatCount(o.units) }} {{ UNIT[o.type] }} · paid {{ formatCash(o.paid ?? 0) }}
            </span>
            <span class="pending-note" :data-testid="`order-days-${o.id}`">
              Arrives in {{ days(o.daysLeft) }}, serving from day {{ o.readyDay + 1 }}
            </span>
          </div>
          <div
            class="order-meter"
            role="progressbar"
            :aria-label="`${o.size} ${o.name.toLowerCase()} delivery`"
            :aria-valuenow="o.progress"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div class="order-meter-fill" :style="{ width: `${o.progress}%` }"></div>
          </div>
        </li>
      </ul>
      <p v-if="orders.length" class="muted order-note">
        Orders can't be cancelled: the kit is yours. Once it arrives you can sell it back for {{ sellBackPercent }}% of
        what you paid.
      </p>
    </div>

    <div class="server-actions">
      <button v-if="buying" :disabled="game.busy || game.over" data-testid="buy-open" @click="openAdd()">
        Buy a server
      </button>
      <button v-else :disabled="game.busy || game.over" data-testid="rent-open" @click="openAdd()">Rent a VM</button>
      <span v-if="buying" class="muted">
        Paid for up front, then a small running cost once it arrives. Delivery takes {{ days(readyDays) }}. You need
        <strong>{{ game.company.opsNeeded }}</strong> ops for the kit you have in place; you have {{ game.company.ops }}.
      </span>
      <span v-else class="muted">
        Billed monthly, a day's share at a time. Ready the next day. You need
        <strong>{{ game.company.opsNeeded }}</strong> ops for these servers; you have {{ game.company.ops }}.
      </span>
    </div>

    <AppModal :open="adding" :title="buying ? 'Buy a server' : 'Rent a VM'" @close="adding = false">
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
            <template v-if="o.price !== null">
              <span>{{ formatCash(o.price) }} up front</span>
              <span class="muted">+ {{ formatCash(o.monthlyCost) }} a month</span>
            </template>
            <span v-else class="muted">{{ formatCash(o.monthlyCost) }} a month</span>
          </label>
        </div>
      </fieldset>
      <template v-if="choice">
        <p v-if="choice.price !== null" class="rent-summary" data-testid="buy-summary">
          A {{ choice.size }} {{ choice.name.toLowerCase() }} gives
          <strong>{{ formatCount(choice.units) }} {{ UNIT[choice.type] }}</strong>. It costs
          <strong>{{ formatCash(choice.price) }} up front</strong>, paid now, then
          <strong>{{ formatCash(choice.monthlyCost) }} a month</strong> ({{ perDay(choice.monthlyCost) }} a day) for
          power and upkeep once it arrives. Delivery takes <strong>{{ days(choice.readyDays) }}</strong>: it arrives
          after day {{ game.company.day + choice.readyDays }} and adds nothing until then. You'd need {{ opsAfter }} ops
          once it's in; you have {{ game.company.ops }}. Selling it back later gets {{ sellBackPercent }}% of what you
          paid.
          <template v-if="choice.type === 'app' && lb && lb.appServers + 1 >= (game.meta?.loadBalancerFrom ?? 2)">
            With {{ lb.appServers + 1 }} app servers, you'll need load balancers to serve them all.
          </template>
        </p>
        <p v-else class="rent-summary" data-testid="rent-summary">
          A {{ choice.size }} {{ choice.name.toLowerCase() }} gives
          <strong>{{ formatCount(choice.units) }} {{ UNIT[choice.type] }}</strong> for
          <strong>{{ formatCash(choice.monthlyCost) }} a month</strong> ({{ perDay(choice.monthlyCost) }} a day, from
          tomorrow). It's ready after the next day. You'd need {{ opsAfter }} ops in all; you have
          {{ game.company.ops }}.
          <template v-if="choice.type === 'app' && lb && lb.appServers + 1 >= (game.meta?.loadBalancerFrom ?? 2)">
            With {{ lb.appServers + 1 }} app servers, you'll need load balancers to serve them all.
          </template>
        </p>
        <p v-if="cantAfford" class="warn-text" role="status">
          You have {{ formatCash(game.company.cash) }}: not enough to pay for it.
        </p>
      </template>
      <div class="confirm-buttons">
        <button v-if="buying" :disabled="game.busy || !choice || cantAfford" data-testid="buy-confirm" @click="add">
          Buy it for {{ formatCash(choice?.price ?? 0) }}
        </button>
        <button v-else :disabled="game.busy || !choice" data-testid="rent-confirm" @click="add">Rent it</button>
        <button class="ghost" :disabled="game.busy" @click="adding = false">Not now</button>
      </div>
    </AppModal>

    <AppModal :open="!!cancelling" :title="buying ? 'Sell a server' : 'Cancel a VM'" @close="cancelling = undefined">
      <template v-if="cancelling">
        <p v-if="game.error" class="error" role="alert">{{ game.error }}</p>
        <template v-if="buying">
          <p>
            Sell a {{ cancelling.size }} {{ cancelling.name.toLowerCase() }}
            ({{ formatCount(cancelling.units) }} {{ UNIT[cancelling.type] }})?
          </p>
          <p class="sell-note" data-testid="sell-note">
            You get <strong>{{ formatCash(cancelling.sellBack ?? 0) }}</strong> back ({{ sellBackPercent }}% of the
            {{ formatCash(cancelling.paid ?? 0) }} you paid).
          </p>
          <p class="muted">
            Bought kit is a sunk cost: the rest of what you paid is gone. It stops serving straight away, and buying
            another takes {{ days(readyDays) }} to arrive.
          </p>
          <div class="confirm-buttons">
            <button :disabled="game.busy" data-testid="sell-confirm" @click="cancel">
              Sell it for {{ formatCash(cancelling.sellBack ?? 0) }}
            </button>
            <button class="ghost" :disabled="game.busy" @click="cancelling = undefined">Keep it</button>
          </div>
        </template>
        <template v-else>
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
      </template>
    </AppModal>
  </section>
</template>
