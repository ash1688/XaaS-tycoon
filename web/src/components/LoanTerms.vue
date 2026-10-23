<script setup lang="ts">
import type { LoanQuote } from "@xaas/sim";
import { formatCash } from "../api";

// A bank loan's terms, to read before accepting: what you get, the interest, and what you pay back each day over its
// term. Used on the new-game form and the Finance page's take-loan modal.
defineProps<{ quote: LoanQuote }>();
const percent = (rate: number) => `${Math.round(rate * 1000) / 10}%`;
</script>

<template>
  <table class="quote loan-terms" data-testid="loan-terms">
    <tbody>
      <tr>
        <th scope="row">You borrow</th>
        <td data-testid="loan-amount">{{ formatCash(quote.amount) }}</td>
      </tr>
      <tr>
        <th scope="row">
          Interest
          <span class="muted">{{ percent(quote.rate) }} of what you borrow</span>
        </th>
        <td data-testid="loan-interest">{{ formatCash(quote.interest) }}</td>
      </tr>
      <tr>
        <th scope="row">
          Repaid every day
          <span class="muted">for {{ quote.days }} days, until day {{ quote.lastDay }}, whatever happens</span>
        </th>
        <td data-testid="loan-daily">{{ formatCash(quote.dailyRepayment) }}</td>
      </tr>
    </tbody>
    <tfoot>
      <tr>
        <th scope="row">You repay in all</th>
        <td data-testid="loan-total">{{ formatCash(quote.total) }}</td>
      </tr>
    </tfoot>
  </table>
</template>
