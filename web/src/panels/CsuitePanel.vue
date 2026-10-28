<script setup lang="ts">
import type { CsuiteRole } from "@xaas/sim";
import { computed } from "vue";
import { formatCash } from "../api";
import { useGame } from "../game";
import { formatShare } from "../shares";

// The C-suite, on its own page: every role, when it opens, who fills it, and each open role's shortlist to hire from.
// Hire hires at once: the panel says up front that hiring is for good. A role that isn't open yet is hidden (#236).
const game = useGame();
const csuite = computed(() => game.company?.csuite ?? null);
const open = computed(() => csuite.value?.roles.filter((r) => r.open) ?? []);
const hiredCount = computed(() => csuite.value?.roles.filter((r) => r.executive).length ?? 0);
async function hire(role: CsuiteRole, candidate: string) {
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
    <p v-if="game.isOpen('ipo')" data-testid="csuite-ipo">
      Every role must be filled to float: {{ hiredCount }} of {{ csuite.roles.length }} hired.
    </p>
    <p v-if="csuite.payHoliday.since !== null" class="pay-holiday" role="status" data-testid="csuite-pay-holiday">
      <strong>Pay holiday since day {{ csuite.payHoliday.since }}.</strong> Cash is low, so your C-suite is forgoing its
      {{ formatCash(csuite.dailyPay) }} a day of pay until you have {{ csuite.payHoliday.endDays }} days of running
      costs in the bank. It's owed: {{ formatCash(csuite.payHoliday.owed) }} of back pay so far.
    </p>
    <p v-else-if="csuite.payHoliday.owed > 0" class="pay-holiday" data-testid="csuite-back-pay">
      {{ formatCash(csuite.payHoliday.owed) }} of back pay still owed from the pay holiday: paid a little each day as cash
      recovers, from the cash above {{ csuite.payHoliday.startDays }} days of running costs spread over
      {{ csuite.payHoliday.backPayDays }} days. Anything left when the game ends comes off your cash.
    </p>
    <p v-else-if="csuite.dailyPay" data-testid="csuite-pay">C-suite pay: {{ formatCash(csuite.dailyPay) }} a day.</p>
    <p v-if="csuite.payHoliday.startDays > 0 && csuite.payHoliday.since === null" class="muted" data-testid="csuite-pay-holiday-rule">
      If cash falls below {{ csuite.payHoliday.startDays }} days of running costs, the board forgoes its pay until
      there are {{ csuite.payHoliday.endDays }} days' worth in the bank (running costs with C-suite pay, leaving out
      Campaigns). What it misses is owed, and paid back once cash recovers. After
      {{ csuite.payHoliday.walkoutDays }} days unpaid in a row, one executive resigns every
      {{ csuite.payHoliday.walkoutEvery }} days until they're paid, and the bank pays their back pay onto your loan.
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
              <td>
                {{ formatCash(c.salary) }} a day
                <small v-if="c.runway" class="muted runway-note" data-testid="candidate-runway">{{ c.runway }}</small>
              </td>
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
                <button type="button" :disabled="game.busy || game.over" data-testid="hire-executive" @click="hire(r.role, c.id)">
                  Hire
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
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
.runway-note {
  display: block;
}
.shortlist td.hire {
  white-space: nowrap;
}
</style>
