<script setup lang="ts">
import { formatCash, formatCount, formatPrice, formatUptime } from "../api";
import { useGame } from "../game";

// Load against capacity on the day just played, and uptime so far. Over 100% load is an outage. On a model with
// servers (on-prem, IaaS and PaaS), a bar each for CU, DBU and CH: whichever of CU or DBU runs out first sets
// capacity. SaaS has no servers and no limit: capacity is the provider's job, and what you pay for it is the per-user
// bill.
const game = useGame();
const cachePercent = () => Math.round(100 * (game.meta?.cacheableShare ?? 0));
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

    <div v-if="game.units" class="capacity" data-testid="capacity">
      <p v-if="game.managed" class="muted unit-intro">
        Each user needs compute (CU) from your app instances and database units (DBU) from the managed database. A
        managed cache takes some database load off as cache hits (CH). Whichever of CU or DBU runs out first caps what
        you can serve.
      </p>
      <p v-else class="muted unit-intro">
        Each user needs compute (CU) from app servers and database units (DBU) from databases. Caches take some
        database load off as cache hits (CH). Whichever of CU or DBU runs out first caps what you can serve.
      </p>
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
        <p :class="['capacity-note', t.id === 'ch' && t.level === 'over' ? 'high' : t.level]">
          <template v-if="t.id === 'ch'">
            <template v-if="!t.capacity">
              No cache: all database demand reaches the database. A cache can take up to {{ cachePercent() }}% of it.
            </template>
            <template v-else>
              Took <strong>{{ formatCount(game.units.ch.absorbed) }}</strong> DBU off the database, of up to
              {{ formatCount(t.demand) }} it can take ({{ cachePercent() }}% of database demand).
              <template v-if="t.level === 'over'">Cache full: a bigger one would take more.</template>
            </template>
          </template>
          <template v-else>
            <strong>{{ t.capacity > 0 ? `${t.percent}%` : "No capacity" }}</strong>
            <template v-if="t.capacity > 0"> of {{ game.managed ? "your setup's" : `${t.servers}'` }} capacity used.</template>
            <template v-else>: you have no ready {{ t.servers }}.</template>
            <template v-if="t.id === 'dbu' && game.units.ch.absorbed">
              That's after the cache, of {{ formatCount(game.units.dbu.beforeCache) }} DBU in all.
            </template>
            <template v-if="t.level === 'over'"> Over capacity: expect outages.</template>
            <template v-else-if="t.level === 'high'"> Getting close: {{ game.tierFix(t.id) }} soon.</template>
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
        {{ formatCount(game.company.users) }}, free users included.
        <template v-if="game.units.burst && game.managed">Today that includes the extra capacity the platform scaled up for the event.</template>
        <template v-else-if="game.units.burst">Today that includes the extra VMs your ops team rented for the event.</template>
        <template v-if="game.onOrder.length">
          The {{ game.onOrder.length }} server{{ game.onOrder.length === 1 ? "" : "s" }} you have on order add nothing
          until {{ game.onOrder.length === 1 ? "it arrives" : "they arrive" }}.
        </template>
      </p>
      <p v-if="game.understaffed" class="warn-text capacity-staff">
        You're {{ game.company.opsNeeded - game.company.ops }} ops short, so every tier is cut.
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
        You're {{ game.company.opsNeeded - game.company.ops }} ops short, so capacity is cut.
        <RouterLink :to="`${game.base}/people`">Hire ops on the People page</RouterLink>.
      </p>
    </div>
  </section>
</template>
