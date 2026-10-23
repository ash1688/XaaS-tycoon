<script setup lang="ts">
import { computed, useId } from "vue";
import type { StaffGrade, StaffPool } from "@xaas/sim";
import { formatCash, formatCount } from "../api";
import { days, useGame } from "../game";

// One team's quick hire: pick a grade, then − and + let go or hire one of it. The count is everyone on the team; hires
// still to start are listed under it with the day they start, as they cost and do nothing until then.
const props = defineProps<{ pool: StaffPool; source: string }>();
const picked = defineModel<StaffGrade>("grade", { default: "mid" });
const game = useGame();
const id = useId();

const info = computed(() => game.meta?.staff.find((s) => s.id === props.pool));
const view = computed(() => game.staffPool(props.pool));
const gradeView = (g: StaffGrade) => view.value?.grades.find((v) => v.grade === g);
const current = computed(() => gradeView(picked.value));
const who = computed(() => `${current.value?.name.toLowerCase() ?? picked.value} ${info.value?.personName ?? props.pool}`);
const startsIn = (n: number) => (n === 0 ? "start at once" : `start ${days(n)} after hiring`);
</script>

<template>
  <div v-if="view && info && current" class="grade-counter" :data-testid="`${pool}-grades`">
    <div class="grade-pick" role="radiogroup" :aria-label="`Grade of ${info.name.toLowerCase()} to hire or let go`">
      <label v-for="g in view.grades" :key="g.grade" :class="{ picked: g.grade === picked }">
        <input v-model="picked" type="radio" :name="`${id}-grade`" :value="g.grade" :disabled="game.over" />
        {{ g.name }} <span class="muted" :data-testid="`${pool}-${g.grade}-count`">{{ g.count }}</span>
      </label>
    </div>
    <div class="counter">
      <button
        class="ghost"
        :disabled="game.busy || game.over || current.count < 1"
        :aria-label="`Let go one ${who}`"
        @click="game.actFrom(`${source}-${pool}`, { type: 'letGo', pool, grade: picked })"
      >
        −
      </button>
      <output :data-testid="`${pool}-count`" aria-live="polite">{{ view.headcount }}</output>
      <button
        class="ghost"
        :disabled="game.busy || game.over"
        :aria-label="`Hire one ${who}`"
        @click="game.actFrom(`${source}-${pool}`, { type: 'hire', pool, grade: picked })"
      >
        +
      </button>
    </div>
    <p class="muted grade-note" :data-testid="`${pool}-grade-note`">
      {{ current.name }}s: {{ formatCash(current.dayRate) }} each a day, {{ formatCount(current.output) }}× a mid's work,
      {{ startsIn(current.leadDays) }}.
    </p>
    <div v-if="view.hiring.length" class="hiring" :data-testid="`${pool}-hiring`" aria-live="polite">
      <p v-for="(h, i) in view.hiring" :key="i">
        {{ h.count }} {{ gradeView(h.grade)?.name.toLowerCase() }} hired: start{{ h.count === 1 ? "s" : "" }} on day
        {{ h.arrivesOn }}, in {{ days(h.daysLeft) }}.
      </p>
    </div>
  </div>
</template>

<style scoped>
.grade-counter {
  display: grid;
  gap: 0.35rem;
}
.grade-pick {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.grade-pick label {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
}
.grade-pick label.picked {
  border-color: var(--accent);
  background: var(--accent-soft);
  font-weight: 600;
}
.grade-note,
.hiring p {
  margin: 0;
  font-size: 0.9rem;
}
</style>
