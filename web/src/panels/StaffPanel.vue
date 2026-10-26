<script setup lang="ts">
import { computed, reactive } from "vue";
import type { StaffGrade, StaffPool, StaffPoolView } from "@xaas/sim";
import { formatCash, formatCount } from "../api";
import GradeCounter from "../components/GradeCounter.vue";
import StaffBulk from "../components/StaffBulk.vue";
import { namesList, useGame } from "../game";

// Developers, ops, support, (on a product with user content) moderators and (once the first angel approaches)
// researchers and marketers, each in junior, mid and senior grades, as permanent or agency staff (researchers and
// marketers permanent only): hire, let go, and retrain someone into another team. Pick permanent or agency and a grade,
// then − and + move one person; the number box under them (StaffBulk) hires or lets go that many at once. Hires start
// after their grade's lead time, agency staff the next day. Letting go permanent staff asks first, showing their
// severance; agency staff go at once, a team's or every team's with one button.
const game = useGame();
const grades = reactive<Record<StaffPool, StaffGrade>>({ developers: "mid", ops: "mid", support: "mid", moderators: "mid", researchers: "mid", marketers: "mid" });
const agency = reactive<Record<StaffPool, boolean>>({ developers: false, ops: false, support: false, moderators: false, researchers: false, marketers: false });
// The pools this company can staff: no moderators without user content, and none until its phase opens (#236).
const pools = computed(() => (game.meta?.staff ?? []).filter((s) => game.company?.staff.some((p) => p.pool === s.id && p.open)));
// Pools not open yet that someone is in, hidden but for a note: the ops and support a company starts with, in Build.
const startingTeam = computed(() =>
  (game.company?.staff ?? [])
    .filter((p) => !p.open && p.headcount + p.agencyCount > 0)
    .map((p) => {
      const people = p.headcount + p.agencyCount;
      const person = game.meta?.staff.find((s) => s.id === p.pool)?.personName ?? p.pool;
      return `${people} ${people === 1 ? person : p.name.toLowerCase()}`;
    }),
);
// Agency staff in every pool, on the team and still to start, and their pay: one button lets them all go, free. Shown
// once two teams have some, as each team has its own.
const hasAgency = (p: StaffPoolView) => p.agencyCount > 0 || p.hiring.some((h) => h.agency);
const agencyTeams = computed(() => (game.company?.staff ?? []).filter(hasAgency).length);
const agencyStarted = computed(() => (game.company?.staff ?? []).reduce((sum, p) => sum + p.agencyCount, 0));
const agencyWaiting = computed(() =>
  (game.company?.staff ?? []).reduce((sum, p) => sum + p.hiring.filter((h) => h.agency).reduce((n, h) => n + h.count, 0), 0),
);
const agencyPay = computed(() =>
  (game.company?.staff ?? []).reduce((sum, p) => sum + p.agency.reduce((n, g) => n + g.count * g.dayRate, 0), 0),
);
// Every move from one team to another, developers and ops first as they're the usual swap.
const moves = computed(() =>
  pools.value.flatMap((to) => pools.value.filter((from) => from.id !== to.id).map((from) => ({ from, to }))),
);
const rank = (pool: StaffPool) =>
  pool === "marketers" ? 4 : pool === "researchers" ? 3 : pool === "moderators" ? 2 : pool === "support" ? 1 : 0;
const moveOrder = (from: StaffPool, to: StaffPool) => Math.max(rank(from), rank(to));
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
    <div v-if="agencyTeams > 1" class="staff-bulk" data-testid="agency-all">
      <button
        class="ghost"
        :disabled="game.busy || game.over"
        data-testid="let-go-agency-all"
        @click="game.actFrom('staff-let-go-agency-all', { type: 'letGoAgency' })"
      >
        Let go all agency staff
      </button>
      <span class="muted staff-bulk-cost">
        Every team's: lets go {{ agencyStarted }} on the team<template v-if="agencyWaiting">
          and cancels {{ agencyWaiting }} still to start</template
        >,
        saving {{ formatCash(agencyPay) }} a day. No severance.
      </span>
    </div>
    <p class="muted staff-grades-note">
      Juniors start soonest and cost least, but do the least. Seniors do the most for their pay, but take longest to
      start. Work is counted in mids: what's measured against ops needed, a build's developer-days and tickets cleared.
    </p>
    <ul class="staff">
      <li v-for="pool in pools" :key="pool.id" :data-pool="pool.id">
        <div class="staff-info">
          <strong>{{ pool.name }}</strong>
          <span class="muted" :data-testid="`${pool.id}-work`">
            Does the work of {{ formatCount(game.work(pool.id)) }} mid{{ game.work(pool.id) === 1 ? "" : "s" }}
          </span>
          <span v-if="game.staffPool(pool.id)?.idle" class="idle-note" :data-testid="`${pool.id}-idle`">
            {{ game.staffPool(pool.id)?.idle }}
          </span>
          <span v-if="pool.id === 'support'" class="muted" data-testid="support-hint">
            A mid clears {{ formatCount(game.meta.ticketsPerPerson) }} tickets a day.
            <template v-if="game.company.usualTickets">
              Your users raise about {{ formatCount(game.company.usualTickets) }} a day, so you need the work of
              {{ game.supportNeeded }} mid{{ game.supportNeeded === 1 ? "" : "s" }}<template v-if="game.company.backlog"
                >, plus more to clear the backlog</template
              >.
            </template>
            <template v-else-if="game.company.backlog">Your users aren't raising new tickets, but there's a backlog to clear.</template>
            <template v-else>Your users aren't raising tickets yet.</template>
          </span>
          <span v-if="pool.id === 'moderators' && game.moderation" class="muted" data-testid="moderators-hint">
            A mid handles {{ formatCount(game.meta.reportsPerPerson) }} reports a day.
            <template v-if="game.moderation.usualReports">
              Your users report about {{ formatCount(game.moderation.usualReports) }} posts a day, so you need the work of
              {{ game.moderatorsNeeded }} mid{{ game.moderatorsNeeded === 1 ? "" : "s" }}<template
                v-if="game.moderation.backlog"
                >, plus more to clear the unhandled ones</template
              >.
            </template>
            <template v-else-if="game.moderation.backlog">Your users aren't reporting new posts, but there are reports to handle.</template>
            <template v-else>Your users aren't reporting posts yet.</template>
          </span>
        </div>
        <GradeCounter v-model:grade="grades[pool.id]" v-model:agency="agency[pool.id]" :pool="pool.id" source="staff" />
        <StaffBulk v-model:grade="grades[pool.id]" v-model:agency="agency[pool.id]" :pool="pool.id" source="staff" />
      </li>
    </ul>
    <p v-if="startingTeam.length" class="muted" data-testid="starting-team">
      Also on the team from the start: {{ namesList(startingTeam) }}. Hiring more opens in the Launch phase, when you
      press Launch.
    </p>
    <div v-if="sortedMoves.length" class="move-staff" data-testid="move-staff">
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
    <p v-if="game.isOpen('ops')" :class="['ops-needed', { warn: game.understaffed }]" data-testid="ops-needed">
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
