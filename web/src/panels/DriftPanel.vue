<script setup lang="ts">
import { computed } from "vue";
import { useGame } from "../game";

// Drift in a long game (until IPO or a career): at each year's end running prices rise by a fresh 2–6%, and servers
// and VMs added after it give more units for the money. Shown only in a game that reaches a year's end.
const game = useGame();
const drift = computed(() => {
  const d = game.company?.drift;
  return d && (d.yearEnds.length || d.nextYearEnd !== null) ? d : null;
});
/** A share as a percent to a tenth: 4.2%. */
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
const daysTo = computed(() => (drift.value?.nextYearEnd ?? 0) - (game.company?.day ?? 0));
</script>

<template>
  <section v-if="drift" class="card" aria-labelledby="drift-heading" data-testid="drift">
    <h2 id="drift-heading">Prices and kit over the years</h2>
    <p class="muted">
      At the end of each year, running prices rise (servers, VMs, rent, fees and power), and new servers and VMs give
      more capacity for the money. Kit you already have keeps its units, so replacing old kit can pay. Your own price
      only changes if you change it, and pay only rises in pay reviews.
    </p>
    <p data-testid="drift-level">
      <template v-if="drift.yearEnds.length">
        Running prices are <strong>+{{ pct(drift.priceLevel - 1) }}</strong> on the start, and new kit gives
        <strong>+{{ pct(drift.newKitUnits - 1) }}</strong> units.
      </template>
      <template v-else>Prices are as they were at the start.</template>
    </p>
    <ul v-if="drift.yearEnds.length" class="drift-years">
      <li v-for="y in drift.yearEnds" :key="y.year" :data-testid="`drift-year-${y.year}`">
        Year {{ y.year }} (ended day {{ y.day }}): prices rose <strong>{{ pct(y.inflation) }}</strong>
      </li>
    </ul>
    <p v-if="drift.nextYearEnd !== null" class="muted" data-testid="drift-next">
      The next year's end is after day {{ drift.nextYearEnd }}, in {{ daysTo }} day{{ daysTo === 1 ? "" : "s" }}.
    </p>
  </section>
</template>

<style scoped>
.drift-years {
  margin: 0;
  padding-left: 1.2rem;
}
</style>
