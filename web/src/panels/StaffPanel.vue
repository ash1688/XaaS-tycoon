<script setup lang="ts">
import { computed } from "vue";
import type { StaffPool } from "@xaas/sim";
import { formatCash, formatCount } from "../api";
import { useGame } from "../game";

// Developers, ops and support: hire, let go, and retrain someone into another team.
const game = useGame();
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
            @click="game.act({ type: 'letGo', pool: pool.id })"
          >
            −
          </button>
          <output :data-testid="`${pool.id}-count`" aria-live="polite">{{ game.company[pool.id] }}</output>
          <button
            class="ghost"
            :disabled="game.busy || game.over"
            :aria-label="`Hire one ${pool.personName}`"
            @click="game.act({ type: 'hire', pool: pool.id })"
          >
            +
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
          @click="game.act({ type: 'moveStaff', from: from.id, to: to.id })"
        >
          {{ from.personName }} → {{ to.name.toLowerCase() }}
        </button>
      </div>
    </div>
    <p :class="['ops-needed', { warn: game.understaffed }]" data-testid="ops-needed">
      <span>{{ game.modelName(game.company.model) }} needs <strong>{{ game.company.opsNeeded }}</strong> ops staff.</span>
      <span v-if="game.understaffed" class="badge">
        Understaffed: {{ game.company.opsNeeded - game.company.ops }} short{{ game.provider ? "" : ", capacity cut" }}
      </span>
    </p>
  </section>
</template>
