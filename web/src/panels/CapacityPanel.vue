<script setup lang="ts">
import { computed } from "vue";
import { formatCash, formatCount, formatPrice, formatUptime } from "../api";
import { useGame, type Tier } from "../game";

// Load against capacity on the day just played, and uptime so far. Over 100% load is an outage. On a model with
// servers (on-prem, IaaS and PaaS), a bar each for CU, DBU and CH: whichever of CU or DBU runs out first sets
// capacity, and one with none sets it to nothing. Missing ops cut every bar, shown on each. Before launch, what has to
// be ready for the first users. SaaS has no servers and no limit: capacity is the provider's job, and what you pay for
// it is the per-user bill.
const game = useGame();
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const cachePercent = () => Math.round(100 * (game.meta?.cacheableShare ?? 0));
const cutPercent = computed(() => Math.round(100 * (game.units?.burst ? 0 : (game.units?.opsCut ?? 0))));

// What gives CU and DBU: app servers (or instances) and databases, ready or on their way.
const TIER_TYPE = { cu: "app", dbu: "database" } as const;
const has = (tier: "cu" | "dbu") => {
  const m = game.managed;
  if (m) return tier === "cu" ? m.instances > 0 : !!m.database;
  return (game.company?.servers ?? []).some((s) => s.type === TIER_TYPE[tier] && !s.apiu);
};
const nextReady = (tier: "cu" | "dbu") =>
  (game.company?.servers ?? [])
    .filter((s) => s.type === TIER_TYPE[tier] && !s.apiu && s.status === "pending")
    .sort((a, b) => a.readyDay - b.readyDay)[0];
const NONE = {
  cu: { none: "No app servers", one: "an app server", managed: "No app instances", oneManaged: "an instance" },
  dbu: { none: "No database", one: "a database", managed: "No database", oneManaged: "a managed database" },
} as const;
// A CU or DBU bar with no capacity: nothing can be served until it has some.
function noneNote(t: Tier) {
  const id = t.id as "cu" | "dbu";
  const n = NONE[id];
  const none = game.managed ? n.managed : n.none;
  const pending = nextReady(id);
  if (pending) return `${none} ready yet: you can't serve any users until yours is ready, after day ${pending.readyDay}.`;
  const add = game.managed ? `Set up ${n.oneManaged}` : `${game.addVerb === "buy" ? "Buy" : "Rent"} ${n.one}`;
  return `${none}: you can't serve any users until one is ready. ${add} on the Servers panel.`;
}

// Before the first users come: what has to be ready by the time the MVP is done. A cache is optional.
const launchNeeds = computed(() => {
  const c = game.company;
  const l = c?.launch;
  if (!c || !l || !l.needsServers || !["waiting", "upcoming", "ready"].includes(l.status)) return null;
  const building = !c.mvp.done && c.mvp.total > 0;
  const day = building && c.mvp.launchDay !== null ? ` (day ${c.mvp.launchDay})` : "";
  return {
    when: building ? `by the time your MVP is done${day}` : "before any users can join",
    items: [
      { id: "app", text: game.managed ? "At least one app instance" : "At least one app server", done: has("cu") },
      { id: "database", text: game.managed ? "A managed database" : "At least one database", done: has("dbu") },
    ],
  };
});
</script>

