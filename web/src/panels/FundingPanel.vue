<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { FunderId, Terms } from "@xaas/sim";
import { api, formatCash } from "../api";
import { days, useGame } from "../game";
import AppModal from "../components/AppModal.vue";
import NegotiationBox, { type CounterField } from "../components/NegotiationBox.vue";
import { formatShare, formatSharePrice } from "../shares";

// Friends and family and the grant: on Finance from day 1, each a fixed offer to accept or decline once. Friends and
// family buy new shares at today's share price, diluting the student; the grant gives cash for no shares, on an
// uptime condition that's enforced: break it and it's paid back. Either can be negotiated first: the student counters,
// a dice roll sets the next offer, and the third is final. Both close for good once the first angel is accepted.
const game = useGame();
const funding = computed(() => game.company?.funding ?? null);
const ff = computed(() => funding.value?.friendsAndFamilyOffer ?? null);
const grantOffer = computed(() => funding.value?.grantOffer ?? null);
const grant = computed(() => funding.value?.grant ?? null);
const closedDay = computed(() => funding.value?.closedDay ?? null);
const grantUsedPercent = computed(() =>
  grant.value?.maxHoursDown ? Math.min(100, Math.round((100 * grant.value.hoursDown) / grant.value.maxHoursDown)) : 0,
);
const GRANT_STATUS = { accepted: "Condition running", met: "Kept", withdrawn: "Withdrawn", declined: "Declined" } as const;

const reviewing = ref<FunderId | null>(null);
// For the playtest log: the offer in the modal, logged as it closes with whether the student accepted it.
let accepted = false;
watch(reviewing, (open, was) => {
  if (open || !was) return;
  game.track("quote", { kind: was, confirmed: accepted });
  accepted = false;
});
function review(funder: FunderId) {
  game.error = "";
  reviewing.value = funder;
}
// Negotiating the offer in the modal: friends and family on their cash and share, the grant on its cash and days.
const talks = computed(() => (reviewing.value ? (funding.value?.negotiations[reviewing.value] ?? null) : null));
const isFf = computed(() => reviewing.value === "friendsAndFamily");
const FF_FIELDS: CounterField[] = [
  { key: "amount", label: "Cash (£)", step: 100, min: 0, testid: "counter-amount" },
  { key: "share", label: "Their share (%)", percent: true, step: 0.1, min: 0.1, max: 99, testid: "counter-share" },
];
const GRANT_FIELDS: CounterField[] = [
  { key: "amount", label: "Cash (£)", step: 100, min: 0, testid: "counter-amount" },
  { key: "days", label: "Condition (days)", step: 1, min: 1, testid: "counter-days" },
];
/** An offer's terms in words: friends and family's cash for their share, the grant's cash for its condition's days. */
const termsText = (t: Terms) =>
  isFf.value ? `${formatCash(t.amount!)} for ${formatShare(t.share!)}` : `${formatCash(t.amount!)}, uptime kept for ${days(t.days!)}`;
const oddsFor = (terms: Partial<Terms>) =>
  api.counterOdds(game.code, game.id, reviewing.value!, terms as Record<string, number>);
async function counter(terms: Partial<Terms>) {
  const funder = reviewing.value;
  if (funder) await game.act({ type: "counterFunding", funder, terms });
}

async function answer(type: "acceptFunding" | "declineFunding") {
  const funder = reviewing.value;
  if (!funder) return;
  await game.act({ type, funder });
  if (game.error) return;
  accepted = type === "acceptFunding";
  reviewing.value = null;
}
</script>

