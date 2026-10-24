<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useGame } from "../game";

// The IPO readiness checklist on Finance: eight conditions turning green one by one, and Apply once all are. Applying
// rolls a hidden cold market (the IPO postponed); otherwise it's approved and the opening-bell page takes over.
const game = useGame();
const router = useRouter();
const ipo = computed(() => game.company?.ipo ?? null);
const metCount = computed(() => ipo.value?.conditions.filter((c) => c.met).length ?? 0);
const STATUS = {
  "not-ready": "Not ready",
  ready: "Ready to apply",
  cold: "Cold market",
  approved: "Approved",
  floated: "Floated",
} as const;

async function apply() {
  game.track("control", { control: "ipo-apply", value: "apply" });
  await game.act({ type: "applyForIpo" });
  if (!game.error && game.company?.ipo.status === "approved") await router.push(`${game.base}/ipo`);
}
</script>

<template>
  <section v-if="ipo" class="card span-all ipo-panel" aria-labelledby="ipo-heading" data-testid="ipo-panel">
    <div class="row-between">
      <h2 id="ipo-heading">IPO readiness</h2>
      <span :class="['badge', `ipo-${ipo.status}`]" data-testid="ipo-status">{{ STATUS[ipo.status] }}</span>
    </div>
    <p class="muted">
      Floating on the stock market ends the game, and no investor is needed to do it. Meet every condition to apply:
      {{ metCount }} of {{ ipo.conditions.length }} met.
    </p>
    <ul class="ipo-checklist">
      <li
        v-for="c in ipo.conditions"
        :key="c.id"
        :class="{ met: c.met }"
        :data-testid="`ipo-${c.id}`"
        :data-met="c.met"
      >
        <span class="ipo-tick" aria-hidden="true">{{ c.met ? "✓" : "○" }}</span>
        <div>
          <strong>{{ c.label }}</strong>
          <span class="visually-hidden">{{ c.met ? "met" : "not met yet" }}</span>
          <p class="ipo-now">{{ c.now }}</p>
          <p class="muted">Needs {{ c.needed }}</p>
        </div>
      </li>
    </ul>

    <div class="ipo-footer" data-testid="ipo-footer">
      <template v-if="ipo.status === 'floated'">
        <p>
          You floated on day {{ ipo.result!.day }}.
          <RouterLink :to="`${game.base}/ipo`">See the first day of trading</RouterLink>
        </p>
      </template>
      <template v-else-if="ipo.status === 'approved'">
        <p>
          Your IPO was approved on day {{ ipo.approvedDay }}.
          <RouterLink :to="`${game.base}/ipo`" data-testid="ipo-bell-link">Choose your float and ring the opening bell</RouterLink>
        </p>
      </template>
      <template v-else>
        <p v-if="ipo.status === 'cold'" class="ipo-cold" role="status" data-testid="ipo-cold">
          <strong>The markets are cold.</strong> Investors weren't buying, so your IPO is postponed and the news cost
          you some customer goodwill. You can apply again on day {{ ipo.retryDay }}.
        </p>
        <p v-else-if="ipo.status === 'ready'">
          Applying carries a small chance of a cold market, which postpones the IPO by about a month. The more
          comfortably you're over every condition, the less likely one is.
        </p>
        <p v-else class="muted">{{ ipo.refusal }}</p>
        <button :disabled="!ipo.canApply || game.busy || game.over" data-testid="ipo-apply" @click="apply">Apply to float</button>
      </template>
    </div>
  </section>
</template>
