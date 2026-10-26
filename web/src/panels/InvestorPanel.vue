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
// later. Accepting sets the valuation to the angel's figure and closes friends and family and grants. Then venture
// capital, Series A to D: three VCs approach for each round, the student picks one to negotiate with (closing the other
// two), and accepting sets the valuation to theirs. A 180-day game has two rounds, Series A and B, each merging two and
// paying its cash in two tranches. Series A approaching, taken or not, opens the last C-suite roles the IPO needs.
const game = useGame();
const investors = computed(() => game.company?.investors ?? null);
const offer = computed(() => investors.value?.offer ?? null);
const talks = computed(() => investors.value?.negotiation ?? null);
const angel = computed(() => investors.value?.angel ?? null);
const lastDeclined = computed(() => investors.value?.declined.at(-1) ?? null);
/** How far along each part of the angel's target is, 0–100. */
const percentOf = (now: number, target: number) => (target > 0 ? Math.max(0, Math.min(100, Math.round((100 * now) / target))) : 100);
const incomePercent = computed(() => (angel.value ? percentOf(angel.value.dailyRevenue, angel.value.target.dailyRevenue) : 0));
const usersPercent = computed(() => (angel.value ? percentOf(angel.value.netUsers, angel.value.target.netUsers) : 0));
/** How long the offer stands: it lapses unanswered after its last day, as if declined. */
const standsText = (daysLeft: number, lastDay: number) =>
  `Answer by day ${lastDay} (${daysLeft === 1 ? "today is the last day" : `${days(daysLeft)} left`}): unanswered, it lapses, which counts as declining it.`;
const TARGET_STATUS = { running: "Target running", met: "Target met", missed: "Target missed" } as const;

const vc = computed(() => investors.value?.vc ?? null);
const vcApproach = computed(() => vc.value?.approach ?? null);
const vcPicked = computed(() => vcApproach.value?.offers.find((o) => o.status === "picked") ?? null);
const vcTalks = computed(() => vc.value?.negotiation ?? null);
const vcLastDeclined = computed(() => vc.value?.declined.at(-1) ?? null);
const roundName = (round: string) => vc.value?.rounds.find((r) => r.round === round)?.name ?? round;

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

