<script setup lang="ts">
import { computed } from "vue";
import { SPEND_CATEGORIES } from "@xaas/sim";
import { CATEGORY_LABELS, formatCash, formatPrice } from "../api";
import { useGame } from "../game";

// Everything spent so far, split by category, and what the current model costs to run.
const game = useGame();
const spendTotal = computed(() =>
  game.company ? SPEND_CATEGORIES.reduce((sum, c) => sum + game.company!.spend[c], 0) : 0,
);
</script>

<template>
  <section v-if="game.company" class="card" aria-labelledby="spend-heading" data-testid="spend">
    <div class="row-between panel-head">
      <h2 id="spend-heading">Spend so far</h2>
      <span class="muted">
        Total <strong data-testid="spend-total">{{ formatCash(spendTotal) }}</strong>
      </span>
    </div>
    <div v-if="spendTotal" class="spend-bar" aria-hidden="true">
      <span
        v-for="c in SPEND_CATEGORIES"
        :key="c"
        :class="`cat-${c}`"
        :style="{ width: `${(100 * game.company.spend[c]) / spendTotal}%` }"
      ></span>
    </div>
    <ul class="spend-list">
      <li v-for="c in SPEND_CATEGORIES" :key="c" :class="`cat-${c}`">
        <span class="swatch"></span>
        <span class="spend-name">{{ CATEGORY_LABELS[c] }}</span>
        <span class="muted">{{ spendTotal ? Math.round((100 * game.company.spend[c]) / spendTotal) : 0 }}%</span>
        <strong :data-testid="`spend-${c}`">{{ formatCash(game.company.spend[c]) }}</strong>
      </li>
    </ul>
    <p v-if="game.currentModel" class="muted model-costs" data-testid="model-costs">
      {{ game.currentModel.name }}: {{ formatCash(game.currentModel.upfrontCost) }} upfront when you start, then
      {{ formatCash(game.currentModel.monthlyCost) }} a month<template v-if="game.currentModel.monthlyCostPerUser">
        plus {{ formatPrice(game.currentModel.monthlyCostPerUser) }} per user</template
      ><template v-if="game.units"> plus rent on your servers</template>, billed a day at a time. At today's users that's
      <strong>{{ formatCash(game.company.monthlyInfrastructureCost) }}</strong> a month<template v-if="game.onSaas"
        >, plus <strong>{{ formatCash(game.company.monthlyAddonCost) }}</strong> a month for add-ons</template
      >.
    </p>
  </section>
</template>
