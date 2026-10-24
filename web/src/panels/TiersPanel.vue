<script setup lang="ts">
import { computed } from "vue";
import type { TierConditionView } from "@xaas/sim";
import { formatCash, formatCount } from "../api";
import { useGame } from "../game";

// Tiers 1–4: the product features and model benefits a company can have, grouped by tier. Tier 1 is open from the
// start; each later tier opens, for good, once its condition is met, in order. Benefits for the company's model are
// shown; other models' are listed apart, so the student sees what moving would offer.
const game = useGame();
const tiers = computed(() => game.company?.tiers ?? []);
const model = computed(() => game.company?.model);

const value = (c: TierConditionView, n: number) =>
  c.unit === "pounds" ? formatCash(n) : c.unit === "percent" ? `${n}%` : formatCount(n);
/** One part of a condition and how far the company has got: "Users: 3,200 of 5,000". */
const progress = (c: TierConditionView) =>
  c.unit === "yes" ? (c.met ? "done" : "not yet") : `${value(c, c.value)} of ${value(c, c.target)}`;
const share = (c: TierConditionView) => (c.target > 0 ? Math.min(100, (100 * c.value) / c.target) : 100);
const modelName = (id: string | null) => (id ? game.modelName(id) : "");
</script>

<template>
  <section v-if="game.company" class="card" aria-labelledby="tiers-heading" data-testid="tiers">
    <div class="row-between panel-head">
      <h2 id="tiers-heading">Tiers</h2>
      <span class="muted">{{ tiers.filter((t) => t.available).length }} of {{ tiers.length }} unlocked</span>
    </div>
    <p class="muted">
      Features and model benefits come in tiers. Each tier unlocks once its condition is met, and stays unlocked.
      Product features stay with you if you migrate; model benefits belong to the model, so a migration loses them.
    </p>
    <ol class="tiers">
      <li v-for="t in tiers" :key="t.tier" :class="{ open: t.available }" :data-tier="t.tier" :data-open="t.available">
        <div class="row-between">
          <strong>Tier {{ t.tier }}</strong>
          <span v-if="t.available" class="badge built-badge">{{ t.tier === 1 ? "Open from the start" : `Unlocked day ${t.day}` }}</span>
          <span v-else class="badge">Locked</span>
        </div>
        <ul v-if="!t.available" class="tier-conditions" :data-testid="`tier-conditions-${t.tier}`">
          <li v-for="(c, i) in t.conditions" :key="c.label">
            <span v-if="i > 0" class="muted">{{ t.any ? "or" : "and" }} </span>
            <span>{{ c.label }}: <strong>{{ progress(c) }}</strong></span>
            <div
              v-if="c.unit !== 'yes'"
              class="meter"
              role="progressbar"
              :aria-label="c.label"
              aria-valuemin="0"
              :aria-valuemax="c.target"
              :aria-valuenow="c.value"
            >
              <div :class="['meter-fill', c.met ? 'ok' : 'building']" :style="{ width: `${share(c)}%` }"></div>
            </div>
          </li>
        </ul>
        <ul class="tier-items">
          <li
            v-for="item in t.items.filter((i) => i.kind === 'feature' || i.model === model)"
            :key="item.id"
            :data-item="item.id"
          >
            <span class="badge">{{ item.kind === "feature" ? "Feature" : "Model benefit" }}</span>
            <strong>{{ item.name }}</strong>
            <span class="muted"> · {{ item.blurb }}</span>
          </li>
        </ul>
        <p v-if="t.items.some((i) => i.kind === 'benefit' && i.model !== model)" class="muted other-models">
          On other models:
          {{
            t.items
              .filter((i) => i.kind === "benefit" && i.model !== model)
              .map((i) => `${i.name} (${modelName(i.model)})`)
              .join(", ")
          }}
        </p>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.tiers {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 0.75rem;
}
.tiers > li {
  border: 1px solid var(--border, #ddd);
  border-radius: 8px;
  padding: 0.6rem 0.75rem;
}
.tiers > li:not(.open) {
  opacity: 0.85;
}
.tier-conditions,
.tier-items {
  list-style: none;
  padding: 0;
  margin: 0.4rem 0 0;
  display: grid;
  gap: 0.3rem;
}
.tier-items .badge {
  margin-right: 0.35rem;
}
.other-models {
  margin: 0.4rem 0 0;
  font-size: 0.9em;
}
</style>
