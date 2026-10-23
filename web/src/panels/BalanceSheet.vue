<script setup lang="ts">
import { computed } from "vue";
import { SPEND_CATEGORIES } from "@xaas/sim";
import { CATEGORY_LABELS, formatCash, formatRate } from "../api";
import { useGame } from "../game";

// The balance sheet: income against costs by category, and the profit or loss they leave, for the last day played
// and for the game so far. The day's figures come from the summary so far, which the Finance page keeps fresh. Costs
// are everything spent, as cash fell by it; the principal paid back on bank loans is then added back, as only their
// interest is a cost, so profit is the summary's and the teacher's.
const game = useGame();
const lastDay = computed(() => game.summary?.days.at(-1));
const costs = (s: Record<(typeof SPEND_CATEGORIES)[number], number>) => SPEND_CATEGORIES.reduce((sum, c) => sum + s[c], 0);
const totalCosts = computed(() => (game.company ? costs(game.company.spend) : 0));
const totalInterest = computed(() => game.company?.interestPaid ?? 0);
const totalPrincipal = computed(() => (game.company ? game.company.spend.debt - totalInterest.value : 0));
const totalProfit = computed(() =>
  game.company ? game.company.income - totalCosts.value + totalPrincipal.value : 0,
);
const dayCosts = computed(() => (lastDay.value ? costs(lastDay.value) : 0));
// The summary's costs for the day count only the interest in the day's repayment.
const dayCostsForProfit = computed(() => game.summary?.incomeVsCosts.at(-1)?.costs ?? 0);
const dayPrincipal = computed(() => dayCosts.value - dayCostsForProfit.value);
const dayProfit = computed(() => (lastDay.value ? lastDay.value.income - dayCostsForProfit.value : 0));
const signed = (n: number) => (n < 0 ? `−${formatCash(-n)}` : formatCash(Math.abs(n)));
// The payments app's two income streams, for the day and so far, and anything else coming in (a paid API).
const payments = computed(() => game.company?.payments ?? null);
const streams = computed(() => {
  const c = game.company;
  const p = payments.value;
  if (!c || !p) return [];
  const day = lastDay.value;
  const dayOther = (day?.income ?? 0) - (day?.feeIncome ?? 0) - (day?.transactionIncome ?? 0);
  const other = c.income - p.feeIncome - p.transactionIncome;
  return [
    { id: "fees", label: "Monthly fees", day: day?.feeIncome ?? 0, total: p.feeIncome },
    { id: "transactions", label: "Transaction fees", day: day?.transactionIncome ?? 0, total: p.transactionIncome },
    ...(other || dayOther ? [{ id: "other", label: "API calls", day: dayOther, total: other }] : []),
  ];
});
</script>

<template>
  <section v-if="game.company" class="card span-all" aria-labelledby="balance-heading" data-testid="balance-sheet">
    <div class="row-between panel-head">
      <h2 id="balance-heading">Balance sheet</h2>
      <span class="muted">
        Income now <strong class="pos">{{ formatCash(game.company.dailyIncome) }}</strong> a day
      </span>
    </div>
    <div class="table-scroll">
      <table class="balance">
        <thead>
          <tr>
            <th scope="col"><span class="visually-hidden">Line</span></th>
            <th scope="col" class="num">{{ lastDay ? `Day ${lastDay.day}` : "Last day" }}</th>
            <th scope="col" class="num">So far</th>
          </tr>
        </thead>
        <tbody>
          <tr class="income-row">
            <th scope="row">Income</th>
            <td class="num pos" data-testid="balance-day-income">{{ formatCash(lastDay?.income ?? 0) }}</td>
            <td class="num pos" data-testid="balance-income">{{ formatCash(game.company.income) }}</td>
          </tr>
          <tr v-for="s in streams" :key="s.id" class="stream-row" :data-testid="`balance-stream-${s.id}`">
            <th scope="row">of which {{ s.label.toLowerCase() }}</th>
            <td class="num pos">{{ formatCash(s.day) }}</td>
            <td class="num pos" :data-testid="`balance-stream-${s.id}-total`">{{ formatCash(s.total) }}</td>
          </tr>
          <tr v-for="c in SPEND_CATEGORIES" :key="c" :class="['cost-row', `cat-${c}`]">
            <th scope="row"><span class="swatch" aria-hidden="true"></span>{{ CATEGORY_LABELS[c] }}</th>
            <td class="num">{{ signed(-(lastDay?.[c] ?? 0)) }}</td>
            <td class="num" :data-testid="`balance-${c}`">{{ signed(-game.company.spend[c]) }}</td>
          </tr>
          <tr class="subtotal">
            <th scope="row">Costs</th>
            <td class="num">{{ signed(-dayCosts) }}</td>
            <td class="num">{{ signed(-totalCosts) }}</td>
          </tr>
          <tr v-if="game.company.loan" class="principal-row">
            <th scope="row">Add back: loan paid back, not a cost</th>
            <td class="num">{{ formatCash(dayPrincipal) }}</td>
            <td class="num" data-testid="balance-principal">{{ formatCash(totalPrincipal) }}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Profit or loss</th>
            <td :class="['num', dayProfit < 0 ? 'neg' : 'pos']" data-testid="balance-day-profit">
              {{ signed(dayProfit) }}
            </td>
            <td :class="['num', totalProfit < 0 ? 'neg' : 'pos']" data-testid="balance-profit">
              {{ signed(totalProfit) }}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
    <p v-if="payments" class="muted" data-testid="balance-streams-note">
      A payments app earns two ways: a monthly fee from each paying business, and
      {{ formatRate(payments.rate) }} of every payment they take. Transaction fees follow the payments: more on paydays
      and Black Friday, none while you're down.
    </p>
    <p class="muted">
      Income is what paying users pay, a day's share of the monthly price each. Profit is income less every cost. Day 1
      includes any upfront cost of your model. Debt is bank loan repayments, part paying back what you
      borrowed and part interest. What you borrowed wasn't income, so paying it back isn't a cost: only the interest
      counts against profit, though your cash pays the whole repayment.
    </p>
    <p v-if="game.company.loan" class="muted" data-testid="balance-debt-split">
      Of the {{ formatCash(game.company.spend.debt) }} repaid so far, {{ formatCash(totalInterest) }} is interest and
      {{ formatCash(totalPrincipal) }} is paying back what you borrowed.
    </p>
  </section>
</template>
