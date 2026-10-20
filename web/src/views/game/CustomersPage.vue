<script setup lang="ts">
import { computed } from "vue";
import { formatCash, formatCount, formatPrice, formatUptime } from "../../api";
import { useGame } from "../../game";
import PriceWavePanel from "../../panels/PriceWavePanel.vue";
import SupportPanel from "../../panels/SupportPanel.vue";

// Customers: who's using the product, paying and free, how a price change is moving them, and how happy they are
// with support.
const game = useGame();
const userChange = computed(() =>
  game.company && game.previousUsers !== undefined ? game.company.users - game.previousUsers : undefined,
);
const paidPercent = computed(() =>
  game.company && game.company.users ? Math.round((100 * game.company.paidUsers) / game.company.users) : 0,
);
const activeFeatures = computed(
  () => game.company?.features.filter((f) => f.status === "built" || f.status === "addon").length ?? 0,
);
</script>

<template>
  <div v-if="game.company" class="page-grid single">
    <section class="card" aria-labelledby="customers-heading" data-testid="customers">
      <h2 id="customers-heading">Customers</h2>
      <div class="stats">
        <div class="stat">
          <span class="label">Users</span>
          <span class="value" data-testid="users">{{ formatCount(game.company.users) }}</span>
          <small v-if="userChange !== undefined">
            {{ userChange < 0 ? "−" : "+" }}{{ formatCount(Math.abs(userChange)) }} on day {{ game.lastDay?.day }}
          </small>
        </div>
        <div class="stat">
          <span class="label">Paying</span>
          <span class="value" data-testid="paid-users">{{ formatCount(game.company.paidUsers) }}</span>
          <small>{{ paidPercent }}% of users</small>
        </div>
        <div class="stat">
          <span class="label">Free</span>
          <span class="value" data-testid="free-users">{{ formatCount(game.company.freeUsers) }}</span>
          <small>{{ 100 - paidPercent }}% of users</small>
        </div>
        <div class="stat">
          <span class="label">Uptime</span>
          <span class="value">{{ formatUptime(game.company.uptime) }}</span>
          <small v-if="game.company.outageDays">
            {{ game.company.outageDays }} outage day{{ game.company.outageDays === 1 ? "" : "s" }}
          </small>
        </div>
        <div class="stat">
          <span class="label">Features live</span>
          <span class="value">{{ activeFeatures }} <small>of {{ game.company.features.length }}</small></span>
        </div>
      </div>
      <div v-if="game.company.users" class="paid-bar" aria-hidden="true">
        <span class="paid" :style="{ width: `${paidPercent}%` }"></span>
      </div>
      <p>
        Paying users bring in {{ formatCash(game.company.dailyIncome) }} a day at
        {{ formatPrice(game.company.price) }} a month. Free users pay nothing, but they still put load on your servers
        and, on SaaS, the provider bills you for them per user like everyone else.
      </p>
      <p>
        Your users get {{ game.productName(game.company.productType).toLowerCase() }} as SaaS, whatever you run it on.
        They grow every day: each feature you add speeds that up, and outages, feature gaps and unhappy customers slow
        it down.
      </p>
      <p v-if="game.company.priceWave && game.company.priceWave.day > 0" class="wave-note" data-testid="customers-wave">
        <span class="badge">Price {{ game.company.priceWave.direction }}</span>
        <template v-if="game.company.priceWave.direction === 'rise'">
          Your price rise has cost {{ formatCount(game.company.priceWave.done.left) }} paying users so far, and
          {{ formatCount(game.company.priceWave.done.toFree) }} more have dropped to free.
        </template>
        <template v-else>
          Your price cut has brought {{ formatCount(game.company.priceWave.done.joined) }} new users so far, and
          {{ formatCount(game.company.priceWave.done.upgraded) }} free users have started paying.
        </template>
      </p>
      <p v-for="gap in game.featureGaps" :key="gap.id" class="gap-note">
        <span class="badge">Feature gap</span> They want {{ gap.feature }}, and you can't give it to them yet.
      </p>
    </section>
    <PriceWavePanel />
    <SupportPanel />
  </div>
</template>
