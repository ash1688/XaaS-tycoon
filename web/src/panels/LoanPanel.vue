<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { formatCash } from "../api";
import { useGame } from "../game";
import AppModal from "../components/AppModal.vue";
import LoanTerms from "../components/LoanTerms.vue";

// The bank loan: one per company. Once taken, what's been repaid and what's left; before then, today's terms and a
// modal to take it. The later it's taken, the higher the rate and the fewer days to repay it.
const game = useGame();
const loan = computed(() => game.company?.loan ?? null);
const quote = computed(() => game.company?.loanQuote ?? null);
const repaidPercent = computed(() => (loan.value ? Math.round((100 * loan.value.repaid) / loan.value.total) : 0));
const percent = (rate: number) => `${Math.round(rate * 1000) / 10}%`;

const taking = ref(false);
// For the playtest log: the quote in the modal, logged as it closes with whether the student took it.
let took = false;
watch(taking, (open) => {
  if (open) return;
  game.track("quote", { kind: "loan", confirmed: took });
  took = false;
});
function open() {
  game.error = "";
  taking.value = true;
}
async function take() {
  await game.act({ type: "takeLoan" });
  if (game.error) return;
  took = true;
  taking.value = false;
}
</script>

<template>
  <section v-if="game.company" class="card cat-debt loan-panel" aria-labelledby="loan-heading" data-testid="loan-panel">
    <div class="row-between panel-head">
      <h2 id="loan-heading">Bank loan</h2>
      <span v-if="loan" :class="['badge', loan.remaining ? '' : 'done-badge']" data-testid="loan-status">
        {{ loan.remaining ? "Repaying" : "Repaid" }}
      </span>
      <span v-else class="badge retired-badge" data-testid="loan-status">None</span>
    </div>

    <template v-if="loan">
      <div class="stats">
        <div class="stat">
          <span class="label">Borrowed</span>
          <span class="value" data-testid="loan-borrowed">{{ formatCash(loan.amount) }}</span>
          <small>{{ loan.day === 1 ? "At the start" : `On day ${loan.day}` }}, at {{ percent(loan.rate) }}</small>
        </div>
        <div class="stat">
          <span class="label">Repaid a day</span>
          <span class="value neg" data-testid="loan-daily-repayment">{{ formatCash(loan.dailyRepayment) }}</span>
          <small>Debt, every day until day {{ game.company.finalDay }}</small>
        </div>
        <div class="stat">
          <span class="label">Left to repay</span>
          <span class="value" data-testid="loan-remaining">{{ formatCash(loan.remaining) }}</span>
          <small>{{ loan.daysLeft }} {{ loan.daysLeft === 1 ? "repayment" : "repayments" }} left</small>
        </div>
      </div>
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
        {{ formatCash(loan.repaid) }} of {{ formatCash(loan.total) }} repaid: what you borrowed plus
        {{ formatCash(loan.total - loan.amount) }} interest. Repayments are a fixed cost: they're charged every day,
        however the business is doing, and running out of cash still means bankruptcy.
      </p>
    </template>

    <p v-else-if="game.bankrupt" class="muted" data-testid="loan-bankrupt">
      No loan now: banks don't lend to a company that has gone bankrupt. A loan has to be taken before cash runs out.
    </p>

    <p v-else-if="game.over" class="muted" data-testid="loan-over">This game has ended, so there's no loan to take.</p>

    <template v-else-if="quote">
      <p>
        You can borrow <strong>{{ formatCash(quote.amount) }}</strong> today, repaid at
        <strong>{{ formatCash(quote.dailyRepayment) }}</strong> a day until day {{ quote.lastDay }}. One loan per company,
        and the longer you wait, the higher the interest and the fewer days you have to repay it.
      </p>
      <button data-testid="loan-open" @click="open">Take a loan</button>
    </template>

    <p v-else class="muted" data-testid="loan-too-late">
      It's too late to borrow: the bank won't lend this close to the end of the game.
    </p>

    <AppModal :open="taking" title="Take a bank loan" @close="taking = false">
      <template v-if="quote">
        <p v-if="game.error" class="error" role="alert">{{ game.error }}</p>
        <LoanTerms :quote="quote" />
        <p class="muted">
          The money arrives now. Repayments start tomorrow and are charged every day as debt, whatever happens. You can
          only take one loan.
        </p>
        <div class="confirm-buttons">
          <button :disabled="game.busy" data-testid="loan-confirm" @click="take">
            Borrow {{ formatCash(quote.amount) }}
          </button>
          <button class="ghost" :disabled="game.busy" @click="taking = false">Not now</button>
        </div>
      </template>
    </AppModal>
  </section>
</template>
