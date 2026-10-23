<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { CounterOdds, FunderId, RollResult, Terms } from "@xaas/sim";
import { api, formatCash } from "../api";
import { days, useGame } from "../game";
import AppModal from "../components/AppModal.vue";
import { formatShare, formatSharePrice } from "../shares";

// Friends and family and the grant: on Finance from day 1, each a fixed offer to accept or decline once. Friends and
// family buy new shares at today's share price, diluting the student; the grant gives cash for no shares, on an
// uptime condition that's enforced: break it and it's paid back. Either can be negotiated first: the student counters,
// a dice roll sets the next offer, and the third is final.
const game = useGame();
const funding = computed(() => game.company?.funding ?? null);
const ff = computed(() => funding.value?.friendsAndFamilyOffer ?? null);
const grantOffer = computed(() => funding.value?.grantOffer ?? null);
const grant = computed(() => funding.value?.grant ?? null);
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
// Negotiating the offer in the modal: its offers and rolls so far, and the counter being drafted, which starts at the
// offer that stands. Friends and family's share is typed as a percent; the grant's condition in days.
const talks = computed(() => (reviewing.value ? (funding.value?.negotiations[reviewing.value] ?? null) : null));
const isFf = computed(() => reviewing.value === "friendsAndFamily");
const draftAmount = ref<number | "">("");
const draftOther = ref<number | "">("");
const percentOf = (share: number) => Math.round(share * 1000) / 10;
const standingOther = () => {
  const t = talks.value?.offers.at(-1);
  return t ? (isFf.value ? percentOf(t.share!) : t.days!) : "";
};
function resetDraft() {
  draftAmount.value = talks.value?.offers.at(-1)?.amount ?? "";
  draftOther.value = standingOther();
}
watch(reviewing, (open) => open && resetDraft());

// Only the terms changed from the offer that stands are asked for, so a share shown rounded isn't counted as one.
const draftTerms = computed((): Partial<Terms> | null => {
  const t = talks.value?.offers.at(-1);
  if (!t || typeof draftAmount.value !== "number" || typeof draftOther.value !== "number") return null;
  const terms: Partial<Terms> = {};
  if (draftAmount.value !== t.amount) terms.amount = draftAmount.value;
  if (draftOther.value !== standingOther()) terms[isFf.value ? "share" : "days"] = isFf.value ? draftOther.value / 100 : draftOther.value;
  return Object.keys(terms).length ? terms : null;
});

const ODDS_DELAY_MS = 250;
const odds = ref<CounterOdds>();
const oddsError = ref("");
let oddsTimer: number | undefined;
let oddsSeq = 0;
watch(draftTerms, (terms) => {
  window.clearTimeout(oddsTimer);
  const seq = ++oddsSeq;
  const funder = reviewing.value;
  odds.value = undefined;
  oddsError.value = "";
  if (!terms || !funder || talks.value?.final) return;
  oddsTimer = window.setTimeout(async () => {
    try {
      const result = await api.counterOdds(game.code, game.id, funder, terms as Record<string, number>);
      if (seq === oddsSeq) odds.value = result;
    } catch (e) {
      if (seq === oddsSeq) oddsError.value = (e as Error).message;
    }
  }, ODDS_DELAY_MS);
});
onBeforeUnmount(() => window.clearTimeout(oddsTimer));

async function counter() {
  const funder = reviewing.value;
  const terms = draftTerms.value;
  if (!funder || !terms) return;
  await game.act({ type: "counterFunding", funder, terms });
  if (!game.error) resetDraft();
}

