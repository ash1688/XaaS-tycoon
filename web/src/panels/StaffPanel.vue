<script setup lang="ts">
import { computed, reactive, useId } from "vue";
import type { StaffGrade, StaffPool } from "@xaas/sim";
import { formatCash, formatCount } from "../api";
import GradeCounter from "../components/GradeCounter.vue";
import { useGame } from "../game";

// Developers, ops and support, each in junior, mid and senior grades: hire, let go, and retrain someone into another
// team. Pick a grade, then − and + move one person; the number box hires or lets go that many of the grade at once, so
// a big team doesn't take hundreds of clicks. Hires start after their grade's lead time.
const game = useGame();
const id = useId();
const MAX_AT_ONCE = 999;
const amounts = reactive<Record<StaffPool, number | "">>({ developers: 10, ops: 10, support: 10 });
const grades = reactive<Record<StaffPool, StaffGrade>>({ developers: "mid", ops: "mid", support: "mid" });
// The number in the box, or 0 when it isn't a whole number from 1 to the most at once.
const amountOf = (pool: StaffPool) => {
  const n = amounts[pool];
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_AT_ONCE ? n : 0;
};
const gradeOf = (pool: StaffPool) => game.staffPool(pool)?.grades.find((g) => g.grade === grades[pool]);
const people = (pool: StaffPool, n: number) => {
  const p = game.meta?.staff.find((s) => s.id === pool);
  const grade = gradeOf(pool)?.name.toLowerCase() ?? grades[pool];
  return `${grade} ${n === 1 ? (p?.personName ?? pool) : (p?.name.toLowerCase() ?? pool)}`;
};
function change(type: "hire" | "letGo", pool: StaffPool, count: number) {
  if (count < 1) return;
  game.actFrom(`staff-${type === "hire" ? "hire" : "let-go"}-many-${pool}`, { type, pool, grade: grades[pool], count });
}
// Short of ops or support, in mids' work, counting hires on the way: how many of the picked grade cover it.
const need = (pool: StaffPool) =>
  pool === "ops" ? (game.company?.opsNeeded ?? 0) : pool === "support" ? game.supportNeeded : 0;
const shortAfterHires = (pool: StaffPool) => game.midsShort(need(pool), game.work(pool) + game.workComing(pool));
const toCover = (pool: StaffPool) => {
  const output = gradeOf(pool)?.output ?? 1;
  return output > 0 ? Math.ceil(Math.round((shortAfterHires(pool) / output) * 100) / 100) : 0;
};
// Every move from one team to another, developers and ops first as they're the usual swap.
const moves = computed(() => {
  const pools = game.meta?.staff ?? [];
  return pools.flatMap((to) => pools.filter((from) => from.id !== to.id).map((from) => ({ from, to })));
});
const moveOrder = (from: StaffPool, to: StaffPool) => (from === "support" || to === "support" ? 1 : 0);
const sortedMoves = computed(() => moves.value.toSorted((a, b) => moveOrder(a.from.id, a.to.id) - moveOrder(b.from.id, b.to.id)));
</script>

