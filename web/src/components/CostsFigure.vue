<script setup lang="ts">
import { computed, useId } from "vue";
import { formatCash } from "../api";
import { useGame } from "../game";

// The daily costs, the one figure behind the costs line, runway, the IPO check and the rescue. Hovering over it (or
// focusing it) shows the breakdown by heading; one-offs aren't in it.
const game = useGame();
const id = useId();
const runway = computed(() => game.company?.runway ?? null);
const shown = computed(() => runway.value?.costs.filter((h) => h.amount > 0 || (h.id === "executives" && runway.value!.payHoliday)) ?? []);
</script>

<template>
  <span v-if="runway" class="costs-figure" tabindex="0" :aria-describedby="id" data-testid="costs-figure">
    {{ formatCash(runway.dailyCosts) }}
    <span :id="id" role="tooltip" class="costs-breakdown" data-testid="costs-breakdown">
      <span v-for="h in shown" :key="h.id" class="costs-row" :data-heading="h.id">
        <span>{{ h.label }}<template v-if="h.id === 'executives' && runway.payHoliday"> (pay holiday)</template></span>
        <span>{{ formatCash(h.amount) }}</span>
      </span>
      <span v-if="!shown.length" class="costs-row"><span>No daily costs yet</span></span>
      <span class="costs-row costs-note">One-offs such as kit bought aren't daily costs.</span>
    </span>
  </span>
</template>
