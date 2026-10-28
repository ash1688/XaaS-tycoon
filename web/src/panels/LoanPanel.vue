<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { formatCash } from "../api";
import { useGame } from "../game";
import AppModal from "../components/AppModal.vue";
import LoanTerms from "../components/LoanTerms.vue";

// Bank loans: one at a time, each over a fixed term. While one is being repaid, what's been repaid and what's left,
// and a modal to pay it off early; once it's repaid, or before the first, today's terms and a modal to take one. The
// later it's taken, the higher the rate and the shorter the term.
const game = useGame();
const loan = computed(() => game.company?.loan ?? null);
const open = computed(() => (loan.value && !loan.value.repaidInFull ? loan.value : null));
const quote = computed(() => game.company?.loanQuote ?? null);
const repaidPercent = computed(() => (open.value ? Math.round((100 * open.value.repaid) / open.value.total) : 0));
const percent = (rate: number) => `${Math.round(rate * 1000) / 10}%`;

const taking = ref(false);
const paying = ref(false);
// For the playtest log: the quote in the modal, logged as it closes with whether the student took it.
let took = false;
watch(taking, (shown) => {
  if (shown) return;
  game.track("quote", { kind: "loan", confirmed: took });
  took = false;
});
function openTake() {
  game.error = "";
  taking.value = true;
}
function openPayOff() {
  game.error = "";
  paying.value = true;
}
async function take() {
  await game.act({ type: "takeLoan" });
  if (game.error) return;
  took = true;
  taking.value = false;
}
async function payOff() {
  await game.act({ type: "repayLoan" });
  if (!game.error) paying.value = false;
}
</script>

