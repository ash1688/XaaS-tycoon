<script setup lang="ts">
import { computed, ref } from "vue";
import { SERVER_SIZES, SERVER_TYPES, type ServerSize, type ServerType, type ServerView } from "@xaas/sim";
import { formatCash, formatCount } from "../api";
import { useGame } from "../game";
import AppModal from "../components/AppModal.vue";
import StepperControl from "../components/StepperControl.vue";

// The company's servers, grouped by type and size. On IaaS they're rented and cancelled; on-prem they're bought, sit on
// order until they arrive, and are sold back at a loss. Each type gives one kind of unit; a load balancer gives none,
// but without enough of them extra app servers don't count. With a paid API, API servers give APIU, and app servers
// can be switched between giving CU and giving APIU.
const game = useGame();
const UNIT: Record<ServerType, string> = { app: "CU", database: "DBU", cache: "CH", loadBalancer: "app servers", api: "APIU" };
const PLURAL: Record<ServerType, string> = {
  app: "App servers",
  database: "Databases",
  cache: "Caches",
  loadBalancer: "Load balancers",
  api: "API servers",
};
const hasApi = computed(() => !!game.company?.api?.owned);

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

// Every type, each with what the company has of it by size, smallest first. On-prem, kit on order is listed apart.
// API servers only with a paid API. App servers switched to APIU are counted apart from the CU.
const groups = computed(() =>
  SERVER_TYPES.filter((type) => type !== "api" || hasApi.value || servers.value.some((s) => s.type === "api")).map((type) => {
    const sizes = SERVER_SIZES.map((size) => {
      const list = servers.value.filter((s) => s.type === type && s.size === size && (!buying.value || s.status === "ready"));
      const pending = list.filter((s) => s.status === "pending");
      const switched = list.filter((s) => s.apiu);
      const units = list.filter((s) => !s.apiu).reduce((sum, s) => sum + s.units, 0);
      return { size, list, pending, switched, units, apiu: switched.reduce((sum, s) => sum + s.units, 0) };
    }).filter((g) => g.list.length);
    const count = sizes.reduce((n, g) => n + g.list.length, 0);
    const apiu = sizes.reduce((sum, g) => sum + g.apiu, 0);
    return { type, sizes, count, units: sizes.reduce((sum, g) => sum + g.units, 0), apiu };
  }),
);

// Switching one app server of a size between CU and APIU: the newest that gives the other.
async function switchOne(list: ServerView[], gives: "cu" | "apiu") {
  const server = list.findLast((s) => s.apiu === (gives === "cu"));
  if (server) await game.act({ type: "switchServer", id: server.id, gives });
}
const hasServers = computed(() => servers.value.length > 0);
const onOrderOf = (type: ServerType) => game.onOrder.filter((s) => s.type === type).length;

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
  // App servers switched to APIU serve API calls, which don't go through the load balancers.
  const appCount = servers.value.filter((s) => s.type === "app" && !s.apiu).length;
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

// The rules that catch players out, said up front: every server needs a share of an ops person, and from a few app
// servers up, each needs a load balancer to get traffic.
const opsRule = computed(() => {
  const shares = SERVER_TYPES.map((t) => ({ t, share: opsShare(t) })).filter((x) => x.share > 0);
  if (!shares.length) return "";
  const each = shares.map(({ t, share }) => `${PLURAL[t].toLowerCase()} ${share} each`).join(", ");
  return `Every server takes up part of an ops person's time (${each}), added up and rounded up.`;
});
// Each tier's bar, by the type of server that gives it, to flag one that's nearly full where more are added.
const TIER_OF: Partial<Record<ServerType, "cu" | "dbu">> = { app: "cu", database: "dbu" };
const tierFor = (type: ServerType) => game.tiers.find((t) => t.id === TIER_OF[type] && t.capacity > 0 && t.level !== "ok");

// Ops a set of servers needs: each one's share, added up and rounded up, as the game counts it. On-prem, only kit that
// has arrived needs ops.
const opsShare = (type: ServerType) => options.value.find((o) => o.type === type)?.ops ?? 0;
const opsFor = (types: ServerType[]) =>
  Math.ceil(Math.round(types.reduce((sum, t) => sum + opsShare(t), 0) * 1e6) / 1e6);

// Each type has a − / + stepper. A size picker chooses only which size the next + adds and − takes away: what the
// student last picked, else the biggest they have of that type, else the smallest. + rents or buys one at once; −
// opens the cancel (IaaS, pro rata) or sell-back (on-prem) confirmation.
const picked = ref<Partial<Record<ServerType, ServerSize>>>({});
function pickSize(type: ServerType, size: ServerSize) {
  picked.value[type] = size;
  game.track("control", { control: `size-${type}`, value: size });
}
const sizeFor = (type: ServerType): ServerSize =>
  picked.value[type] ??
  SERVER_SIZES.toReversed().find((size) => servers.value.some((s) => s.type === type && s.size === size)) ??
  "small";
