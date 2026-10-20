<script setup lang="ts">
import { computed } from "vue";
import { formatCount, formatUptime } from "../../api";
import { useGame } from "../../game";

// Customers: who's using the product. Users for now.
const game = useGame();
const userChange = computed(() =>
  game.company && game.previousUsers !== undefined ? game.company.users - game.previousUsers : undefined,
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
      <p>
        Your users get {{ game.productName(game.company.productType).toLowerCase() }} as SaaS, whatever you run it on.
        They grow every day: each feature you add speeds that up, and outages and feature gaps slow it down.
      </p>
      <p v-for="gap in game.featureGaps" :key="gap.id" class="gap-note">
        <span class="badge">Feature gap</span> They want {{ gap.feature }}, and you can't give it to them yet.
      </p>
    </section>
  </div>
</template>
