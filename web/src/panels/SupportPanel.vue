<script setup lang="ts">
import { computed } from "vue";
import { formatCash, formatCount } from "../api";
import { useGame } from "../game";

// Customer care: today's tickets, what support cleared, the backlog left and the satisfaction it sets, with a quick
// hire. Support is the company's job on every model, SaaS included.
const game = useGame();
const pool = computed(() => game.meta?.staff.find((s) => s.id === "support"));
const satisfactionChange = computed(() =>
  game.company && game.previousSatisfaction !== undefined
    ? game.company.satisfaction - game.previousSatisfaction
    : undefined,
);
</script>

<template>
  <section v-if="game.company && game.meta && pool" class="card support" aria-labelledby="support-heading" data-testid="support">
    <div class="row-between panel-head">
      <h2 id="support-heading">Customer care</h2>
      <span class="muted">{{ formatCash(pool.dayRate) }} per support person a day</span>
    </div>
    <div class="stats">
      <div class="stat">
        <span class="label">Satisfaction</span>
        <span :class="['value', { neg: game.satisfactionLevel === 'over' }]" data-testid="satisfaction"
          >{{ game.company.satisfaction }}%</span
        >
        <small v-if="satisfactionChange" data-testid="satisfaction-change">
          {{ satisfactionChange < 0 ? "−" : "+" }}{{ Math.abs(satisfactionChange) }} on day {{ game.lastDay?.day }}
        </small>
      </div>
      <div class="stat">
        <span class="label">Tickets today</span>
        <span class="value" data-testid="tickets-today">{{ formatCount(game.company.ticketsToday) }}</span>
        <small v-if="game.company.burstTickets">{{ formatCount(game.company.burstTickets) }} in bursts</small>
      </div>
      <div class="stat">
        <span class="label">Cleared</span>
        <span class="value" data-testid="cleared-today">{{ formatCount(game.company.clearedToday) }}</span>
        <small>Up to {{ formatCount(game.company.dailyClearance) }} a day</small>
      </div>
      <div class="stat">
        <span class="label">Backlog</span>
        <span :class="['value', { neg: game.company.backlog > 0 }]" data-testid="backlog"
          >{{ formatCount(game.company.backlog) }}</span
        >
        <small>tickets waiting</small>
      </div>
    </div>
    <div
      class="meter"
      role="meter"
      aria-label="Customer satisfaction"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="game.company.satisfaction"
    >
      <div :class="['meter-fill', game.satisfactionLevel]" :style="{ width: `${game.company.satisfaction}%` }"></div>
    </div>
    <p class="muted satisfaction-scale">
      Below {{ game.meta.goodSatisfaction }}% growth slows and users leave; below {{ game.meta.poorSatisfaction }}%
      customers are angry.
    </p>
    <div class="support-hire">
      <div class="staff-info">
        <strong>Support staff</strong>
        <span class="muted" data-testid="support-needed">
          Each clears {{ formatCount(game.meta.ticketsPerPerson) }} tickets a day. You need about
          {{ game.supportNeeded }} for your users' usual {{ formatCount(game.company.usualTickets) }} a day<template
            v-if="game.company.backlog"
          >, and more to clear the backlog</template>.
        </span>
      </div>
      <div class="counter">
        <button
          class="ghost"
          :disabled="game.busy || game.over || game.company.support < 1"
          :aria-label="`Let go one ${pool.personName}`"
          @click="game.act({ type: 'letGo', pool: 'support' })"
        >
          −
        </button>
        <output data-testid="support-count" aria-live="polite">{{ game.company.support }}</output>
        <button
          class="ghost"
          :disabled="game.busy || game.over"
          :aria-label="`Hire one ${pool.personName}`"
          @click="game.act({ type: 'hire', pool: 'support' })"
        >
          +
        </button>
      </div>
    </div>
    <p>
      Your customers raise tickets every day, paying and free alike, and more when you're down. Support is your job on
      every model: even on SaaS the provider fixes the platform, but it doesn't answer your customers. Tickets nobody
      answers wait in the backlog, and satisfaction falls the longer it grows.
    </p>
  </section>
</template>
