<script setup lang="ts">
import { computed, ref, useId } from "vue";
import type { StaffGrade, StaffPool } from "@xaas/sim";
import { formatCash } from "../api";
import { useGame } from "../game";
import LetGoConfirm from "./LetGoConfirm.vue";

// One team's hiring in bulk, under its − / + (GradeCounter), with the same grade and permanent or agency pick: the
// number box hires or lets go that many at once, so a big team doesn't take hundreds of clicks. Short of ops, support or
// moderators, one button hires enough to cover it. With agency staff on the team or still to start, one button lets them
// all go. Used on People and in Customer care, so the two can't drift apart.
const props = defineProps<{ pool: StaffPool; source: string }>();
const grade = defineModel<StaffGrade>("grade", { default: "mid" });
const agency = defineModel<boolean>("agency", { default: false });
const game = useGame();
const id = useId();
const MAX_AT_ONCE = 999;
const amount = ref<number | "">(10);
const confirming = ref(false);

const info = computed(() => game.meta?.staff.find((s) => s.id === props.pool));
const view = computed(() => game.staffPool(props.pool));
// The number in the box, or 0 when it isn't a whole number from 1 to the most at once.
const count = computed(() => {
  const n = amount.value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_AT_ONCE ? n : 0;
});
// The picked grade, permanent or agency as picked.
const picked = computed(() => (agency.value ? view.value?.agency : view.value?.grades)?.find((g) => g.grade === grade.value));
const permanentGrade = computed(() => view.value?.grades.find((g) => g.grade === grade.value));
const team = (n: number) => (n === 1 ? (info.value?.personName ?? props.pool) : (info.value?.name.toLowerCase() ?? props.pool));
const people = (n: number) => `${agency.value ? "agency " : ""}${picked.value?.name.toLowerCase() ?? grade.value} ${team(n)}`;
const control = (what: string) => `${props.source}-${what}-${props.pool}`;

function change(type: "hire" | "letGo") {
  if (count.value < 1) return;
  if (type === "letGo" && !agency.value) {
    confirming.value = true;
    return;
  }
  game.actFrom(control(type === "hire" ? "hire-many" : "let-go-many"), {
    type,
    pool: props.pool,
    grade: grade.value,
    count: count.value,
    ...(agency.value ? { agency: true } : {}),
  });
}

// Short of ops, support or moderators, in mids' work, counting hires on the way: how many permanent staff of the picked
// grade cover it, as they're the ones to keep.
const need = computed(() =>
  props.pool === "ops"
    ? (game.company?.opsNeeded ?? 0)
    : props.pool === "support"
      ? game.supportNeeded
      : props.pool === "moderators"
        ? game.moderatorsNeeded
        : 0,
);
const toCover = computed(() => {
  const short = game.midsShort(need.value, game.work(props.pool) + game.workComing(props.pool));
  const output = permanentGrade.value?.output ?? 1;
  return output > 0 ? Math.ceil(Math.round((short / output) * 100) / 100) : 0;
});
function hireShort() {
  game.actFrom(control("hire-many"), { type: "hire", pool: props.pool, grade: grade.value, count: toCover.value });
}

// Agency staff on the team and still to start: they go with no severance, so there's nothing to confirm.
const agencyStarted = computed(() => view.value?.agencyCount ?? 0);
const agencyWaiting = computed(() => view.value?.hiring.filter((h) => h.agency).reduce((sum, h) => sum + h.count, 0) ?? 0);
const agencyPay = computed(() => view.value?.agency.reduce((sum, g) => sum + g.count * g.dayRate, 0) ?? 0);
const agencyGoing = computed(() => {
  const started = agencyStarted.value;
  const waiting = agencyWaiting.value;
  const toStart = waiting ? `${waiting} still to start` : "";
  if (!started) return `Cancels ${toStart}. No pay to save yet: they're paid once they start.`;
  return `Lets go ${started} on the team${toStart ? ` and cancels ${toStart}` : ""}, saving ${formatCash(agencyPay.value)} a day. No severance.`;
});
</script>

<template>
  <div v-if="view && info && picked" class="staff-bulk" :data-testid="`${pool}-bulk`">
    <label :for="`${id}-amount`" class="muted">How many</label>
    <input
      :id="`${id}-amount`"
      v-model.number="amount"
      type="number"
      inputmode="numeric"
      min="1"
      :max="MAX_AT_ONCE"
      step="1"
      :disabled="game.over"
      :data-testid="`${pool}-amount`"
    />
    <button class="ghost" :disabled="game.busy || game.over || !count" :data-testid="`${pool}-hire-many`" @click="change('hire')">
      Hire {{ count || "" }}
    </button>
    <button
      class="ghost"
      :disabled="game.busy || game.over || !count || picked.count < count"
      :data-testid="`${pool}-let-go-many`"
      @click="change('letGo')"
    >
      Let go {{ count || "" }}
    </button>
    <span v-if="count" class="muted staff-bulk-cost">
      {{ formatCash(count * picked.dayRate) }} a day for {{ count }} {{ people(count) }}<template v-if="!agency"
        >; {{ formatCash(count * picked.severance) }} severance to let them go</template
      >
    </span>
    <span v-else class="muted staff-bulk-cost">Enter a whole number from 1 to {{ MAX_AT_ONCE }}.</span>
    <button v-if="toCover > 0" :disabled="game.busy || game.over" :data-testid="`${pool}-hire-short`" @click="hireShort">
      Hire {{ toCover }} {{ permanentGrade?.name.toLowerCase() ?? grade }} {{ team(toCover) }} to cover the shortfall
    </button>
    <div v-if="agencyStarted || agencyWaiting" class="staff-bulk-agency" :data-testid="`${pool}-agency-all`">
      <button
        class="ghost"
        :disabled="game.busy || game.over"
        :data-testid="`${pool}-let-go-agency`"
        @click="game.actFrom(control('let-go-agency'), { type: 'letGoAgency', pool })"
      >
        Let go all agency {{ info.name.toLowerCase() }}
      </button>
      <span class="muted staff-bulk-cost">{{ agencyGoing }}</span>
    </div>
    <LetGoConfirm v-model:open="confirming" :pool="pool" :grade="grade" :count="count" :control="control('let-go-many')" />
  </div>
</template>