const RESULT: Record<RollResult, string> = {
  high: "a high roll: they moved most of the way",
  middle: "a middle roll: they met you halfway",
  low: "a low roll: they barely moved",
};
const percent = (n: number) => `${Math.round(n * 100)}%`;
const signed = (n: number) => (n < 0 ? `−${-n}` : String(n));
/** An offer's terms in words: friends and family's cash for their share, the grant's cash for its condition's days. */
const termsText = (t: Terms) =>
  isFf.value ? `${formatCash(t.amount!)} for ${formatShare(t.share!)}` : `${formatCash(t.amount!)}, uptime kept for ${days(t.days!)}`;

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
    <p class="muted">
      Two offers are open from the start. Each can be negotiated, then accepted or declined once, and pays everything
      up front.
    </p>
    <div class="funding-offers">
      <article class="funder" data-testid="funder-friendsAndFamily">
        <div class="row-between">
          <h3>Friends and family</h3>
          <span v-if="funding.friendsAndFamily" :class="['badge', funding.friendsAndFamily.status === 'accepted' ? 'done-badge' : 'retired-badge']">
            {{ funding.friendsAndFamily.status === "accepted" ? "Accepted" : "Declined" }}
          </span>
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
      </article>

      <article class="funder" data-testid="funder-grant">
        <div class="row-between">
          <h3>Grant</h3>
          <span v-if="grant" :class="['badge', { 'done-badge': grant.status === 'met', 'warn-badge': grant.status === 'withdrawn', 'retired-badge': grant.status === 'declined' }]" data-testid="grant-status">
            {{ GRANT_STATUS[grant.status] }}
          </span>
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
      <section v-if="talks" class="negotiation" aria-labelledby="negotiation-heading" data-testid="negotiation">
        <div class="row-between">
          <h3 id="negotiation-heading">Negotiate</h3>
          <span :class="['badge', { 'warn-badge': talks.final }]" data-testid="negotiation-stage">
            {{ talks.final ? "Final offer" : `Offer ${talks.offers.length} of 3` }}
          </span>
        </div>
        <ol v-if="talks.rounds.length" class="negotiation-rounds">
          <li v-for="(r, i) in talks.rounds" :key="i" data-testid="negotiation-round">
            You asked {{ termsText(r.counter) }}. Rolled {{ r.die }}<template v-if="r.penalty">
              − {{ r.penalty }} for asking {{ percent(r.ask) }}</template
            ><template v-if="r.bonus"> + {{ r.bonus }} bonus</template> = {{ signed(r.total) }}: <strong>{{ RESULT[r.result] }}</strong>.
            Offer {{ i + 2 }}: {{ termsText(talks.offers[i + 1]!) }}.
          </li>
        </ol>
        <p v-if="talks.final" class="muted">This is their final offer: accept it or decline it.</p>
        <form v-else-if="!game.over" class="counter-form" novalidate @submit.prevent="counter">
          <label>
            Cash (£)
            <input v-model.number="draftAmount" type="number" inputmode="numeric" min="0" step="100" data-testid="counter-amount" />
          </label>
          <label v-if="isFf">
            Their share (%)
            <input v-model.number="draftOther" type="number" inputmode="decimal" min="0.1" max="99" step="0.1" data-testid="counter-share" />
          </label>
          <label v-else>
            Condition (days)
            <input v-model.number="draftOther" type="number" inputmode="numeric" min="1" step="1" data-testid="counter-days" />
          </label>
          <div v-if="odds" class="counter-odds" data-testid="counter-odds">
            <p>
              That asks {{ percent(odds.ask) }} better terms: −{{ odds.penalty }} on a d20<template v-if="odds.bonus">,
              +{{ odds.bonus }} bonus</template>.
            </p>
            <table class="quote">
              <tbody>
                <tr v-for="r in (['high', 'middle', 'low'] as const)" :key="r" :data-testid="`odds-${r}`">
                  <th scope="row">{{ r[0]!.toUpperCase() + r.slice(1) }} roll, {{ percent(odds.chances[r]) }}</th>
                  <td>{{ termsText(odds.outcomes[r]) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else-if="oddsError" class="error" data-testid="counter-error">{{ oddsError }}</p>
          <p v-else class="muted">Ask for more cash or a {{ isFf ? "smaller share" : "shorter condition" }} to see your odds.</p>
          <button type="submit" :disabled="game.busy || !odds" data-testid="funding-counter">
            Counter ({{ talks.countersLeft }} left)
          </button>
        </form>
        <p class="muted">
          They never walk away: their latest offer stands until you accept or decline it. The more you ask, the worse
          your odds; a counter can ask up to {{ percent(talks.maxAsk) }} better terms in all.
        </p>
      </section>
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