// The picked VC's offer, in a modal like the angel's.
const reviewingVc = ref(false);
let vcAccepted = false;
watch(reviewingVc, (open, was) => {
  if (open || !was) return;
  game.track("quote", { kind: "vc", confirmed: vcAccepted });
  vcAccepted = false;
});
watch(vcPicked, (o) => {
  if (!o) reviewingVc.value = false;
});
async function pick(investor: string) {
  game.error = "";
  await game.act({ type: "pickInvestor", investor });
  if (!game.error) reviewingVc.value = true;
}
async function declineVcs() {
  game.error = "";
  await game.act({ type: "declineInvestor" });
}
async function answerVc(type: "acceptInvestor" | "declineInvestor") {
  await game.act({ type });
  if (game.error) return;
  vcAccepted = type === "acceptInvestor";
  reviewingVc.value = false;
}

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
        <p class="muted" data-testid="angel-days-left">{{ standsText(offer.daysLeft, offer.lastDay) }}</p>
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
            Their target, both at once by day {{ angel.target.byDay }} ({{ days(angel.daysLeft) }} to go):
          </p>
          <p data-testid="angel-target-income">
            Income of {{ formatCash(angel.target.dailyRevenue) }} a day, averaged over {{ days(angel.target.days) }}: you're
            at {{ formatCash(angel.dailyRevenue) }}.
          </p>
          <div
            class="loan-bar"
            role="progressbar"
            :aria-valuenow="incomePercent"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-label="`${incomePercent}% of the way to the angel's income target`"
          >
            <span :style="{ width: `${incomePercent}%` }"></span>
          </div>
          <p data-testid="angel-target-users">
            Users since you accepted, free and paying: {{ angel.usersGained.toLocaleString("en-GB") }} gained,
            {{ angel.usersLost.toLocaleString("en-GB") }} lost, so
            <strong>{{ angel.netUsers.toLocaleString("en-GB") }} net of {{ angel.target.netUsers.toLocaleString("en-GB") }}</strong>.
          </p>
          <div
            class="loan-bar"
            role="progressbar"
            :aria-valuenow="usersPercent"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-label="`${usersPercent}% of the way to the angel's users target`"
          >
            <span :style="{ width: `${usersPercent}%` }"></span>
          </div>
          <p class="muted">Miss either and they take extra shares, diluting you.</p>
        </template>
        <p v-else-if="angel.status === 'met'">Target met on day {{ angel.settledDay }}.</p>
        <p v-else class="error" data-testid="angel-missed">
          Target missed on day {{ angel.settledDay }}: they took {{ angel.extraShares.toLocaleString("en-GB") }} extra
          shares.
        </p>
      </template>
      <p v-else-if="investors.anotherComing && lastDeclined" class="muted" data-testid="angel-coming">
        <template v-if="lastDeclined.lapsed">
          {{ lastDeclined.investor }}'s offer lapsed unanswered on day {{ lastDeclined.day }}, which counts as declining it.
        </template>
        <template v-else>You declined {{ lastDeclined.investor }} on day {{ lastDeclined.day }}.</template>
        Another angel will approach in a few days, on less generous terms.
      </p>
      <p v-else class="muted">
        Investors come to you: an angel approaches once your company is doing well. You'll get a notification.
      </p>
    </article>

    <article v-if="vc" class="funder" data-testid="vc">
      <div class="row-between">
        <h3>Venture capital</h3>
        <span v-if="vcApproach" class="badge warn-badge">{{ vcApproach.name }}: three VCs want to invest</span>
      </div>
      <ul class="vc-rounds" data-testid="vc-rounds">
        <li v-for="r in vc.rounds" :key="r.round" :data-testid="`vc-round-${r.round}`">
          <strong>{{ r.name }}</strong>
          <template v-if="r.firstApproachDay === null"> not yet</template>
          <template v-else> approached day {{ r.firstApproachDay }} ✓</template>
          <template v-if="r.deal">: {{ r.deal.investor }} put in {{ formatCash(r.deal.amount) }} for {{ formatShare(r.deal.share) }}</template>
          <template v-if="r.deal?.tranche">
            <span v-if="r.deal.tranche.paidDay === null" class="muted" data-testid="vc-tranche">
              ({{ formatCash(r.deal.tranche.amount) }} of it still to come, once you hit their growth target)
            </span>
            <span v-else class="muted" data-testid="vc-tranche">
              (the second tranche, {{ formatCash(r.deal.tranche.amount) }}, paid day {{ r.deal.tranche.paidDay }})
            </span>
          </template>
        </li>
      </ul>
      <template v-if="vcApproach">
        <p v-if="vcPicked" data-testid="vc-picked">
          You're negotiating with <strong>{{ vcPicked.investor }}</strong> alone: the other two have closed.
        </p>
        <p v-else>Pick one VC to negotiate with. Picking one closes the other two.</p>
        <p class="muted" data-testid="vc-days-left">{{ standsText(vcApproach.daysLeft, vcApproach.lastDay) }}</p>
        <div class="vc-offers">
          <div
            v-for="o in vcApproach.offers"
            :key="o.investor"
            :class="['vc-offer', { closed: o.status === 'closed' }]"
            :data-testid="`vc-offer-${o.lean}`"
            data-vc-offer
          >
            <div class="row-between">
              <strong>{{ o.investor }}</strong>
              <span class="badge">{{ o.leanLabel }}</span>
            </div>
            <p v-if="o.lead" class="muted">Your lead VC, back from the last round.</p>
            <p>
              {{ formatCash(o.amount) }} for {{ formatShare(o.theirShare) }}, valuing the company at
              {{ formatCash(o.valuation) }}. You'd own {{ formatShare(o.yourShareAfter) }}.
            </p>
            <p v-if="o.secondTranche !== null" class="muted" data-testid="vc-offer-tranches">
              {{ formatCash(o.amount - o.secondTranche) }} on signing, {{ formatCash(o.secondTranche) }} once you hit
              their growth target.
            </p>
            <button v-if="o.status === 'open' && !game.over" :disabled="game.busy" data-testid="vc-pick" @click="pick(o.investor)">
              Negotiate with {{ o.investor }}
            </button>
            <button v-else-if="o.status === 'picked' && !game.over" data-testid="vc-review" @click="reviewingVc = true">
              Review offer
            </button>
            <p v-else-if="o.status === 'closed'" class="muted">Closed</p>
          </div>
        </div>
        <button v-if="!vcPicked && !game.over" class="ghost" :disabled="game.busy" data-testid="vc-decline-all" @click="declineVcs">
          Decline all three
        </button>
      </template>
      <p v-else-if="vc.anotherComing && vcLastDeclined" class="muted" data-testid="vc-coming">
        {{ vcLastDeclined.lapsed ? "The VCs' offers lapsed unanswered" : "You turned the VCs down" }} on day
        {{ vcLastDeclined.day }}. Three new VCs will approach for {{ roundName(vcLastDeclined.round) }} in a few days, on
        less generous terms.
      </p>
      <p v-else-if="vc.lead" class="muted" data-testid="vc-lead">
        {{ vc.lead.investor }} is your lead VC: they'll be back for the next round alongside two new VCs.
      </p>
      <p v-else class="muted">
        Venture capitalists come to growing companies after the angel:
        {{ vc.rounds.length === 2 ? "Series A, then Series B (a 180-day game has two rounds, each the size of two)" : "Series A, then B, C and D" }}. You don't need
        their money to float, but Series A approaching opens the last C-suite roles, whether or not you take it.
      </p>
    </article>

    <AppModal :open="reviewingVc && vcPicked !== null" :title="`${vcApproach?.name ?? 'VC'} offer`" @close="reviewingVc = false">
      <p v-if="game.error" class="error" role="alert">{{ game.error }}</p>
      <template v-if="vcPicked && vcApproach">
        <table class="quote" data-testid="vc-preview">
          <tbody>
            <tr>
              <th scope="row">From</th>
              <td>{{ vcPicked.investor }} ({{ vcPicked.leanLabel.toLowerCase() }})</td>
            </tr>
            <tr>
              <th scope="row">They put in</th>
              <td v-if="vcPicked.secondTranche === null">{{ formatCash(vcPicked.amount) }}, now, all of it</td>
              <td v-else class="words" data-testid="vc-tranches">
                {{ formatCash(vcPicked.amount) }} in two tranches: {{ formatCash(vcPicked.amount - vcPicked.secondTranche) }}
                now, and {{ formatCash(vcPicked.secondTranche) }} once you hit their growth target
              </td>
            </tr>
            <tr>
              <th scope="row">They value the company at</th>
              <td class="words" data-testid="vc-valuation">
                {{ formatCash(vcPicked.preMoney) }} before their cash, {{ formatCash(vcPicked.valuation) }} with it
                (today's valuation: {{ formatCash(vcApproach.formulaValuation) }})
              </td>
            </tr>
            <tr>
              <th scope="row">New shares for them</th>
              <td>
                {{ vcPicked.newShares.toLocaleString("en-GB") }} at {{ formatSharePrice(vcPicked.sharePrice) }}, making
                {{ vcPicked.sharesAfter.toLocaleString("en-GB") }} in issue
              </td>
            </tr>
            <tr>
              <th scope="row">They'll own</th>
              <td data-testid="vc-their-share">{{ formatShare(vcPicked.theirShare) }}</td>
            </tr>
            <tr>
              <th scope="row">You'll own</th>
              <td>{{ formatShare(vcApproach.yourShareBefore) }} → {{ formatShare(vcPicked.yourShareAfter) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="muted">{{ standsText(vcApproach.daysLeft, vcApproach.lastDay) }}</p>
        <ul class="muted" data-testid="vc-effects">
          <li v-for="e in vcApproach.effects" :key="e">{{ e }}</li>
        </ul>
        <NegotiationBox
          v-if="vcTalks"
          :talks="vcTalks"
          :fields="FIELDS"
          :terms-text="termsText"
          better="a smaller share"
          :odds="oddsFor"
          :counter="counter"
        />
      </template>
      <div class="confirm-buttons">
        <button :disabled="game.busy" data-testid="vc-accept" @click="answerVc('acceptInvestor')">
          Accept {{ formatCash(vcPicked?.amount ?? 0) }}
        </button>
        <button class="ghost" :disabled="game.busy" data-testid="vc-decline" @click="answerVc('declineInvestor')">
          Decline
        </button>
        <button class="ghost" :disabled="game.busy" @click="reviewingVc = false">Not now</button>
      </div>
    </AppModal>

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
        <p class="muted" data-testid="angel-modal-days-left">{{ standsText(offer.daysLeft, offer.lastDay) }}</p>
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

<style scoped>
.vc-rounds {
  list-style: none;
  padding: 0;
  margin: 0.5rem 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1rem;
}
.vc-offers {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 0.75rem;
  margin: 0.75rem 0;
}
.vc-offer {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.75rem;
}
.vc-offer.closed {
  opacity: 0.55;
}
</style>
