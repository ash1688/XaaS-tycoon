<script setup lang="ts">
import { computed, ref, useId } from "vue";
import type { StaffGrade, StaffPool } from "@xaas/sim";
import { formatCash, formatCount } from "../api";
import { days, useGame } from "../game";
import LetGoConfirm from "./LetGoConfirm.vue";

// One team's quick hire: pick permanent or agency staff (permanent only for researchers) and a grade, then − and + let go or hire one of it. Letting go
// permanent staff asks first, showing their severance; agency staff go at once, with none. The count is the permanent
// team; agency staff are listed apart under it, and hires still to start under that with the day they start, as they
// cost and do nothing until then.
const props = defineProps<{ pool: StaffPool; source: string }>();
const picked = defineModel<StaffGrade>("grade", { default: "mid" });
const agency = defineModel<boolean>("agency", { default: false });
const game = useGame();
const id = useId();
const confirming = ref(false);

const info = computed(() => game.meta?.staff.find((s) => s.id === props.pool));
const view = computed(() => game.staffPool(props.pool));
const grades = computed(() => (agency.value ? view.value?.agency : view.value?.grades) ?? []);
const gradeView = (g: StaffGrade) => view.value?.grades.find((v) => v.grade === g);
const current = computed(() => grades.value.find((v) => v.grade === picked.value));
const who = computed(
  () => `${agency.value ? "agency " : ""}${current.value?.name.toLowerCase() ?? picked.value} ${info.value?.personName ?? props.pool}`,
);
const agencyOnTeam = computed(() => view.value?.agency.filter((g) => g.count > 0) ?? []);
const agencyPay = computed(() => agencyOnTeam.value.reduce((sum, g) => sum + g.count * g.dayRate, 0));
const startsIn = (n: number) => (n === 0 ? "start at once" : n === 1 ? "start the day after hiring" : `start ${days(n)} after hiring`);
const control = computed(() => `${props.source}-${props.pool}`);

function letGo() {
  if (agency.value) game.actFrom(control.value, { type: "letGo", pool: props.pool, grade: picked.value, agency: true });
  else confirming.value = true;
}
</script>

<template>
  <div v-if="view && info && current" class="grade-counter" :data-testid="`${pool}-grades`">
    <div v-if="view.agencyAllowed" class="kind-pick" role="radiogroup" :aria-label="`Permanent or agency ${info.name.toLowerCase()}`">
      <label :class="{ picked: !agency }">
        <input v-model="agency" type="radio" :name="`${id}-kind`" :value="false" :disabled="game.over" />
        Permanent
      </label>
      <label :class="{ picked: agency }">
        <input
          v-model="agency"
          type="radio"
          :name="`${id}-kind`"
          :value="true"
          :disabled="game.over"
          :data-testid="`${pool}-agency-pick`"
        />
        Agency
      </label>
    </div>
    <p v-else class="muted" :data-testid="`${pool}-permanent-only`">Permanent hires only: no agency.</p>
    <div class="grade-pick" role="radiogroup" :aria-label="`Grade of ${info.name.toLowerCase()} to hire or let go`">
      <label v-for="g in grades" :key="g.grade" :class="{ picked: g.grade === picked }">
        <input v-model="picked" type="radio" :name="`${id}-grade`" :value="g.grade" :disabled="game.over" />
        {{ g.name }} <span class="muted" :data-testid="`${pool}-${agency ? 'agency-' : ''}${g.grade}-count`">{{ g.count }}</span>
      </label>
    </div>
    <div class="counter">
      <button
        class="ghost"
        :disabled="game.busy || game.over || current.count < 1"
        :aria-label="`Let go one ${who}`"
        @click="letGo"
      >
        −
      </button>
      <output :data-testid="`${pool}-${agency ? 'agency-' : ''}count`" aria-live="polite">
        {{ agency ? view.agencyCount : view.headcount }}
      </output>
      <button
        class="ghost"
        :disabled="game.busy || game.over"
        :aria-label="`Hire one ${who}`"
        @click="game.actFrom(control, { type: 'hire', pool, grade: picked, ...(agency ? { agency: true } : {}) })"
      >
        +
      </button>
    </div>
    <p class="muted grade-note" :data-testid="`${pool}-grade-note`">
      <template v-if="agency">Agency {{ current.name.toLowerCase() }}s:</template>
      <template v-else>{{ current.name }}s:</template>
      {{ formatCash(current.dayRate) }} each a day, {{ formatCount(current.output) }}× a mid's work,
      {{ startsIn(current.leadDays) }},
      <template v-if="agency">no severance.</template>
      <template v-else>{{ formatCash(current.severance) }} severance each if let go.</template>
    </p>
    <p v-if="agencyOnTeam.length" class="agency-team" :data-testid="`${pool}-agency`">
      Agency staff:
      {{ agencyOnTeam.map((g) => `${g.count} ${g.name.toLowerCase()}`).join(", ") }}, {{ formatCash(agencyPay) }} a day
    </p>
    <div v-if="view.hiring.length" class="hiring" :data-testid="`${pool}-hiring`" aria-live="polite">
      <p v-for="(h, i) in view.hiring" :key="i">
        {{ h.count }} {{ h.agency ? "agency " : "" }}{{ gradeView(h.grade)?.name.toLowerCase() }} hired: start{{
          h.count === 1 ? "s" : ""
        }}
        on day {{ h.arrivesOn }}, in {{ days(h.daysLeft) }}.
      </p>
    </div>
    <LetGoConfirm v-model:open="confirming" :pool="pool" :grade="picked" :count="1" :control="control" />
  </div>
</template>

<style scoped>
.grade-counter {
  display: grid;
  gap: 0.35rem;
}
.grade-pick,
.kind-pick {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.grade-pick label,
.kind-pick label {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
}
.grade-pick label.picked,
.kind-pick label.picked {
  border-color: var(--accent);
  background: var(--accent-soft);
  font-weight: 600;
}
.grade-note,
.agency-team,
.hiring p {
  margin: 0;
  font-size: 0.9rem;
}
</style>
