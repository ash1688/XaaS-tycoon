<script setup lang="ts">
import type { CsuiteRole } from "@xaas/sim";
import { computed, ref } from "vue";
import { formatCash } from "../api";
import { useGame } from "../game";
import { formatShare } from "../shares";

// The C-suite on People: every role, when it opens, who fills it, and each open role's shortlist to hire from. Hiring
// is for good, so the Hire button asks to confirm first.
const game = useGame();
const csuite = computed(() => game.company?.csuite ?? null);
const open = computed(() => csuite.value?.roles.filter((r) => r.open) ?? []);
const shut = computed(() => csuite.value?.roles.filter((r) => !r.open) ?? []);
const hiredCount = computed(() => csuite.value?.roles.filter((r) => r.executive).length ?? 0);
/** The candidate whose Hire was pressed, waiting for Confirm. */
const confirming = ref<string | null>(null);

async function hire(role: CsuiteRole, candidate: string) {
  confirming.value = null;
  await game.actFrom("hire-executive", { type: "hireExecutive", role, candidate });
}
</script>

<template>
  <section v-if="csuite" class="card" aria-labelledby="csuite-heading" data-testid="csuite">
    <h2 id="csuite-heading">C-suite</h2>
    <p class="muted">
      The company's senior leaders, each role hired once from a shortlist and kept for good: no one in it can be let
      go, and their pay is their own package, so pay reviews leave it alone. Equity asks are paid in new shares, and
      shrink as the C-suite's {{ formatShare(csuite.equityCap) }} cap fills: {{ formatShare(csuite.equityLeft) }} left.
      The staff share scheme doesn't count towards it.
    </p>
    <p data-testid="csuite-ipo">
      Every role must be filled to float: {{ hiredCount }} of {{ csuite.roles.length }} hired.
    </p>
    <p v-if="csuite.payHoliday.since !== null" class="pay-holiday" role="status" data-testid="csuite-pay-holiday">
      <strong>Pay holiday since day {{ csuite.payHoliday.since }}.</strong> Cash is low, so your C-suite is forgoing its
      {{ formatCash(csuite.dailyPay) }} a day of pay until you have {{ csuite.payHoliday.endDays }} days of running
      costs in the bank.
    </p>
    <p v-else-if="csuite.dailyPay" data-testid="csuite-pay">C-suite pay: {{ formatCash(csuite.dailyPay) }} a day.</p>
    <p v-if="csuite.payHoliday.startDays > 0 && csuite.payHoliday.since === null" class="muted" data-testid="csuite-pay-holiday-rule">
      If cash falls below {{ csuite.payHoliday.startDays }} days of running costs, the board forgoes its pay until
      there are {{ csuite.payHoliday.endDays }} days' worth in the bank. Pay it misses isn't owed later.
    </p>
    <div v-for="r in open" :key="r.role" class="role" :data-testid="`csuite-${r.role}`">
      <h3>{{ r.name }}</h3>
      <p class="muted">{{ r.blurb }}</p>
      <div v-if="r.executive" data-testid="csuite-executive">
        <p>
          <strong>{{ r.executive.name }}</strong>, hired on day {{ r.executive.day }}:
          {{ formatCash(r.executive.salary) }} a day{{ r.executive.equity ? `, ${formatShare(r.executive.equity)} of the company` : "" }}.
        </p>
        <ul v-if="r.executive.effects.length" class="effects">
          <li v-for="e in r.executive.effects" :key="e.key">{{ e.text }}</li>
        </ul>
      </div>
      <div v-else class="table-scroll">
        <table class="compare shortlist">
          <caption class="muted">Shortlist</caption>
          <thead>
            <tr>
              <th scope="col">Candidate</th>
              <th scope="col">Strength</th>
              <th scope="col">Pay</th>
              <th scope="col">Equity</th>
              <th scope="col">What they'd do</th>
              <th scope="col"><span class="visually-hidden">Hire</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in r.shortlist" :key="c.id" :data-testid="`candidate-${c.id}`">
              <th scope="row">{{ c.name }}</th>
              <td>{{ Math.round(c.strength * 100) }}%</td>
              <td>{{ formatCash(c.salary) }} a day</td>
              <td>
                {{ c.equity ? formatShare(c.equity) : "None" }}
                <span v-if="c.newShares" class="muted">({{ c.newShares.toLocaleString("en-GB") }} new shares)</span>
              </td>
              <td>
                <ul v-if="c.effects.length" class="effects">
                  <li v-for="e in c.effects" :key="e.key">{{ e.text }}</li>
                </ul>
                <span v-else class="muted">No effect on the business</span>
              </td>
              <td class="hire">
                <template v-if="confirming === c.id">
                  <button
                    type="button"
                    :disabled="game.busy || game.over"
                    data-testid="confirm-hire"
                    @click="hire(r.role, c.id)"
                  >
                    Hire for good
                  </button>
                  <button type="button" class="secondary" @click="confirming = null">Cancel</button>
                </template>
                <button v-else type="button" :disabled="game.busy || game.over" data-testid="hire-executive" @click="confirming = c.id">
                  Hire
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <ul v-if="shut.length" class="shut" data-testid="csuite-shut">
      <li v-for="r in shut" :key="r.role" :data-testid="`csuite-${r.role}`">
        <strong>{{ r.name }}</strong>
        <span class="muted">{{ r.opens }} {{ r.blurb }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.role {
  border-top: 1px solid var(--border, #ddd);
  padding-top: 0.5rem;
  margin-top: 0.5rem;
}
.role h3 {
  margin: 0 0 0.25rem;
  font-size: 1rem;
}
.pay-holiday {
  border-left: 3px solid var(--warn, #c80);
  padding-left: 0.5rem;
}
.effects {
  margin: 0;
  padding-left: 1.1rem;
}
.shortlist td.hire {
  white-space: nowrap;
}
.shut {
  margin: 0.75rem 0 0;
  padding-left: 1.1rem;
}
.shut li {
  margin-bottom: 0.3rem;
}
.shut .muted {
  display: block;
}
</style>
