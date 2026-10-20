<script setup lang="ts">
import type { StaffPool } from "@xaas/sim";
import { formatCash } from "../api";
import { useGame } from "../game";

// Developers and ops: hire, let go, and retrain someone into the other team.
const game = useGame();
const otherPool = (pool: StaffPool): StaffPool => (pool === "developers" ? "ops" : "developers");
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
      <span class="muted">Retrain someone into the other team (no cost, any time):</span>
      <div class="move-buttons">
        <button
          v-for="pool in game.meta.staff"
          :key="pool.id"
          class="ghost"
          :disabled="game.busy || game.over || game.company[otherPool(pool.id)] < 1"
          :aria-label="`Move one ${game.personName(otherPool(pool.id))} to ${pool.name.toLowerCase()}`"
          @click="game.act({ type: 'moveStaff', to: pool.id })"
        >
          {{ game.personName(otherPool(pool.id)) }} → {{ pool.name.toLowerCase() }}
        </button>
      </div>
    </div>
    <p :class="['ops-needed', { warn: game.understaffed }]" data-testid="ops-needed">
      <span>{{ game.modelName(game.company.model) }} needs <strong>{{ game.company.opsNeeded }}</strong> ops staff.</span>
      <span v-if="game.understaffed" class="badge">
        Understaffed: {{ game.company.opsNeeded - game.company.ops }} short, capacity cut
      </span>
    </p>
  </section>
</template>