const ofSize = (type: ServerType, size: ServerSize) => servers.value.filter((s) => s.type === type && s.size === size);
const optionFor = (type: ServerType) => options.value.find((o) => o.type === type && o.size === sizeFor(type));
// Names mid-sentence: lower case, but "API" keeps its capitals.
const lower = (name: string) => (name.startsWith("API") ? name : name.toLowerCase());
const one = (type: ServerType) => `${sizeFor(type)} ${lower(typeName(type))}`;
const verbs = computed(() => (buying.value ? { add: "Buy", remove: "Sell" } : { add: "Rent", remove: "Cancel" }));

function stepValue(type: ServerType) {
  const list = ofSize(type, sizeFor(type));
  const onOrder = buying.value ? list.filter((s) => s.status === "pending").length : 0;
  return `${list.length} ${sizeFor(type)}${onOrder ? ` (${onOrder} on order)` : ""}`;
}
function downWhy(type: ServerType) {
  const list = ofSize(type, sizeFor(type));
  if (!list.length) return `You have no ${one(type)}s to ${buying.value ? "sell" : "cancel"}.`;
  if (buying.value && !list.some((s) => s.status === "ready")) {
    return `Your ${one(type)}s are still on order: you can sell one once it arrives.`;
  }
  return undefined;
}
function upWhy(type: ServerType) {
  const price = optionFor(type)?.price ?? 0;
  if (game.company && price > game.company.cash) {
    return `A ${one(type)} costs ${formatCash(price)} up front and you have ${formatCash(game.company.cash)}.`;
  }
  return undefined;
}
// What + does, said before pressing it.
function stepNote(type: ServerType) {
  const o = optionFor(type);
  if (!o || !game.company) return "";
  const what = `${formatCount(o.units)} ${UNIT[type]}`;
  const ops = opsFor([...servers.value.map((s) => s.type), type]);
  const short = ops - game.company.ops;
  const opsText =
    short > 0
      ? ` You'd need ${ops} ops in all and have ${game.company.ops}: hire ${short} more, or capacity is cut.`
      : ` You'd need ${ops} ops in all; you have ${game.company.ops}.`;
  const appServers = servers.value.filter((s) => s.type === "app" && !s.apiu).length + 1;
  const lbHint =
    type === "app" && appServers >= (game.meta?.loadBalancerFrom ?? 2)
      ? ` With ${appServers} app servers, you'll need load balancers to serve them all.`
      : "";
  if (o.price !== null) {
    return `+ buys a ${one(type)} (${what}) for ${formatCash(o.price)} up front, paid now, then ${formatCash(o.monthlyCost)} a month once it arrives in ${days(o.readyDays)}.${opsText}${lbHint}`;
  }
  return `+ rents a ${one(type)} (${what}) for ${formatCash(o.monthlyCost)} a month from tomorrow, ready after the next day.${opsText}${lbHint}`;
}

