<script setup lang="ts">
import { formatCount, formatUptime } from "../api";
import { useGame } from "../game";

// Load against capacity on the day just played, and uptime so far. Over 100% load is an outage.
const game = useGame();
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
    <div class="capacity" data-testid="capacity">
      <div class="row-between">
        <span id="capacity-label" class="label">Load vs capacity</span>
        <span class="figures">{{ formatCount(game.company.load) }} / {{ formatCount(game.company.capacity) }}</span>
      </div>
      <div
        class="meter"
        role="meter"
        aria-labelledby="capacity-label"
        aria-valuemin="0"
        :aria-valuemax="game.company.capacity"
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
