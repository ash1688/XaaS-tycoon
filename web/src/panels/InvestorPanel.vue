<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Terms } from "@xaas/sim";
import { api, formatCash } from "../api";
import { days, useGame } from "../game";
import AppModal from "../components/AppModal.vue";
import NegotiationBox, { type CounterField } from "../components/NegotiationBox.vue";
import { formatShare, formatSharePrice } from "../shares";

// Investors who come to the student: an angel approaches a company doing well, with an offer that shows its target
// and what missing it costs. The student negotiates, accepts or declines it; declining brings another angel a few days
// later. Accepting sets the valuation to the angel's figure and closes friends and family and grants.
const game = useGame();
const investors = computed(() => game.company?.investors ?? null);
const offer = computed(() => investors.value?.offer ?? null);
const talks = computed(() => investors.value?.negotiation ?? null);
const angel = computed(() => investors.value?.angel ?? null);
const lastDeclined = computed(() => investors.value?.declined.at(-1) ?? null);
const targetPercent = computed(() =>
  angel.value ? Math.min(100, Math.round((100 * angel.value.dailyRevenue) / angel.value.target.dailyRevenue)) : 0,
);
const TARGET_STATUS = { running: "Target running", met: "Target met", missed: "Target missed" } as const;

const reviewing = ref(false);
// For the playtest log: the offer, logged as the modal closes with whether the student accepted it.
let accepted = false;
watch(reviewing, (open, was) => {
  if (open || !was) return;
  game.track("quote", { kind: "angel", confirmed: accepted });
  accepted = false;
});
function review() {
  game.error = "";
  reviewing.value = true;
}
// The offer closes once answered, so the modal does too.
watch(offer, (o) => {
  if (!o) reviewing.value = false;
});

const FIELDS: CounterField[] = [
  { key: "amount", label: "Cash (£)", step: 100, min: 0, testid: "counter-amount" },
  { key: "share", label: "Their share (%)", percent: true, step: 0.1, min: 0.1, max: 99, testid: "counter-share" },
];
const termsText = (t: Terms) => `${formatCash(t.amount!)} for ${formatShare(t.share!)}`;
const oddsFor = (terms: Partial<Terms>) => api.investorOdds(game.code, game.id, terms as Record<string, number>);
async function counter(terms: Partial<Terms>) {
  await game.act({ type: "counterInvestor", terms });
}

async function answer(type: "acceptInvestor" | "declineInvestor") {
  await game.act({ type });
  if (game.error) return;
  accepted = type === "acceptInvestor";
  reviewing.value = false;
}
</script>

