<script setup lang="ts">
import { computed, reactive, useId } from "vue";
import type { StaffPool } from "@xaas/sim";
import { formatCash, formatCount } from "../api";
import { useGame } from "../game";

// Developers, ops and support: hire, let go, and retrain someone into another team. − and + move one person; the
// number box hires or lets go that many at once, so a big team doesn't take hundreds of clicks.
const game = useGame();
const id = useId();
const MAX_AT_ONCE = 999;
const amounts = reactive<Record<StaffPool, number | "">>({ developers: 10, ops: 10, support: 10 });
// The number in the box, or 0 when it isn't a whole number from 1 to the most at once.
const amountOf = (pool: StaffPool) => {
  const n = amounts[pool];
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_AT_ONCE ? n : 0;
};
const people = (pool: StaffPool, n: number) => {
  const p = game.meta?.staff.find((s) => s.id === pool);
  return n === 1 ? (p?.personName ?? pool) : (p?.name.toLowerCase() ?? pool);
};
function change(type: "hire" | "letGo", pool: StaffPool, count: number) {
  if (count < 1) return;
  game.actFrom(`staff-${type === "hire" ? "hire" : "let-go"}-many-${pool}`, { type, pool, count });
}
// Short of ops or support: how many more to hire to cover it, for a one-click fix.
const shortOf = (pool: StaffPool) =>
  pool === "ops" ? (game.understaffed ? game.company!.opsNeeded - game.company!.ops : 0) : pool === "support" ? game.supportShort : 0;
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
    <ul class="staff">
      <li v-for="pool in game.meta.staff" :key="pool.id" :data-pool="pool.id">
        <div class="staff-info">
          <strong>{{ pool.name }}</strong>
          <span class="muted">{{ formatCash(pool.dayRate) }} each a day</span>
          <span v-if="pool.id === 'support'" class="muted" data-testid="support-hint">
            Each clears {{ formatCount(game.meta.ticketsPerPerson) }} tickets a day. Your users raise about
            {{ formatCount(game.company.usualTickets) }} a day, so you need
            {{ game.supportNeeded }}<template v-if="game.company.backlog">, plus more to clear the backlog</template>.
          </span>
        </div>
        <div class="counter">
          <button
            class="ghost"
            :disabled="game.busy || game.over || game.company[pool.id] < 1"
            :aria-label="`Let go one ${pool.personName}`"
            @click="game.actFrom(`staff-${pool.id}`, { type: 'letGo', pool: pool.id })"
          >
            −
          </button>
          <output :data-testid="`${pool.id}-count`" aria-live="polite">{{ game.company[pool.id] }}</output>
          <button
            class="ghost"
            :disabled="game.busy || game.over"
            :aria-label="`Hire one ${pool.personName}`"
            @click="game.actFrom(`staff-${pool.id}`, { type: 'hire', pool: pool.id })"
          >
            +
          </button>
        </div>
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
            :disabled="game.busy || game.over || !amountOf(pool.id) || game.company[pool.id] < amountOf(pool.id)"
            :data-testid="`${pool.id}-let-go-many`"
            @click="change('letGo', pool.id, amountOf(pool.id))"
          >
            Let go {{ amountOf(pool.id) || "" }}
          </button>
          <span v-if="amountOf(pool.id)" class="muted staff-bulk-cost">
            {{ formatCash(amountOf(pool.id) * pool.dayRate) }} a day for {{ amountOf(pool.id) }}
            {{ people(pool.id, amountOf(pool.id)) }}
          </span>
          <span v-else class="muted staff-bulk-cost">Enter a whole number from 1 to {{ MAX_AT_ONCE }}.</span>
          <button
            v-if="shortOf(pool.id) > 0"
            :disabled="game.busy || game.over"
            :data-testid="`${pool.id}-hire-short`"
            @click="change('hire', pool.id, shortOf(pool.id))"
          >
            Hire the {{ shortOf(pool.id) }} you're short
          </button>
        </div>
      </li>
    </ul>
    <div class="move-staff" data-testid="move-staff">
      <span class="muted">Retrain someone into another team (no cost, any time):</span>
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
        Understaffed: {{ game.company.opsNeeded - game.company.ops }} short{{ game.provider ? "" : ", capacity cut" }}
      </span>
    </p>
  </section>
</template>
