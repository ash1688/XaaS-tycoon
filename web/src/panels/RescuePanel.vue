<script setup lang="ts">
import { computed } from "vue";
import { formatCash } from "../api";
import { useGame } from "../game";
import { formatShare } from "../shares";

// The rescue buyout, once cash has run out once: what the vulture VC put in, the share it took and the cost cuts it
// forced, and its price to sell its shares back. Running out of cash again is liquidation.
const game = useGame();
const rescue = computed(() => game.company?.rescue ?? null);
const cuts = computed(() => {
  const r = rescue.value;
  if (!r) return [];
  const pools = game.company?.staff ?? [];
  const people = r.cuts.map((c) => {
    const pool = pools.find((p) => p.pool === c.pool);
    const grade = pool?.grades.find((g) => g.grade === c.grade)?.name.toLowerCase() ?? c.grade;
    return `${c.count} ${c.agency ? "agency " : ""}${grade} ${pool?.name.toLowerCase() ?? c.pool}`;
  });
  return r.hiresCancelled ? [...people, `${r.hiresCancelled} hire${r.hiresCancelled === 1 ? "" : "s"} still to start`] : people;
});
</script>

<template>
  <section v-if="rescue" class="card span-all cat-equity equity-panel" aria-labelledby="rescue-heading" data-testid="rescue-panel">
    <div class="row-between">
      <h2 id="rescue-heading">Rescue buyout</h2>
      <span :class="['badge', rescue.boughtBack ? 'done-badge' : 'warn-badge']">
        {{ rescue.boughtBack ? "Bought back" : "Vulture VC" }}
      </span>
    </div>
    <p data-testid="rescue-terms">
      Cash ran out on day {{ rescue.day }}, and a vulture VC rescued the company. It put in
      <strong>{{ formatCash(rescue.amount) }}</strong>: {{ formatCash(rescue.losses) }} to cover the losses,<template v-if="rescue.severance">
        {{ formatCash(rescue.severance) }} for severance,</template> and the rest for breathing space. For it, it took <strong>{{ rescue.shares.toLocaleString("en-GB") }} new shares</strong>,
      {{ formatShare(rescue.share) }} of the company.
    </p>
    <p data-testid="rescue-cuts">
      <template v-if="cuts.length">
        Forced cost cuts: it let go {{ cuts.join(", ") }}<template v-if="rescue.savedPerDay">
          , saving {{ formatCash(rescue.savedPerDay) }} a day</template><template v-if="rescue.severance">
          and paying {{ formatCash(rescue.severance) }} in severance</template>.
      </template>
      <template v-else>Forced cost cuts: none, as the team was already as lean as it would go.</template>
    </p>
    <p v-if="rescue.boughtBack" data-testid="rescue-bought-back">
      You bought its shares back on day {{ rescue.boughtBack.day }} for {{ formatCash(rescue.boughtBack.price) }}.
    </p>
    <template v-else-if="rescue.buyBackPrice !== null">
      <p data-testid="rescue-buy-back">
        It still owns {{ formatShare(rescue.vultureShare) }}, and will sell all of it back for
        <strong>{{ formatCash(rescue.buyBackPrice) }}</strong>, paid from the company's cash: {{ rescue.priceDetail }}.
      </p>
      <button :disabled="!rescue.canBuyBack || game.busy" data-testid="buy-back" @click="game.actFrom('buy-back', { type: 'buyBack' })">
        Buy back for {{ formatCash(rescue.buyBackPrice) }}
      </button>
      <small v-if="!rescue.canBuyBack" class="muted"> You have {{ formatCash(game.company!.cash) }}.</small>
    </template>
    <p v-if="!game.over" class="muted">There's no second rescue: run out of cash again and it's liquidation.</p>
  </section>
</template>