<template>
  <section v-if="investors" class="card span-all cat-equity equity-panel" aria-labelledby="investors-heading" data-testid="investor-panel">
    <h2 id="investors-heading">Investors</h2>
    <article class="funder" data-testid="angel">
      <div class="row-between">
        <h3>Angel investor</h3>
        <span v-if="offer" class="badge warn-badge">Wants to invest</span>
        <span
          v-else-if="angel"
          :class="['badge', { 'done-badge': angel.status === 'met', 'warn-badge': angel.status === 'missed' }]"
          data-testid="angel-status"
        >
          {{ TARGET_STATUS[angel.status] }}
        </span>
      </div>
      <template v-if="offer">
        <p data-testid="angel-offer">
          <strong>{{ offer.investor }}</strong> likes what you're doing and wants to invest
          <strong>{{ formatCash(offer.amount) }}</strong> for <strong>{{ formatShare(offer.theirShare) }}</strong> of the
          company, with a target to hit.
        </p>
        <button v-if="!game.over" data-testid="angel-review" @click="review">Review offer</button>
      </template>
      <template v-else-if="angel">
        <p data-testid="angel-deal">
          {{ angel.investor }} put in {{ formatCash(angel.amount) }} on day {{ angel.day }} for
          {{ angel.shares.toLocaleString("en-GB") }} shares, valuing the company at {{ formatCash(angel.valuation) }}. Your
          valuation follows theirs, moving in step with the formula.
        </p>
        <template v-if="angel.status === 'running'">
          <p data-testid="angel-target">
            Their target: income of {{ formatCash(angel.target.dailyRevenue) }} a day, averaged over
            {{ days(angel.target.days) }}, by day {{ angel.target.byDay }}. You're at {{ formatCash(angel.dailyRevenue) }}
            a day, with {{ days(angel.daysLeft) }} to go.
          </p>
          <div
            class="loan-bar"
            role="progressbar"
            :aria-valuenow="targetPercent"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-label="`${targetPercent}% of the way to the angel's target`"
          >
            <span :style="{ width: `${targetPercent}%` }"></span>
          </div>
          <p class="muted">Miss it and they take extra shares, diluting you.</p>
        </template>
        <p v-else-if="angel.status === 'met'">Target met on day {{ angel.settledDay }}.</p>
        <p v-else class="error" data-testid="angel-missed">
          Target missed on day {{ angel.settledDay }}: they took {{ angel.extraShares.toLocaleString("en-GB") }} extra
          shares.
        </p>
      </template>
      <p v-else-if="investors.anotherComing && lastDeclined" class="muted" data-testid="angel-coming">
        You declined {{ lastDeclined.investor }} on day {{ lastDeclined.day }}. Another angel will approach in a few days.
      </p>
      <p v-else class="muted">
        Investors come to you: an angel approaches once your company is doing well. You'll get a notification.
      </p>
    </article>

    <AppModal :open="reviewing && offer !== null" title="Angel investor's offer" @close="reviewing = false">
      <p v-if="game.error" class="error" role="alert">{{ game.error }}</p>
      <template v-if="offer">
        <table class="quote" data-testid="angel-preview">
          <tbody>
            <tr>
              <th scope="row">They put in</th>
              <td>{{ formatCash(offer.amount) }}, now, all of it</td>
            </tr>
            <tr>
              <th scope="row">They value the company at</th>
              <td class="words" data-testid="angel-valuation">
                {{ formatCash(offer.preMoney) }} before their cash, {{ formatCash(offer.valuation) }} with it (today's
                valuation: {{ formatCash(offer.formulaValuation) }})
              </td>
            </tr>
            <tr>
              <th scope="row">New shares for them</th>
              <td>
                {{ offer.newShares.toLocaleString("en-GB") }} at {{ formatSharePrice(offer.sharePrice) }}, making
                {{ offer.sharesAfter.toLocaleString("en-GB") }} in issue
              </td>
            </tr>
            <tr>
              <th scope="row">They'll own</th>
              <td data-testid="angel-their-share">{{ formatShare(offer.theirShare) }}</td>
            </tr>
            <tr>
              <th scope="row">You'll own</th>
              <td>{{ formatShare(offer.yourShareBefore) }} → {{ formatShare(offer.yourShareAfter) }}</td>
            </tr>
            <tr>
              <th scope="row">Their target</th>
              <td class="words" data-testid="angel-condition">{{ offer.condition }}</td>
            </tr>
            <tr>
              <th scope="row">If you miss it</th>
              <td class="words" data-testid="angel-if-missed">{{ offer.ifMissed }}</td>
            </tr>
          </tbody>
        </table>
        <ul class="muted" data-testid="angel-effects">
          <li v-for="e in offer.effects" :key="e">{{ e }}</li>
        </ul>
        <NegotiationBox
          v-if="talks"
          :talks="talks"
          :fields="FIELDS"
          :terms-text="termsText"
          better="a smaller share"
          :odds="oddsFor"
          :counter="counter"
        />
      </template>
      <div class="confirm-buttons">
        <button :disabled="game.busy" data-testid="angel-accept" @click="answer('acceptInvestor')">
          Accept {{ formatCash(offer?.amount ?? 0) }}
        </button>
        <button class="ghost" :disabled="game.busy" data-testid="angel-decline" @click="answer('declineInvestor')">
          Decline
        </button>
        <button class="ghost" :disabled="game.busy" @click="reviewing = false">Not now</button>
      </div>
    </AppModal>
  </section>
</template>