<template>
  <section v-if="funding" class="card span-all cat-equity equity-panel" aria-labelledby="funding-heading" data-testid="funding-panel">
    <h2 id="funding-heading">Funding</h2>
    <p v-if="closedDay !== null" class="muted" data-testid="funding-closed">
      Friends and family and grants closed on day {{ closedDay }}, when you took on your angel investor.
    </p>
    <p v-else class="muted">
      Two offers are open from the start, until you take on an angel investor. Each can be negotiated, then accepted or
      declined once, and pays everything up front.
    </p>
    <div class="funding-offers">
      <article class="funder" data-testid="funder-friendsAndFamily">
        <div class="row-between">
          <h3>Friends and family</h3>
          <span v-if="funding.friendsAndFamily" :class="['badge', funding.friendsAndFamily.status === 'accepted' ? 'done-badge' : 'retired-badge']">
            {{ funding.friendsAndFamily.status === "accepted" ? "Accepted" : "Declined" }}
          </span>
          <span v-else-if="closedDay !== null" class="badge retired-badge">Closed</span>
          <span v-else class="badge">Open</span>
        </div>
        <template v-if="ff">
          <p>
            <strong>{{ formatCash(ff.amount) }}</strong> for new shares at today's share price: about
            <strong>{{ formatShare(ff.theirShare) }}</strong> of the company. No target to hit.
          </p>
          <button v-if="!game.over" data-testid="ff-review" @click="review('friendsAndFamily')">Review offer</button>
        </template>
        <p v-else-if="funding.friendsAndFamily?.status === 'accepted'" data-testid="ff-taken">
          Put in {{ formatCash(funding.friendsAndFamily.amount) }} on day {{ funding.friendsAndFamily.day }} for
          {{ funding.friendsAndFamily.shares.toLocaleString("en-GB") }} shares, at a valuation of
          {{ formatCash(funding.friendsAndFamily.valuation) }}.
        </p>
        <p v-else-if="funding.friendsAndFamily" class="muted">Declined on day {{ funding.friendsAndFamily.day }}.</p>
        <p v-else-if="closedDay !== null" class="muted">Closed on day {{ closedDay }}: friends and family don't invest once an angel has.</p>
      </article>

      <article class="funder" data-testid="funder-grant">
        <div class="row-between">
          <h3>Grant</h3>
          <span v-if="grant" :class="['badge', { 'done-badge': grant.status === 'met', 'warn-badge': grant.status === 'withdrawn', 'retired-badge': grant.status === 'declined' }]" data-testid="grant-status">
            {{ GRANT_STATUS[grant.status] }}
          </span>
          <span v-else-if="closedDay !== null" class="badge retired-badge">Closed</span>
          <span v-else class="badge">Open</span>
        </div>
        <template v-if="grantOffer">
          <p>
            <strong>{{ formatCash(grantOffer.amount) }}</strong> for no shares, on a condition:
            {{ grantOffer.condition }}
          </p>
          <button v-if="!game.over" data-testid="grant-review" @click="review('grant')">Review offer</button>
        </template>
        <template v-else-if="grant?.status === 'accepted'">
          <p data-testid="grant-condition">
            {{ formatCash(grant.amount) }} received on day {{ grant.day }}.
            <template v-if="grant.untilDay === null">
              Keep uptime at {{ grant.minUptime }}% or more for {{ days(grant.days) }} once your launch is over: at most
              {{ grant.maxHoursDown }} hours down in all.
            </template>
            <template v-else>
              Keep uptime at {{ grant.minUptime }}% or more from day {{ grant.fromDay }} to day {{ grant.untilDay }}:
              {{ grant.hoursDown }} of {{ grant.maxHoursDown }} hours down used, {{ grant.hoursLeft }} left,
              {{ days(grant.daysLeft) }} to go.
            </template>
          </p>
          <div
            class="loan-bar"
            role="progressbar"
            :aria-valuenow="grantUsedPercent"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-label="`${grantUsedPercent}% of the downtime allowed used`"
          >
            <span :style="{ width: `${grantUsedPercent}%` }"></span>
          </div>
          <p class="muted">Go over and the whole grant is paid back at once.</p>
        </template>
        <p v-else-if="grant?.status === 'met'">
          Condition kept: {{ grant.hoursDown }} hours down to day {{ grant.untilDay }}. The {{ formatCash(grant.amount) }}
          is yours.
        </p>
        <p v-else-if="grant?.status === 'withdrawn'" class="error" data-testid="grant-withdrawn">
          Withdrawn: {{ grant.hoursDown }} hours down went over the {{ grant.maxHoursDown }} allowed, so the
          {{ formatCash(grant.amount) }} was paid back.
        </p>
        <p v-else-if="grant" class="muted">Declined on day {{ grant.day }}.</p>
        <p v-else-if="closedDay !== null" class="muted">Closed on day {{ closedDay }}: grants are for companies without an angel.</p>
      </article>
    </div>

    <AppModal
      :open="reviewing !== null"
      :title="reviewing === 'grant' ? 'Grant offer' : 'Friends and family offer'"
      @close="reviewing = null"
    >
      <p v-if="game.error" class="error" role="alert">{{ game.error }}</p>
      <template v-if="reviewing === 'friendsAndFamily' && ff">
        <table class="quote" data-testid="ff-preview">
          <tbody>
            <tr>
              <th scope="row">They put in</th>
              <td>{{ formatCash(ff.amount) }}, now</td>
            </tr>
            <tr>
              <th scope="row">{{ talks?.rounds.length ? "Valuation they're paying" : "Valuation today" }}</th>
              <td>{{ formatCash(ff.valuation) }}: {{ formatSharePrice(ff.sharePrice) }} a share</td>
            </tr>
            <tr>
              <th scope="row">New shares for them</th>
              <td>{{ ff.newShares.toLocaleString("en-GB") }}, making {{ ff.sharesAfter.toLocaleString("en-GB") }} in issue</td>
            </tr>
            <tr>
              <th scope="row">They'll own</th>
              <td data-testid="ff-their-share">{{ formatShare(ff.theirShare) }}</td>
            </tr>
            <tr>
              <th scope="row">You'll own</th>
              <td data-testid="ff-your-share">{{ formatShare(ff.yourShareBefore) }} → {{ formatShare(ff.yourShareAfter) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="muted">
          You keep your shares, but they become a smaller part of the company. The higher the valuation when you take
          it, the less of the company it costs. You can only answer this offer once.
        </p>
      </template>
      <template v-else-if="reviewing === 'grant' && grantOffer">
        <table class="quote" data-testid="grant-preview">
          <tbody>
            <tr>
              <th scope="row">You get</th>
              <td>{{ formatCash(grantOffer.amount) }}, now, for no shares</td>
            </tr>
            <tr>
              <th scope="row">Condition</th>
              <td>{{ grantOffer.condition }}</td>
            </tr>
            <tr>
              <th scope="row">If you break it</th>
              <td>{{ grantOffer.ifMissed }}</td>
            </tr>
          </tbody>
        </table>
        <p class="muted">
          <template v-if="grantOffer.untilDay !== null">
            The condition runs from day {{ grantOffer.fromDay }} to day {{ grantOffer.untilDay }}.
          </template>
          <template v-else>The condition starts once your launch is over, so the launch itself doesn't count.</template>
          You can only answer this offer once.
        </p>
      </template>
      <NegotiationBox
        v-if="talks"
        :key="reviewing ?? ''"
        :talks="talks"
        :fields="isFf ? FF_FIELDS : GRANT_FIELDS"
        :terms-text="termsText"
        :better="isFf ? 'a smaller share' : 'a shorter condition'"
        :odds="oddsFor"
        :counter="counter"
      />
      <div class="confirm-buttons">
        <button :disabled="game.busy" data-testid="funding-accept" @click="answer('acceptFunding')">
          Accept {{ formatCash(reviewing === "grant" ? (grantOffer?.amount ?? 0) : (ff?.amount ?? 0)) }}
        </button>
        <button class="ghost" :disabled="game.busy" data-testid="funding-decline" @click="answer('declineFunding')">
          Decline for good
        </button>
        <button class="ghost" :disabled="game.busy" @click="reviewing = null">Not now</button>
      </div>
    </AppModal>
  </section>
</template>