<template>
  <section v-if="game.company && game.meta" class="card" aria-labelledby="staff-heading">
    <div class="row-between panel-head">
      <h2 id="staff-heading">Staff</h2>
      <span class="muted">
        Total <strong data-testid="staff-cost">{{ formatCash(game.company.dailyStaffCost) }}</strong> a day
      </span>
    </div>
    <p class="muted staff-grades-note">
      Juniors start soonest and cost least, but do the least. Seniors do the most for their pay, but take longest to
      start. Work is counted in mids: what's measured against ops needed, a build's developer-days and tickets cleared.
    </p>
    <ul class="staff">
      <li v-for="pool in game.meta.staff" :key="pool.id" :data-pool="pool.id">
        <div class="staff-info">
          <strong>{{ pool.name }}</strong>
          <span class="muted" :data-testid="`${pool.id}-work`">
            Does the work of {{ formatCount(game.work(pool.id)) }} mid{{ game.work(pool.id) === 1 ? "" : "s" }}
          </span>
          <span v-if="pool.id === 'support'" class="muted" data-testid="support-hint">
            A mid clears {{ formatCount(game.meta.ticketsPerPerson) }} tickets a day. Your users raise about
            {{ formatCount(game.company.usualTickets) }} a day, so you need the work of
            {{ game.supportNeeded }}<template v-if="game.company.backlog">, plus more to clear the backlog</template>.
          </span>
        </div>
        <GradeCounter v-model:grade="grades[pool.id]" :pool="pool.id" source="staff" />
        <div class="staff-bulk" :data-testid="`${pool.id}-bulk`">
          <label :for="`${id}-${pool.id}-amount`" class="muted">How many</label>
          <input
            :id="`${id}-${pool.id}-amount`"
            v-model.number="amounts[pool.id]"
            type="number"
            inputmode="numeric"
            min="1"
            :max="MAX_AT_ONCE"
            step="1"
            :disabled="game.over"
            :data-testid="`${pool.id}-amount`"
          />
          <button
            class="ghost"
            :disabled="game.busy || game.over || !amountOf(pool.id)"
            :data-testid="`${pool.id}-hire-many`"
            @click="change('hire', pool.id, amountOf(pool.id))"
          >
            Hire {{ amountOf(pool.id) || "" }}
          </button>
          <button
            class="ghost"
            :disabled="game.busy || game.over || !amountOf(pool.id) || (gradeOf(pool.id)?.count ?? 0) < amountOf(pool.id)"
            :data-testid="`${pool.id}-let-go-many`"
            @click="change('letGo', pool.id, amountOf(pool.id))"
          >
            Let go {{ amountOf(pool.id) || "" }}
          </button>
          <span v-if="amountOf(pool.id)" class="muted staff-bulk-cost">
            {{ formatCash(amountOf(pool.id) * (gradeOf(pool.id)?.dayRate ?? pool.dayRate)) }} a day for
            {{ amountOf(pool.id) }} {{ people(pool.id, amountOf(pool.id)) }}
          </span>
          <span v-else class="muted staff-bulk-cost">Enter a whole number from 1 to {{ MAX_AT_ONCE }}.</span>
          <button
            v-if="toCover(pool.id) > 0"
            :disabled="game.busy || game.over"
            :data-testid="`${pool.id}-hire-short`"
            @click="change('hire', pool.id, toCover(pool.id))"
          >
            Hire {{ toCover(pool.id) }} {{ people(pool.id, toCover(pool.id)) }} to cover the shortfall
          </button>
        </div>
      </li>
    </ul>
    <div class="move-staff" data-testid="move-staff">
      <span class="muted">Retrain someone into another team, keeping their grade (a mid if there is one; no cost, any time):</span>
      <div class="move-buttons">
        <button
          v-for="{ from, to } in sortedMoves"
          :key="`${from.id}-${to.id}`"
          class="ghost"
          :disabled="game.busy || game.over || game.company[from.id] < 1"
          :aria-label="`Move one ${from.personName} to ${to.name.toLowerCase()}`"
          @click="game.actFrom(`staff-move-${from.id}-to-${to.id}`, { type: 'moveStaff', from: from.id, to: to.id })"
        >
          {{ from.personName }} → {{ to.name.toLowerCase() }}
        </button>
      </div>
    </div>
    <p :class="['ops-needed', { warn: game.understaffed }]" data-testid="ops-needed">
      <span>{{ game.modelName(game.company.model) }} needs <strong>{{ game.company.opsNeeded }}</strong> ops staff.</span>
      <span v-if="game.company.opsNeededOnceReady > game.company.opsNeeded" data-testid="ops-needed-soon">
        Once the kit on order arrives, you'll need <strong>{{ game.company.opsNeededOnceReady }}</strong>.
      </span>
      <span v-if="game.understaffed" class="badge">
        Understaffed: {{ game.opsShort }} short{{ game.provider ? "" : ", capacity cut" }}
      </span>
    </p>
  </section>
</template>