<template>
  <section v-if="game.company" class="card" aria-labelledby="capacity-heading">
    <div class="row-between panel-head">
      <h2 id="capacity-heading">Capacity</h2>
      <span class="muted">
        Uptime <strong>{{ formatUptime(game.company.uptime) }}</strong>
        <template v-if="game.company.outageDays">
          · {{ game.company.outageDays }} outage day{{ game.company.outageDays === 1 ? "" : "s" }}
        </template>
      </span>
    </div>

    <div v-if="launchNeeds" class="launch-needs" data-testid="launch-needs">
      <p>
        <strong>Before launch:</strong> you need these ready {{ launchNeeds.when }}. A cache is optional.
      </p>
      <ul>
        <li v-for="item in launchNeeds.items" :key="item.id" :class="{ done: item.done }" :data-testid="`launch-need-${item.id}`">
          <span aria-hidden="true">{{ item.done ? "✓" : "○" }}</span> {{ item.text
          }}<span class="visually-hidden">{{ item.done ? " (done)" : " (to do)" }}</span>
        </li>
      </ul>
    </div>

    <div v-if="game.units" class="capacity" data-testid="capacity">
      <details class="how-it-works">
        <summary>How this works</summary>
        <p v-if="game.managed" class="muted unit-intro">
          Each user needs compute (CU) from your app instances and database units (DBU) from the managed database. A
          managed cache takes some database load off as cache hits (CH). Whichever of CU or DBU runs out first caps what
          you can serve.
        </p>
        <p v-else class="muted unit-intro">
          Each user needs compute (CU) from app servers and database units (DBU) from databases. Caches take some
          database load off as cache hits (CH). Whichever of CU or DBU runs out first caps what you can serve. Too few
          ops staff cut every tier.
        </p>
      </details>
      <div
        v-for="t in game.tiers"
        :key="t.id"
        :class="['unit-tier', { binding: t.binding }]"
        :data-tier="t.id"
        :data-testid="`tier-${t.id}`"
      >
        <div class="row-between">
          <span :id="`tier-${t.id}-label`" class="label">
            {{ t.name }} ({{ t.unit }})
            <span v-if="t.binding" class="badge binding-badge">Sets your capacity</span>
            <span
              v-if="t.id !== 'ch' && t.capacity > 0 && t.level !== 'ok'"
              class="badge nearly-full-badge"
              :data-testid="`tier-${t.id}-nearly-full`"
            >
              {{ t.level === "over" ? "Over capacity" : "Nearly full" }}
            </span>
          </span>
          <span class="figures" :data-testid="`tier-${t.id}-figures`">
            {{ formatCount(t.demand) }} / {{ formatCount(t.capacity) }} {{ t.unit }}
          </span>
        </div>
        <div
          class="meter"
          role="meter"
          :aria-labelledby="`tier-${t.id}-label`"
          aria-valuemin="0"
          :aria-valuemax="t.capacity"
          :aria-valuenow="Math.min(t.demand, t.capacity)"
          :aria-valuetext="t.capacity > 0 ? `${t.percent}% of capacity` : 'No capacity'"
        >
          <div
            :class="['meter-fill', t.id === 'ch' && t.level === 'over' ? 'high' : t.level]"
            :style="{ width: `${Math.min(100, t.percent)}%` }"
          ></div>
        </div>
        <p v-if="t.rated > t.capacity" class="capacity-note cut-note warn-text" :data-testid="`tier-${t.id}-cut`">
          {{ formatCount(t.capacity) }} of {{ formatCount(t.rated) }} {{ t.unit }}: cut {{ cutPercent }}%, {{ game.opsShort }}
          ops short.
        </p>
        <p :class="['capacity-note', t.id === 'ch' && t.level === 'over' ? 'high' : t.level]" :data-testid="`tier-${t.id}-note`">
          <template v-if="t.id === 'ch'">
            <template v-if="!t.capacity">
              No cache. It's optional: one can take up to {{ cachePercent() }}% of database demand.
            </template>
            <template v-else>
              Took <strong>{{ formatCount(game.units.ch.absorbed) }}</strong> DBU off the database, of up to
              {{ formatCount(t.demand) }} it can take ({{ cachePercent() }}% of database demand).
              <template v-if="t.level === 'over'">Cache full: a bigger one would take more.</template>
            </template>
          </template>
          <template v-else-if="t.capacity <= 0">
            <strong>{{ noneNote(t) }}</strong>
          </template>
          <template v-else>
            <strong>{{ t.percent }}%</strong> used.
            <template v-if="t.id === 'dbu' && game.units.ch.absorbed">
              {{ formatCount(game.units.dbu.beforeCache) }} DBU of demand, {{ formatCount(game.units.ch.absorbed) }} of
              it taken by the cache.
            </template>
            <template v-if="t.level === 'over'"> Over capacity: expect outages. {{ sentence(game.tierFix(t.id, "now")) }}.</template>
            <template v-else-if="t.level === 'high'"> Getting close: {{ game.tierFix(t.id, "soon") }}.</template>
            <template v-if="t.id === 'cu' && !game.units.loadBalancer.uncovered && game.lbShortSoon">
              Once your new servers are ready, {{ game.lbShortSoon }} app server{{ game.lbShortSoon === 1 ? "" : "s" }}
              won't count without another load balancer.
            </template>
            <template v-if="t.id === 'cu' && game.units.loadBalancer.uncovered">
              {{ game.units.loadBalancer.uncovered }} app server{{ game.units.loadBalancer.uncovered === 1 ? " isn't" : "s aren't" }}
              counted: no load balancer covers {{ game.units.loadBalancer.uncovered === 1 ? "it" : "them" }}.
            </template>
          </template>
        </p>
      </div>
      <p class="muted capacity-note" data-testid="users-supported">
        Your {{ game.managed ? "instances and managed services" : "ready servers" }} serve about
        <strong>{{ formatCount(game.units.usersSupported) }}</strong> users at your product's usual demand. You have
        {{ formatCount(game.company.users) }} users, free users included.
        <template v-if="game.units.burst && game.managed">Today that includes the extra capacity the platform scaled up for the event.</template>
        <template v-else-if="game.units.burst">Today that includes the extra VMs your ops team rented for the event.</template>
        <template v-if="game.onOrder.length">
          The {{ game.onOrder.length }} server{{ game.onOrder.length === 1 ? "" : "s" }} you have on order add nothing
          until {{ game.onOrder.length === 1 ? "it arrives" : "they arrive" }}.
        </template>
      </p>
      <p v-if="game.understaffed" class="warn-text capacity-staff" data-testid="capacity-ops-short">
        You're {{ game.opsPeople(game.opsShort) }} short, so every tier is cut<template v-if="cutPercent">
          by {{ cutPercent }}%</template>. Hiring them gets it all back.
        <RouterLink :to="`${game.base}/people`">Hire ops on the People page</RouterLink>.
      </p>
    </div>

    <div v-else-if="game.provider" class="capacity provider-capacity" data-testid="capacity">
      <p class="lb-status provider-status" data-testid="provider-managed">
        <span class="badge provider-badge">Provider-managed</span>
        <span><strong>Unlimited.</strong> Capacity is the provider's job: there are no servers to run and no limit.</span>
      </p>
      <p class="muted unit-intro">
        The SaaS provider scales its platform to however many users you have, so you never run out of capacity. Its
        own outages can still take you down.
      </p>
      <dl class="provider-bill" data-testid="provider-bill">
        <div>
          <dt>Per-user fee</dt>
          <dd>{{ formatPrice(game.provider.perUserFee) }} <small>a user a month</small></dd>
        </div>
        <div>
          <dt>Users billed</dt>
          <dd>
            {{ formatCount(game.provider.users) }}
            <small>{{ formatCount(game.provider.freeUsers) }} of them free</small>
          </dd>
        </div>
        <div>
          <dt>Per-user bill</dt>
          <dd data-testid="provider-per-user-bill">{{ formatCash(game.provider.monthlyPerUserBill) }} <small>a month</small></dd>
        </div>
      </dl>
      <p class="muted capacity-note">
        That's how you pay for capacity here: every user costs money, free ones included, on top of the platform's
        {{ formatCash(game.provider.monthlyCost) }} a month and any add-ons.
      </p>
    </div>

    <div v-else class="capacity" data-testid="capacity">
      <div class="row-between">
        <span id="capacity-label" class="label">Load vs capacity</span>
        <span class="figures">{{ formatCount(game.company.load) }} / {{ formatCount(game.company.capacity ?? 0) }}</span>
      </div>
      <div
        class="meter"
        role="meter"
        aria-labelledby="capacity-label"
        aria-valuemin="0"
        :aria-valuemax="game.company.capacity ?? 0"
        :aria-valuenow="game.company.load"
        :aria-valuetext="`${game.loadPercent}% of capacity`"
      >
        <div :class="['meter-fill', game.loadLevel]" :style="{ width: `${Math.min(100, game.loadPercent)}%` }"></div>
      </div>
      <p :class="['capacity-note', game.loadLevel]">
        <strong>{{ game.loadPercent }}%</strong> of capacity used.
        <template v-if="game.loadLevel === 'over'">Over capacity: expect outages.</template>
        <template v-else-if="game.loadLevel === 'high'">Getting close: an outage is coming if load keeps rising.</template>
        <template v-else>Load over 100% causes an outage.</template>
      </p>
      <p v-if="game.understaffed" class="warn-text capacity-staff">
        You're {{ game.opsPeople(game.opsShort) }} short, so capacity is cut.
        <RouterLink :to="`${game.base}/people`">Hire ops on the People page</RouterLink>.
      </p>
    </div>
  </section>
</template>
