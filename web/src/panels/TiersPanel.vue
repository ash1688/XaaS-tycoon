<script setup lang="ts">
import { computed } from "vue";
import type { TierConditionView, TierItemView } from "@xaas/sim";
import { formatCash, formatCount } from "../api";
import { useGame } from "../game";

// Tiers 1–4, top to bottom: the product features and model benefits a company can have. Tier 1 is open from the
// start; each later tier becomes available, for good, once its condition is met, in order. Each item in an available
// tier above tier 1 is then unlocked with its own research points (RP), in any order, with one click; building or
// buying it still costs its own developer-days or cash. The company's model's items come first; other models'
// benefits are listed apart, and can be unlocked too, ready for a migration.
const game = useGame();
const tiers = computed(() => game.company?.tiers ?? []);
const model = computed(() => game.company?.model);
const research = computed(() => game.company?.research ?? null);
const points = computed(() => research.value?.points ?? 0);

const value = (c: TierConditionView, n: number) =>
  c.unit === "pounds" ? formatCash(n) : c.unit === "percent" ? `${n}%` : formatCount(n);
/** One part of a condition and how far the company has got: "Users: 3,200 of 5,000". */
const progress = (c: TierConditionView) =>
  c.unit === "yes" ? (c.met ? "done" : "not yet") : `${value(c, c.value)} of ${value(c, c.target)}`;
/** A condition's label after the first, joined on: "or a CTO hired", "and uptime, last 30 days". */
const joined = (label: string, any: boolean) =>
  `${any ? "or" : "and"} ${/^[A-Z](?![A-Z])/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label}`;
const share = (c: TierConditionView) => (c.target > 0 ? Math.min(100, (100 * c.value) / c.target) : 100);
const modelName = (id: string | null) => (id ? game.modelName(id) : "");
const here = (i: TierItemView) => i.kind === "feature" || i.model === model.value;
const kind = (i: TierItemView) =>
  i.kind === "feature" ? "Feature" : here(i) ? "Model benefit" : `Model benefit · ${modelName(i.model)}`;

/** Why an item can't be unlocked with one click right now, or null when it can. */
function unlockBlocked(i: TierItemView): string | null {
  if (!research.value?.unlocked) return "Research points come from researchers, who join when your first angel investor approaches";
  if (i.rpPrice > points.value) return `It takes ${formatCount(i.rpPrice)} RP and you have ${formatCount(points.value)}`;
  return null;
}
</script>

<template>
  <section v-if="game.company" class="card" aria-labelledby="tiers-heading" data-testid="tiers">
    <div class="row-between panel-head">
      <h2 id="tiers-heading">Tiers</h2>
      <span class="muted">{{ tiers.filter((t) => t.available).length }} of {{ tiers.length }} available</span>
    </div>
    <p class="muted">
      Features and model benefits come in tiers. Each tier becomes available once its condition is met, and stays
      available. Then unlock its items with research points, in any order; tier 1's need none. Building or buying an
      item still costs its developer-days or cash. Unlocks stay with your company if you migrate; model benefits you've
      bought belong to the model, so a migration loses them.
    </p>
    <p v-if="research && !research.unlocked" class="muted features-note" data-testid="tiers-research-locked">
      Unlocking needs research points. Researchers join when your first angel investor approaches.
    </p>
    <ol class="tiers">
      <li v-for="t in tiers" :key="t.tier" :class="{ open: t.available }" :data-tier="t.tier" :data-open="t.available">
        <div class="row-between">
          <strong>Tier {{ t.tier }}</strong>
          <span v-if="t.available" class="badge built-badge">{{ t.tier === 1 ? "Open from the start" : `Available day ${t.day}` }}</span>
          <span v-else class="badge">Locked</span>
        </div>
        <ul v-if="!t.available" class="tier-conditions" :data-testid="`tier-conditions-${t.tier}`">
          <li v-for="(c, i) in t.conditions" :key="c.label">
            <span>{{ i > 0 ? joined(c.label, t.any) : c.label }}: <strong>{{ progress(c) }}</strong></span>
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
        <template v-for="(group, g) in [t.items.filter(here), t.items.filter((i) => !here(i))]" :key="g">
          <p v-if="group.length && g === 1" class="muted other-models">For other models, ready if you migrate:</p>
          <ul v-if="group.length" class="tier-items">
            <li
              v-for="item in group"
              :key="item.id"
              :class="['tier-item', { unlocked: item.unlocked }]"
              :data-item="item.id"
              :data-unlocked="item.unlocked"
            >
              <div class="feature-info">
                <span class="muted item-kind">{{ kind(item) }}</span>
                <strong>{{ item.name }}</strong>
                <span class="muted">{{ item.blurb }}</span>
              </div>
              <span v-if="item.unlocked" class="badge built-badge">{{ item.tier === 1 ? "Free" : "Unlocked" }}</span>
              <button
                v-else-if="item.unlockable"
                class="ghost"
                :disabled="game.busy || game.over || unlockBlocked(item) !== null"
                :title="unlockBlocked(item) ?? undefined"
                :aria-label="`Unlock ${item.name} for ${formatCount(item.rpPrice)} RP`"
                @click="game.act({ type: 'unlockItem', item: item.id })"
              >
                Unlock · {{ formatCount(item.rpPrice) }} RP
              </button>
              <span v-else class="badge" :title="`Unlock it once tier ${item.tier} is available`">
                {{ formatCount(item.rpPrice) }} RP
              </span>
            </li>
          </ul>
        </template>
      </li>
    </ol>
    <p v-if="game.error" class="error" role="alert">{{ game.error }}</p>
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
  gap: 0.4rem;
}
.tier-items {
  grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
}
.tier-item {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 0.4rem;
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--border, #ddd);
  border-radius: 8px;
}
.tier-item.unlocked {
  background: var(--provider-soft);
}
.tier-item > button,
.tier-item > .badge {
  align-self: flex-start;
}
.item-kind {
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.other-models {
  margin: 0.5rem 0 0;
  font-size: 0.9em;
}
</style>
