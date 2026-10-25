<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import type { ServerView } from "@xaas/sim";
import { formatCash, formatCount } from "../api";
import { useGame } from "../game";

// The hardware slider (on-prem only): each server runs at 0–150% of its normal capacity. Below 100% it gives less but
// costs less to run and wears slower; above, it gives more, with a daily chance of overheating or a crash, and wears
// faster. A short-term fix while new kit is on its way.
const game = useGame();
const servers = computed(() => (game.company?.servers ?? []).filter((s) => s.performance !== null));
const top = computed(() => Math.round(100 * (game.meta?.maxPerformance ?? 1.5)));

// Each slider's position while it's dragged, set when it's let go.
const percents = reactive<Record<number, number>>({});
watch(
  servers,
  (list) => {
    for (const s of list) percents[s.id] = Math.round(100 * (s.performance ?? 1));
  },
  { immediate: true },
);
function set(s: ServerView) {
  game.act({ type: "setPerformance", id: s.id, performance: percents[s.id]! / 100 });
}
const pct = (share: number) => `${+(100 * share).toFixed(share < 0.1 ? 1 : 0)}%`;
</script>

<template>
  <section v-if="game.company && servers.length" class="card" aria-labelledby="hardware-heading" data-testid="hardware">
    <div class="row-between panel-head">
      <h2 id="hardware-heading">Hardware slider</h2>
    </div>
    <p class="muted">
      Your own kit, so you can tune it. Below 100% a server gives less capacity but costs less to power and lasts
      longer. Above 100% it gives more, but risks overheating (less capacity for a few days) or a crash (none until ops
      fix it), and wears out faster. Push kit hard to cover a gap while new servers are on their way, not for weeks.
    </p>
    <ul class="server-list">
      <li v-for="s in servers" :key="s.id" :data-testid="`hardware-${s.id}`">
        <div class="server-info">
          <label :for="`slider-${s.id}`">
            <strong>#{{ s.id }} {{ s.name }} · {{ s.size }}</strong>
            <span> at {{ percents[s.id] }}%</span>
          </label>
          <input
            :id="`slider-${s.id}`"
            v-model.number="percents[s.id]"
            type="range"
            min="0"
            :max="top"
            step="5"
            :disabled="game.busy || game.over"
            :aria-valuetext="`${percents[s.id]}% of normal capacity`"
            :data-testid="`slider-${s.id}`"
            @change="set(s)"
          />
          <span class="muted">
            {{ formatCount(s.units * (s.performance ?? 1)) }} of {{ formatCount(s.units) }} units ·
            {{ formatCash(s.monthlyCost) }} a month · wear {{ pct(s.wear ?? 0) }} of its life
            <template v-if="s.risk && (s.risk.overheat > 0 || s.risk.crash > 0)">
              · a day: {{ pct(s.risk.overheat) }} chance of overheating, {{ pct(s.risk.crash) }} of a crash
            </template>
          </span>
          <span v-if="s.wearWarning" class="warn-text" :data-testid="`wear-warning-${s.id}`">
            <span class="badge">{{ s.wearDaysLeft === 0 ? "Worn out" : "Nearly worn out" }}</span>
            <template v-if="s.wearDaysLeft === 0">Past the end of its life, it may crash on any day: sell it and buy a new one.</template>
            <template v-else>
              About {{ s.wearDaysLeft }} day{{ s.wearDaysLeft === 1 ? "" : "s" }} left at this setting. Replace it, or turn it
              down to make it last.
            </template>
          </span>
          <span v-if="s.crashedDays" class="warn-text" :data-testid="`crashed-${s.id}`">
            <span class="badge">Crashed</span> No capacity for {{ s.crashedDays }} more day{{ s.crashedDays === 1 ? "" : "s" }} while ops fix it.
          </span>
          <span v-else-if="s.overheatedDays" class="warn-text" :data-testid="`overheated-${s.id}`">
            <span class="badge">Overheating</span> Less capacity for {{ s.overheatedDays }} more day{{ s.overheatedDays === 1 ? "" : "s" }}.
          </span>
        </div>
      </li>
    </ul>
  </section>
</template>