async function stepUp(type: ServerType) {
  await game.act({ type: buying.value ? "buyServer" : "rentServer", server: type, size: sizeFor(type) });
}
function stepDown(type: ServerType) {
  const list = ofSize(type, sizeFor(type));
  pickToCancel(buying.value ? list.filter((s) => s.status === "ready") : list);
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
  <section v-if="game.company && game.units && !game.managed" class="card" aria-labelledby="servers-heading" data-testid="servers-panel">
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

    <ul class="server-rules muted" data-testid="server-rules">
      <li v-if="opsRule">
        <strong>Ops:</strong> {{ opsRule }} You need <strong>{{ game.company.opsNeeded }}</strong> now<template
          v-if="game.company.opsNeededOnceReady > game.company.opsNeeded"
          >, <strong>{{ game.company.opsNeededOnceReady }}</strong> once your kit on order arrives</template
        >; you have {{ game.company.ops }}.
      </li>
      <li>
        <strong>Load balancers:</strong> from {{ game.meta?.loadBalancerFrom ?? 2 }} app servers up, traffic only
        reaches the app servers a load balancer covers. Each size covers a set number of them.
      </li>
      <li v-if="hasApi" data-testid="apiu-rule">
        <strong>API calls:</strong> your API's calls need APIU. API servers give it, or switch an app server to give
        APIU instead of CU, as many of either: that trades user capacity for API capacity.
      </li>
    </ul>

    <p v-if="!hasServers" class="muted" data-testid="no-servers">
      You have no {{ buying ? "servers in place" : "servers" }}, so nothing can serve your users.
      {{ buying ? "Buy an app server and a database with +, and allow for the delivery time." : "Rent an app server and a database with +." }}
    </p>
    <div v-for="g in groups" :key="g.type" class="server-group" :data-server-type="g.type">
      <div class="row-between">
        <h3>{{ PLURAL[g.type] }}</h3>
        <span class="muted" :data-testid="`count-${g.type}`">
          {{ g.count }} {{ buying ? "in place" : "rented" }}<template v-if="g.count"> · {{ formatCount(g.units) }} {{ UNIT[g.type] }}</template
          ><template v-if="g.apiu"> · {{ formatCount(g.apiu) }} APIU</template
          ><template v-if="buying && onOrderOf(g.type)"> · {{ onOrderOf(g.type) }} on order</template>
        </span>
      </div>
      <p v-if="tierFor(g.type)" class="warn-text tier-warning" :data-testid="`tier-warning-${g.type}`">
        <span class="badge">{{ tierFor(g.type)!.level === "over" ? "Over capacity" : "Nearly full" }}</span>
        {{ tierFor(g.type)!.name }} is at {{ tierFor(g.type)!.percent }}%: {{ game.tierFix(tierFor(g.type)!.id) }}
        {{ tierFor(g.type)!.level === "over" ? "now" : "before it hits 100%" }}.
      </p>
      <ul v-if="g.sizes.length" class="server-list">
        <li v-for="s in g.sizes" :key="s.size" :data-server="`${g.type}-${s.size}`">
          <div class="server-info">
            <strong>{{ typeName(g.type) }} · {{ s.size }} × {{ s.list.length }}</strong>
            <span class="muted">
              {{ formatCount(s.units) }} {{ UNIT[g.type] }}<template v-if="s.apiu"> and {{ formatCount(s.apiu) }} APIU</template> ·
              {{ formatCash(s.list.reduce((sum, x) => sum + x.monthlyCost, 0)) }} a month{{ buying ? " to run" : "" }}
            </span>
            <span v-if="s.switched.length" class="managed-note" :data-testid="`switched-${s.size}`">
              {{ s.switched.length }} switched to APIU, serving API calls instead of users
            </span>
            <span v-if="s.pending.length" class="pending-note" :data-testid="`pending-${g.type}-${s.size}`">
              {{ s.pending.length }} setting up, {{ readyWhen(s.pending[0]!) }}
            </span>
          </div>
          <div v-if="g.type === 'app' && hasApi" class="switch-buttons">
            <button
              class="ghost"
              :disabled="game.busy || game.over || s.switched.length === s.list.length"
              :data-testid="`switch-apiu-${s.size}`"
              @click="switchOne(s.list, 'apiu')"
            >
              Switch one to APIU
            </button>
            <button
              class="ghost"
              :disabled="game.busy || game.over || !s.switched.length"
              :data-testid="`switch-cu-${s.size}`"
              @click="switchOne(s.list, 'cu')"
            >
              Switch one to CU
            </button>
          </div>
        </li>
      </ul>
      <div class="server-step managed-controls">
        <label class="size-select">
          <span>Size to {{ verbs.add.toLowerCase() }} or {{ verbs.remove.toLowerCase() }}</span>
          <select
            :value="sizeFor(g.type)"
            :disabled="game.busy || game.over"
            :data-testid="`size-${g.type}`"
            @change="pickSize(g.type, ($event.target as HTMLSelectElement).value as ServerSize)"
          >
            <option v-for="o in options.filter((x) => x.type === g.type)" :key="o.size" :value="o.size">
              {{ o.size }} · {{ formatCount(o.units) }} {{ UNIT[g.type] }} ·
              {{ o.price !== null ? `${formatCash(o.price)} + ${formatCash(o.monthlyCost)}/mo` : `${formatCash(o.monthlyCost)}/mo` }}
            </option>
          </select>
        </label>
        <StepperControl
          :label="`${sizeFor(g.type)} ${lower(PLURAL[g.type])}`"
          :value="stepValue(g.type)"
          :down-label="`${verbs.remove} a ${one(g.type)}`"
          :up-label="`${verbs.add} a ${one(g.type)}`"
          :down-why="downWhy(g.type)"
          :up-why="upWhy(g.type)"
          :disabled="game.busy || game.over"
          :testid="`step-${g.type}`"
          @down="stepDown(g.type)"
          @up="stepUp(g.type)"
        />
      </div>
      <p class="muted step-note" :data-testid="`step-note-${g.type}`">{{ stepNote(g.type) }}</p>
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
            :aria-label="`${o.size} ${lower(o.name)} delivery`"
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

    <p class="muted server-actions">
      <template v-if="buying">
        Paid for up front, then a small running cost once it arrives. Delivery takes {{ days(readyDays) }}. You need
        <strong>{{ game.company.opsNeeded }}</strong> ops for the kit you have in place; you have {{ game.company.ops }}.
      </template>
      <template v-else>
        Billed monthly, a day's share at a time. Ready the next day. You need
        <strong>{{ game.company.opsNeeded }}</strong> ops for these servers; you have {{ game.company.ops }}.
      </template>
    </p>
    <p v-if="game.error && !cancelling" class="error" role="alert">{{ game.error }}</p>

    <AppModal :open="!!cancelling" :title="buying ? 'Sell a server' : 'Cancel a VM'" @close="cancelling = undefined">
      <template v-if="cancelling">
        <p v-if="game.error" class="error" role="alert">{{ game.error }}</p>
        <template v-if="buying">
          <p>
            Sell a {{ cancelling.size }} {{ lower(cancelling.name) }}
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
            Cancel a {{ cancelling.size }} {{ lower(cancelling.name) }}
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