<template>
  <section v-if="game.company" class="card cat-debt loan-panel" aria-labelledby="loan-heading" data-testid="loan-panel">
    <div class="row-between panel-head">
      <h2 id="loan-heading">{{ open?.emergency ? "Emergency loan" : "Bank loan" }}</h2>
      <span v-if="loan" :class="['badge', open ? '' : 'done-badge']" data-testid="loan-status">
        {{ open ? "Repaying" : "Repaid" }}
      </span>
      <span v-else class="badge retired-badge" data-testid="loan-status">None</span>
    </div>

    <template v-if="open">
      <div class="stats">
        <div class="stat">
          <span class="label">Borrowed</span>
          <span class="value" data-testid="loan-borrowed">{{ formatCash(open.amount) }}</span>
          <small>{{ open.day === 1 ? "At the start" : `On day ${open.day}` }}, at {{ percent(open.rate) }}</small>
        </div>
        <div class="stat">
          <span class="label">Repaid a day</span>
          <span class="value neg" data-testid="loan-daily-repayment">{{ formatCash(open.dailyRepayment) }}</span>
          <small>Debt, every day for {{ open.term }} days, until day {{ open.lastDay }}</small>
        </div>
        <div class="stat">
          <span class="label">Left to repay</span>
          <span class="value" data-testid="loan-remaining">{{ formatCash(open.remaining) }}</span>
          <small>{{ open.daysLeft }} {{ open.daysLeft === 1 ? "repayment" : "repayments" }} left</small>
        </div>
      </div>
      <p v-if="open.emergency" class="muted" data-testid="loan-emergency">
        The bank opened this emergency loan when cash went below £0 with no loan to put the shortfall on. It wants its
        money back fast, so the term is short.
      </p>
      <p v-if="game.company.shortfall.owed > 0" class="muted" data-testid="loan-shortfall">
        {{ formatCash(game.company.shortfall.owed) }} of it is shortfalls from cash going below £0.
        {{ formatCash(game.company.shortfall.room) }} more and
        {{ game.company.rescue ? "the company goes into liquidation" : "a vulture VC steps in, for most of the company" }}:
        that's {{ game.company.shortfall.limitDays }} days of costs ({{ formatCash(game.company.shortfall.limit) }}).
      </p>
      <div
        class="loan-bar"
        role="progressbar"
        :aria-valuenow="repaidPercent"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-label="`${repaidPercent}% repaid`"
      >
        <span :style="{ width: `${repaidPercent}%` }"></span>
      </div>
      <p class="muted">
        {{ formatCash(open.repaid) }} of {{ formatCash(open.total) }} repaid: what you borrowed plus
        {{ formatCash(open.total - open.amount) }} interest. Repayments are a fixed cost: they're charged every day,
        however the business is doing, and running out of cash still means a rescue buyout, or liquidation.
      </p>
      <p v-if="!game.over" data-testid="loan-payoff">
        Paying it off now costs <strong>{{ formatCash(open.payoff) }}</strong>, what's left of the money you borrowed,
        and saves <strong>{{ formatCash(open.interestSaved) }}</strong> of interest.
        <button class="ghost" data-testid="loan-repay-open" @click="openPayOff">Pay it off</button>
      </p>
    </template>

    <p v-else-if="loan" class="muted" data-testid="loan-repaid">
      Your {{ formatCash(loan.amount) }} loan from {{ loan.day === 1 ? "the start" : `day ${loan.day}` }} is repaid
      <template v-if="loan.paidOffDay !== null">
        early, on day {{ loan.paidOffDay }}: {{ formatCash(loan.interestPaid) }} interest, saving
        {{ formatCash(loan.total - loan.repaid) }}.
      </template>
      <template v-else>in full: {{ formatCash(loan.interestPaid) }} interest.</template>
    </p>

    <p v-if="!open && game.liquidated" class="muted" data-testid="loan-liquidated">
      No loan now: banks don't lend to a company in liquidation. A loan has to be taken before cash runs out.
    </p>

    <p v-else-if="!open && game.over" class="muted" data-testid="loan-over">
      This game has ended, so there's no loan to take.
    </p>

    <template v-else-if="!open && quote">
      <p>
        You can borrow <strong>{{ formatCash(quote.amount) }}</strong> today, repaid at
        <strong>{{ formatCash(quote.dailyRepayment) }}</strong> a day for {{ quote.days }} days, until day
        {{ quote.lastDay }}. One loan at a time, and the longer you wait, the higher the interest and the shorter the
        term.
      </p>
      <button data-testid="loan-open" @click="openTake">Take a loan</button>
    </template>

    <p v-else-if="!open" class="muted" data-testid="loan-too-late">
      It's too late to borrow: the bank won't lend this close to the end of the game.
    </p>

    <AppModal small :open="taking" title="Take a bank loan" @close="taking = false">
      <template v-if="quote">
        <p v-if="game.error" class="error" role="alert">{{ game.error }}</p>
        <LoanTerms :quote="quote" />
        <p class="muted">
          The money arrives now. Repayments start tomorrow and are charged every day as debt, whatever happens. You can
          pay it off early to save interest, and take another loan once it's repaid.
        </p>
        <div class="confirm-buttons">
          <button :disabled="game.busy" data-testid="loan-confirm" @click="take">
            Borrow {{ formatCash(quote.amount) }}
          </button>
          <button class="ghost" :disabled="game.busy" @click="taking = false">Not now</button>
        </div>
      </template>
    </AppModal>

    <AppModal small :open="paying" title="Pay off the bank loan" @close="paying = false">
      <template v-if="open">
        <p v-if="game.error" class="error" role="alert">{{ game.error }}</p>
        <table class="quote" data-testid="loan-repay-quote">
          <tbody>
            <tr>
              <th scope="row">Left to repay over the term</th>
              <td>{{ formatCash(open.remaining) }}</td>
            </tr>
            <tr>
              <th scope="row">Pay now <span class="muted">what's left of the money you borrowed</span></th>
              <td data-testid="loan-repay-cost">{{ formatCash(open.payoff) }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Interest you save</th>
              <td data-testid="loan-repay-saved">{{ formatCash(open.interestSaved) }}</td>
            </tr>
          </tfoot>
        </table>
        <p class="muted">
          The money leaves your cash now, and there are no more repayments. Keep enough cash to run the business.
        </p>
        <div class="confirm-buttons">
          <button :disabled="game.busy" data-testid="loan-repay-confirm" @click="payOff">
            Pay {{ formatCash(open.payoff) }}
          </button>
          <button class="ghost" :disabled="game.busy" @click="paying = false">Not now</button>
        </div>
      </template>
    </AppModal>
  </section>
</template>
