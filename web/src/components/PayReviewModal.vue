<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { TRIBUNAL_PICKS, type RollResult, type TribunalPick } from "@xaas/sim";
import type { PayOfferView } from "@xaas/server/api-types";
import { api, formatCash } from "../api";
import { useGame } from "../game";
import AppModal from "./AppModal.vue";

// A pay review: before quarters 2, 3 and 4 the staff come to the student about pay, and the game holds until it's
// settled. It shows this review's inflation and the caps, the offers and counters so far, a cash rise to offer with
// what it costs and the odds on staff's counter, and their counter to accept. Before the final offer it warns that the
// next step is the tribunal, with its fee and odds, and once settled says what the tribunal picked. It opens by itself; closed to look
// around, the note in the shell opens it again, and the day still can't go on.
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const game = useGame();
const review = computed(() => game.company?.payReview ?? null);

/** A rise as a percent to a tenth: 3.4%. */
const pct = (n: number) => `${(Math.round(n * 1000) / 10).toFixed(1)}%`;
/** A share typed as a percent, 0.034 as 3.4. */
const typed = (n: number) => Math.round(n * 1000) / 10;

// The draft starts at inflation, a real-terms freeze, and again after each counter.
const draft = ref<number | "">("");
watch(
  () => [review.value?.quarter, review.value?.studentOffers.length],
  () => (draft.value = review.value ? typed(review.value.inflation) : ""),
  { immediate: true },
);
const rise = computed(() => (typeof draft.value === "number" ? Math.round(draft.value * 10) / 1000 : null));

const PREVIEW_DELAY_MS = 250;
const preview = ref<PayOfferView>();
const previewError = ref("");
let timer: number | undefined;
let seq = 0;
watch(
  [rise, () => props.open, () => review.value?.studentOffers.length],
  ([r, open]) => {
    window.clearTimeout(timer);
    const mine = ++seq;
    preview.value = undefined;
    previewError.value = "";
    if (r === null || !open || !review.value) return;
    timer = window.setTimeout(async () => {
      try {
        const result = await api.payOffer(game.code, game.id, r);
        if (mine === seq) preview.value = result;
      } catch (e) {
        if (mine === seq) previewError.value = (e as Error).message;
      }
    }, PREVIEW_DELAY_MS);
  },
  { immediate: true },
);
onBeforeUnmount(() => window.clearTimeout(timer));

async function offer() {
  if (rise.value === null) return;
  game.track("control", { control: "pay-offer", value: String(rise.value) });
  await game.act({ type: "offerPayRise", rise: rise.value });
}

async function acceptCounter() {
  game.track("control", { control: "pay-accept-counter", value: String(review.value?.staffFigure ?? "") });
  await game.act({ type: "acceptPayCounter" });
}

// Once the review settles, what was agreed, until the modal is closed: the rise is how far pay moved.
const settled = ref<{ rise: number; startDay: number } | null>(null);
let multiplierBefore = 1;
watch(
  review,
  (now, before) => {
    if (now) {
      settled.value = null;
      multiplierBefore = game.company?.payMultiplier ?? 1;
    } else if (before) {
      settled.value = { rise: (game.company?.payMultiplier ?? 1) / multiplierBefore - 1, startDay: before.startDay };
    }
  },
  { immediate: true },
);

// The review just settled, if a tribunal settled it: what it picked and its fee.
const tribunal = computed(() => {
  const last = game.company?.lastPayReview;
  return settled.value && last?.startDay === settled.value.startDay ? last.tribunal : null;
});
const PICK: Record<TribunalPick, string> = { student: "Your offer", middle: "The middle", staff: "Staff's figure" };

const RESULT: Record<RollResult, string> = { high: "a high roll", middle: "a middle roll", low: "a low roll" };
/**
 * How far staff came down on a roll: most of the way, halfway, barely, or (a low roll) they asked for more, or held at
 * their ask if they were there already.
 */
