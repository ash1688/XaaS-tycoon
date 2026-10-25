<script setup lang="ts">
import { computed } from "vue";
import { formatCash } from "../api";
import { useGame } from "../game";

// Model benefits for the company's model: each is unlocked with research points once its tier is available (see
// Tiers on Product and Research), then is bought with a
// set-up fee and billed monthly. They belong to the model, so a migration loses them, with no refund.
const game = useGame();
const benefits = computed(() => game.company?.benefits.filter((b) => b.onModel) ?? []);
</script>

<template>
  <section v-if="game.company && benefits.length" class="card" aria-labelledby="benefits-heading" data-testid="benefits">
    <div class="row-between panel-head">
      <h2 id="benefits-heading">Model benefits</h2>
      <span class="muted">
        <strong data-testid="benefits-monthly">{{ formatCash(game.company.monthlyBenefitCost) }}</strong> a month
      </span>
    </div>
    <p class="muted">
      What {{ game.modelName(game.company.model) }} offers on top. Each is unlocked with research points once its tier
      is available, then costs a set-up fee and a monthly fee. They belong to this model: migrating loses them, with no refund.
    </p>
    <ul class="features">
      <li v-for="b in benefits" :key="b.id" :data-benefit="b.id" :data-active="b.active">
        <div class="row-between feature-head">
          <div class="feature-info">
            <strong>{{ b.name }}</strong>
            <span class="muted">{{ b.blurb }}</span>
            <span class="muted feature-cost">
              Tier {{ b.tier }} · {{ formatCash(b.setupFee) }} to set up · {{ formatCash(b.monthlyFee) }} a month
            </span>
          </div>
          <button
            v-if="b.active"
            class="ghost"
            :disabled="game.busy || game.over"
            :aria-label="`Cancel ${b.name}`"
            @click="game.act({ type: 'cancelBenefit', benefit: b.id })"
          >
            Cancel
          </button>
          <button
            v-else-if="b.unlocked"
            class="ghost"
            :disabled="game.busy || game.over || b.setupFee > game.company.cash"
            :aria-label="`Buy ${b.name}`"
            :title="b.setupFee > game.company.cash ? `It costs ${formatCash(b.setupFee)} to set up` : undefined"
            @click="game.act({ type: 'buyBenefit', benefit: b.id })"
          >
            Buy
          </button>
          <span v-else class="badge" :data-testid="`benefit-locked-${b.id}`">
            {{ b.tierAvailable ? `${b.rpPrice} RP to unlock` : `Tier ${b.tier}` }}
          </span>
        </div>
      </li>
    </ul>
    <p v-if="game.error" class="error" role="alert">{{ game.error }}</p>
  </section>
</template>
