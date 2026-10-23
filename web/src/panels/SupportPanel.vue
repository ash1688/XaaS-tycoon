<script setup lang="ts">
import { computed } from "vue";
import { formatCash, formatCount } from "../api";
import GradeCounter from "../components/GradeCounter.vue";
import { useGame } from "../game";

// Customer care: today's tickets, what support cleared, the backlog left and the satisfaction it sets, with a quick
// hire. Support is the company's job on every model, SaaS included. On a product with user content, the reports and
// the moderators who handle them too.
const game = useGame();
const pool = computed(() => game.meta?.staff.find((s) => s.id === "support"));
const moderators = computed(() => game.meta?.staff.find((s) => s.id === "moderators"));
// How much unhandled reports take off the satisfaction target, as a whole percentage.
const reportsCost = computed(() => (game.moderation ? Math.round(100 * (1 - game.moderation.satisfactionFactor)) : 0));
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
      <span class="muted">{{ formatCash(pool.dayRate) }} per mid support person a day</span>
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
          A mid clears {{ formatCount(game.meta.ticketsPerPerson) }} tickets a day. You need the work of about
          {{ game.supportNeeded }} for your users' usual {{ formatCount(game.company.usualTickets) }} a day<template
            v-if="game.company.backlog"
          >, and more to clear the backlog</template>.
        </span>
      </div>
      <GradeCounter :pool="'support'" source="support-panel" />
    </div>
    <p>
      Your customers raise tickets every day, paying and free alike, and more when you're down. Support is your job on
      every model: even on SaaS the provider fixes the platform, but it doesn't answer your customers. Tickets nobody
      answers wait in the backlog, and satisfaction falls the longer it grows.
    </p>
    <div v-if="game.moderation && moderators" class="moderation" data-testid="moderation">
      <div class="row-between panel-head">
        <h3>Reports on user content</h3>
        <span class="muted">{{ formatCash(moderators.dayRate) }} per mid moderator a day</span>
      </div>
      <div class="stats">
        <div class="stat">
          <span class="label">Reports today</span>
          <span class="value" data-testid="reports-today">{{ formatCount(game.moderation.reportsToday) }}</span>
        </div>
        <div class="stat">
          <span class="label">Handled</span>
          <span class="value" data-testid="reports-handled">{{ formatCount(game.moderation.handledToday) }}</span>
          <small>Up to {{ formatCount(game.moderation.dailyClearance) }} a day</small>
        </div>
        <div class="stat">
          <span class="label">Unhandled</span>
          <span :class="['value', { neg: game.moderation.backlog > 0 }]" data-testid="reports-backlog"
            >{{ formatCount(game.moderation.backlog) }}</span
          >
          <small v-if="reportsCost">−{{ reportsCost }}% off satisfaction</small>
          <small v-else>reports waiting</small>
        </div>
        <div class="stat">
          <span class="label">Lawsuit odds</span>
          <span :class="['value', { neg: game.moderation.lawsuitOdds > 1 }]" data-testid="lawsuit-odds"
            >×{{ game.moderation.lawsuitOdds.toFixed(1) }}</span
          >
          <small>{{ game.moderation.lawsuitOdds > 1 ? "from content left up" : "as low as they go" }}</small>
        </div>
      </div>
      <div class="support-hire">
        <div class="staff-info">
          <strong>Moderators</strong>
          <span class="muted" data-testid="moderators-needed">
            A mid handles {{ formatCount(game.meta.reportsPerPerson) }} reports a day. You need the work of about
            {{ game.moderatorsNeeded }} for your users' usual {{ formatCount(game.moderation.usualReports) }} a day<template
              v-if="game.moderation.backlog"
            >, and more to clear the unhandled ones</template>.
          </span>
        </div>
        <GradeCounter :pool="'moderators'" source="support-panel" />
      </div>
      <p>
        Your users post content, and report some of it. Moderators handle the reports. Reports nobody handles pull
        satisfaction down, and content left up makes a lawsuit more likely.
      </p>
    </div>
  </section>
</template>