const moveText = (move: number, from: number, to: number) =>
  move < 0 ? (to > from ? "they dug in and asked for more" : "they dug in and held at their ask") : move >= 0.75 ? "they came down most of the way" : move >= 0.4 ? "they met you halfway" : "they barely moved";
const signed = (n: number) => (n < 0 ? `−${-n}` : String(n));
const percent = (n: number) => `${Math.round(n * 100)}%`;
</script>

<template>
  <AppModal :open="open && (review !== null || settled !== null)" title="Pay review" @close="emit('close')">
    <div class="pay-review" data-testid="pay-review">
      <p v-if="game.error" class="error" role="alert">{{ game.error }}</p>
      <template v-if="review">
        <p>
          <strong>Quarter {{ review.quarter }} starts on day {{ review.startDay }}, and your staff want to talk about pay.</strong>
          The day can't go on until you've agreed a rise. It's paid from day {{ review.startDay }} to every team, new hires
          and agency staff included.
        </p>
        <table class="quote" data-testid="pay-review-terms">
          <tbody>
            <tr>
              <th scope="row">Inflation this review</th>
              <td data-testid="pay-inflation">{{ pct(review.inflation) }}</td>
            </tr>
            <tr>
              <th scope="row">Least you can offer <span class="muted">inflation less a point</span></th>
              <td data-testid="pay-min-offer">{{ pct(review.minOffer) }}</td>
            </tr>
            <tr>
              <th scope="row">Most staff ask <span class="muted">inflation plus four points</span></th>
              <td data-testid="pay-max-ask">{{ pct(review.maxAsk) }}</td>
            </tr>
            <tr>
              <th scope="row">Your team costs now</th>
              <td>{{ formatCash(review.dailyStaffCost) }} a day</td>
            </tr>
          </tbody>
        </table>
        <p class="muted">A rise below inflation is a pay cut in real terms: your staff's money buys less than it did.</p>

        <ol v-if="review.rounds.length" class="negotiation-rounds" data-testid="pay-rounds">
          <li v-for="(r, i) in review.rounds" :key="i" data-testid="pay-round">
            You offered {{ pct(review.studentOffers[i]!) }}. Rolled {{ r.die }}<template v-if="r.penalty">
              − {{ r.penalty }} for asking them down {{ percent(r.ask) }}</template
            ><template v-if="r.bonus"> + {{ r.bonus }} bonus</template> = {{ signed(r.total) }}:
            <strong>{{ RESULT[r.result] }}: {{ moveText(r.move, review.staffFigures[i]!, review.staffFigures[i + 1]!) }}</strong>. They now ask {{ pct(review.staffFigures[i + 1]!) }}.
          </li>
        </ol>

        <div v-if="review.canAcceptCounter" class="pay-counter" data-testid="pay-counter">
          <p>
            <span class="badge">Staff counter</span> Your staff are asking for <strong>{{ pct(review.staffFigure) }}</strong>.
            You can agree it now, or make another offer.
          </p>
          <button :disabled="game.busy" data-testid="pay-accept-counter" @click="acceptCounter">
            Agree {{ pct(review.staffFigure) }}
          </button>
        </div>
        <p v-else class="muted">Staff open at their ask of {{ pct(review.staffFigure) }}. Make the first offer.</p>

        <p v-if="review.final" class="warn-note" role="status" data-testid="pay-final-warning">
          <span class="badge warn-badge">Final offer: next is a tribunal</span> This is your last offer. If staff don't accept
          it, the review goes to a <strong>tribunal</strong>, which charges a <strong>{{ formatCash(review.tribunalFee) }}</strong>
          fee and sets the rise: your offer, their {{ pct(review.staffFigure) }} or the middle. It favours whichever is closest
          to a fair rise for how your company is doing, so a lowball offer is likely to lose.
        </p>

        <form class="counter-form" novalidate @submit.prevent="offer">
          <label>
            Cash rise (%)
            <input
              v-model.number="draft"
              type="number"
              inputmode="decimal"
              :min="typed(review.minOffer)"
              :max="typed(review.maxAsk)"
              step="0.1"
              data-testid="pay-rise"
            />
          </label>
          <div v-if="preview" class="counter-odds" data-testid="pay-preview">
            <p data-testid="pay-cost">
              That adds <strong>{{ formatCash(preview.extraPerDay) }} a day</strong> to your team's pay:
              <strong>{{ formatCash(preview.extraPerYear) }} a year</strong> at today's team.
              <template v-if="preview.realTerms < 0">It's {{ pct(-preview.realTerms) }} below inflation: a pay cut in real terms.</template>
              <template v-else-if="preview.realTerms > 0">It's {{ pct(preview.realTerms) }} above inflation.</template>
              <template v-else>It matches inflation: pay holds its value.</template>
            </p>
            <p v-if="preview.meetsAsk" data-testid="pay-meets-ask">That's what your staff are asking: they'll take it.</p>
            <template v-else-if="preview.odds">
              <p>
                Staff accept an offer close to a fair rise for how your company is doing. Short of it, they counter, and a d20
                decides how far they come down: −{{ preview.odds.penalty }} for asking them down {{ percent(preview.odds.ask) }}<template
                  v-if="preview.odds.bonus"
                >, +{{ preview.odds.bonus }} bonus</template>.
              </p>
              <table class="quote" data-testid="pay-odds">
                <tbody>
                  <tr v-for="r in (['high', 'middle', 'low'] as const)" :key="r" :data-testid="`pay-odds-${r}`">
                    <th scope="row">{{ r[0]!.toUpperCase() + r.slice(1) }} roll, {{ percent(preview.odds.chances[r]) }}</th>
                    <td>they ask {{ pct(preview.odds.outcomes[r].rise!) }}</td>
                  </tr>
                </tbody>
              </table>
            </template>
            <template v-else-if="preview.tribunal">
              <p>
                Staff accept an offer close to a fair rise. If they don't, the tribunal sits for
                {{ formatCash(preview.tribunal.fee) }} and picks:
              </p>
              <table class="quote" data-testid="pay-tribunal-odds">
                <tbody>
                  <tr v-for="p in TRIBUNAL_PICKS" :key="p" :data-testid="`pay-tribunal-${p}`">
                    <th scope="row">{{ PICK[p] }}, {{ percent(preview.tribunal.chances[p]) }}</th>
                    <td>a {{ pct(preview.tribunal.rises[p]) }} rise</td>
                  </tr>
                </tbody>
              </table>
            </template>
          </div>
          <p v-else-if="previewError" class="error" data-testid="pay-preview-error">{{ previewError }}</p>
          <p v-else class="muted">Type a rise from {{ pct(review.minOffer) }} to {{ pct(review.maxAsk) }} to see what it costs.</p>
          <button type="submit" :disabled="game.busy || !preview" data-testid="pay-offer">
            Offer {{ rise === null ? "" : pct(rise) }} ({{ review.offersLeft }} {{ review.offersLeft === 1 ? "offer" : "offers" }} left)
          </button>
        </form>
      </template>
      <template v-else-if="settled">
        <p v-if="tribunal" class="warn-note" data-testid="pay-tribunal-result">
          <span class="badge warn-badge">Tribunal</span> With no deal, the tribunal sat and picked
          <strong>{{ PICK[tribunal.pick].toLowerCase() }}</strong>. Its fee of {{ formatCash(tribunal.fee) }} came out of your cash.
        </p>
        <p data-testid="pay-settled">
          <strong>Pay review settled on a {{ pct(settled.rise) }} rise.</strong> Every team is paid it from day
          {{ settled.startDay }}: pay is now {{ (game.company?.payMultiplier ?? 1).toFixed(3) }}× the starting day rates.
        </p>
        <button data-testid="pay-done" @click="emit('close')">Play on</button>
      </template>
    </div>
  </AppModal>
</template>
