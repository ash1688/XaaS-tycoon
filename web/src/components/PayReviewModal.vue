<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { quarterName, TRIBUNAL_PICKS, type PayOfferTerms, type RollResult, type SchemeLevels, type TribunalPick } from "@xaas/sim";
import type { PayOfferView } from "@xaas/server/api-types";
import { api, formatCash } from "../api";
import { useGame } from "../game";
import AppModal from "./AppModal.vue";

// A pay review: before quarters 2, 3 and 4 the staff come to the student about pay, and the game holds until it's
// settled. It shows this review's inflation and the caps, the offers and counters so far, a cash rise and staff scheme
// levels to offer (sliders and toggles floored at the levels held) with what they cost, what the offer is worth to staff
// and the odds on staff's counter, and their counter to accept. Before the take it or leave it offer it warns that the
// next step is the tribunal, with its fee and odds, and once settled says what the tribunal picked. The summary and the
// cash rise sit side by side, and the schemes are a table, each one's description behind More. It opens by itself;
// closed to look around, the note in the shell opens it again, and the day still can't go on.
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

// Scheme levels to offer, starting at those held each review: they can't go lower. Kept between offers.
const levels = ref<SchemeLevels>({ pension: 0, health: 0, deathInService: 0, discount: 0, shareSave: 0 });
watch(
  () => review.value?.quarter,
  () => {
    if (review.value) levels.value = Object.fromEntries(review.value.schemes.map((s) => [s.id, s.level])) as SchemeLevels;
  },
  { immediate: true },
);
/** The levels raised above those held: what the offer adds. */
const raised = computed(() =>
  (review.value?.schemes ?? []).filter((s) => levels.value[s.id] > s.level).map((s) => ({ ...s, to: levels.value[s.id] })),
);
/** Only schemes raised are sent: the rest stay where they are. */
const offeredSchemes = computed(() => Object.fromEntries(raised.value.map((s) => [s.id, s.to])) as Partial<SchemeLevels>);
/** A scheme's worth to staff, to a hundredth of a point: 0.53%. */
const finePct = (n: number) => `${(Math.round(Math.round(n * 1e6) / 100) / 100).toFixed(2)}%`;
/** A scheme's cost model in words: "0.4% of pay a day", "£0.30 a person a day", or for share save its shares too. */
const costModel = (s: { wageShare: number; perPerson: number; sharesPerLevel: number }) =>
  [
    s.wageShare ? `${(s.wageShare * 100).toFixed(1)}% of pay a day` : "",
    s.perPerson ? `£${s.perPerson.toFixed(2)} a person a day` : "",
    s.sharesPerLevel ? `new shares worth ${percent(s.sharesPerLevel)} of your company, once` : "",
  ]
    .filter(Boolean)
    .join(" + ");
/** A share of the company to a tenth of a percent: 98.0%. */
const stake = (n: number) => `${(Math.round(n * 1000) / 10).toFixed(1)}%`;
/** An offer in words: "3.0%", or "2.0% cash + Pension top-up to 2 (worth 2.5%)". */
function offerText(terms: PayOfferTerms | undefined, value: number): string {
  if (!terms || !review.value) return pct(value);
  const added = review.value.schemes
    .filter((s) => terms.schemes[s.id] > s.level)
    .map((s) => (s.toggle ? s.name : `${s.name} to ${terms.schemes[s.id]}`));
  return added.length ? `${pct(terms.rise)} cash + ${added.join(", ")} (worth ${pct(value)} to staff)` : pct(terms.rise);
}

const PREVIEW_DELAY_MS = 250;
const preview = ref<PayOfferView>();
const previewError = ref("");
let timer: number | undefined;
let seq = 0;
watch(
  [rise, offeredSchemes, () => props.open, () => review.value?.studentOffers.length],
  ([r, schemes, open]) => {
    window.clearTimeout(timer);
    const mine = ++seq;
    preview.value = undefined;
    previewError.value = "";
    if (r === null || !open || !review.value) return;
    timer = window.setTimeout(async () => {
      try {
        const result = await api.payOffer(game.code, game.id, r, schemes);
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
  const schemes = offeredSchemes.value;
  game.track("control", { control: "pay-offer", value: [String(rise.value), ...raised.value.map((s) => `${s.id}=${s.to}`)].join(" ") });
  await game.act(raised.value.length ? { type: "offerPayRise", rise: rise.value, schemes } : { type: "offerPayRise", rise: rise.value });
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
// The new shares share save issued when the review just settled, if it was raised.
const shareSaveIssued = computed(() => {
  const last = game.company?.lastPayReview;
  return settled.value && last?.startDay === settled.value.startDay ? last.shareSaveShares : 0;
});
// The schemes held once it settled, if any.
const schemesHeld = computed(() => (game.company?.staffSchemes ?? []).filter((s) => s.level > 0));
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
          <strong>{{ quarterName(review).replace(/^q/, "Q") }} starts on day {{ review.startDay }}, and your staff want to talk about pay.</strong>
          The day can't go on until you've agreed a rise. It's paid from day {{ review.startDay }} to every team, new hires
          and agency staff included.
        </p>
        <form class="counter-form pay-form" novalidate @submit.prevent="offer">
          <div class="pay-top">
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
                  <th scope="row">Your team costs now <span class="muted">pay and staff schemes</span></th>
                  <td>{{ formatCash(review.dailyStaffCost) }} a day</td>
                </tr>
              </tbody>
            </table>
            <div class="pay-rise-box">
              <div v-if="review.canAcceptCounter" class="pay-counter" data-testid="pay-counter">
                <p>
                  <span class="badge">Staff counter</span> Your staff are asking for <strong>{{ pct(review.staffFigure) }}</strong>
                  in cash. Agree it now, as a cash rise with no schemes, or make another offer.
                </p>
                <button type="button" :disabled="game.busy" data-testid="pay-accept-counter" @click="acceptCounter">
                  Agree {{ pct(review.staffFigure) }}
                </button>
              </div>
              <p v-else class="muted">Staff open at their ask of {{ pct(review.staffFigure) }}. Make the first offer.</p>
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
              <p class="muted">A rise below inflation is a pay cut in real terms: your staff's money buys less than it did.</p>
            </div>
          </div>
          <p v-if="!review.headOfPeople" class="muted" data-testid="pay-dealing-directly">
            You're dealing with staff directly: with no head of people, they're stricter on the roll ({{ signed(review.rollBonus) }}
            on each counter) and want cash, valuing staff schemes at only {{ percent(review.schemeValuation) }} of their usual worth.
          </p>

          <ol v-if="review.rounds.length" class="negotiation-rounds" data-testid="pay-rounds">
            <li v-for="(r, i) in review.rounds" :key="i" data-testid="pay-round">
              You offered {{ offerText(review.offerTerms[i], review.studentOffers[i]!) }}. Rolled {{ r.die }}<template v-if="r.penalty">
                − {{ r.penalty }} for asking them down {{ percent(r.ask) }}</template
              ><template v-if="r.bonus > 0"> + {{ r.bonus }} bonus</template
              ><template v-else-if="r.bonus < 0"> − {{ -r.bonus }} for dealing with staff directly</template> = {{ signed(r.total) }}:
              <strong>{{ RESULT[r.result] }}: {{ moveText(r.move, review.staffFigures[i]!, review.staffFigures[i + 1]!) }}</strong>. They now ask {{ pct(review.staffFigures[i + 1]!) }}.
            </li>
          </ol>

          <p v-if="review.final" class="warn-note" role="status" data-testid="pay-final-warning">
            <span class="badge warn-badge">Take it or leave it: next is a tribunal</span> This is your take it or leave it
            offer. If staff don't accept it, the review goes to a <strong>tribunal</strong>, which charges a
            <strong>{{ formatCash(review.tribunalFee) }}</strong> fee and sets the rise: your offer, their
            {{ pct(review.staffFigure) }} or the middle. It favours whichever is closest to a fair rise for how your company is
            doing, so a lowball offer is likely to lose. Your schemes apply if it picks your offer or the middle, but not theirs.
          </p>

          <fieldset class="pay-schemes" data-testid="pay-schemes">
            <legend>Staff schemes</legend>
            <p class="muted">
              Benefits instead of cash. Each costs you every day from now on, for every permanent member of staff, and can't be
              taken away once given.
              <template v-if="review.headOfPeople">
                Your head of people has staff value schemes at {{ percent(review.schemeValuation) }} of their usual worth.
              </template>
              <template v-else>
                Without a head of people, staff value schemes at only {{ percent(review.schemeValuation) }} of their usual worth.
              </template>
              The worth below allows for that.
            </p>
            <table class="pay-scheme-table">
              <thead>
                <tr>
                  <th scope="col">Scheme</th>
                  <th scope="col">Level</th>
                  <th scope="col">Cost to you</th>
                  <th scope="col">Worth to staff</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="s in review.schemes" :key="s.id" class="pay-scheme" :data-testid="`pay-scheme-${s.id}`">
                  <th scope="row">
                    <strong>{{ s.name }}</strong>
                    <details class="how-it-works scheme-more">
                      <summary>More</summary>
                      {{ s.blurb }}
                    </details>
                  </th>
                  <td data-label="Level">
                    <label v-if="s.toggle" class="scheme-level">
                      <input
                        type="checkbox"
                        :checked="levels[s.id] > 0"
                        :disabled="s.level > 0"
                        :aria-label="s.name"
                        :data-testid="`pay-scheme-${s.id}-input`"
                        @change="levels[s.id] = ($event.target as HTMLInputElement).checked ? 1 : 0"
                      />
                      <span>{{ levels[s.id] > 0 ? "On" : "Off" }}<template v-if="s.level > 0"> (held)</template></span>
                    </label>
                    <label v-else class="scheme-level">
                      <input
                        v-model.number="levels[s.id]"
                        type="range"
                        :min="s.level"
                        :max="s.maxLevel"
                        step="1"
                        :aria-label="`${s.name} level`"
                        :data-testid="`pay-scheme-${s.id}-input`"
                      />
                      <span>{{ levels[s.id] }} of {{ s.maxLevel }}<template v-if="s.level > 0"> (held {{ s.level }})</template></span>
                    </label>
                  </td>
                  <td data-label="Cost to you">
                    {{ costModel(s) }}{{ s.toggle ? "" : ", each level" }}
                    <small v-if="s.level > 0" class="muted">Now {{ formatCash(s.costPerDay) }} a day</small>
                  </td>
                  <td data-label="Worth to staff">
                    {{ finePct(s.staffValue * review.schemeValuation) }}{{ s.toggle ? "" : " each level" }}
                  </td>
                </tr>
              </tbody>
            </table>
          </fieldset>
          <div v-if="preview" class="counter-odds" data-testid="pay-preview">
            <p v-if="raised.length" data-testid="pay-worth">
              Worth <strong>{{ pct(preview.value) }}</strong> to your staff: {{ pct(preview.rise) }} cash plus
              {{ finePct(preview.schemeValue) }} for the schemes, as they value them.
            </p>
            <table v-if="raised.length" class="quote" data-testid="pay-scheme-costs">
              <tbody>
                <tr v-for="s in preview.schemeCosts.filter((c) => c.level > c.held)" :key="s.id" :data-testid="`pay-scheme-cost-${s.id}`">
                  <th scope="row">{{ s.name }} <span class="muted">worth {{ finePct(s.value) }} to staff</span></th>
                  <td>{{ formatCash(s.costPerDay) }} a day, for good</td>
                </tr>
              </tbody>
            </table>
            <p v-if="preview.dilution" class="warn-note" data-testid="pay-dilution">
              <span class="badge warn-badge">Dilution</span> Share save issues
              <strong>{{ preview.dilution.newShares.toLocaleString("en-GB") }} new shares</strong> to the staff share scheme,
              which would own {{ stake(preview.dilution.schemeShareAfter) }} of your company. You'd own
              <strong>{{ stake(preview.dilution.yourShareAfter) }}</strong>, down from {{ stake(preview.dilution.yourShareBefore) }}:
              it's paid for in ownership, not cash.
            </p>
            <p data-testid="pay-cost">
              That adds <strong>{{ formatCash(preview.extraPerDay) }} a day</strong> to your team's cost:
              <strong>{{ formatCash(preview.extraPerYear) }} a year</strong> at today's team<template v-if="raised.length">, schemes included</template>.
              <template v-if="preview.realTerms < 0">The cash is {{ pct(-preview.realTerms) }} below inflation: a pay cut in real terms.</template>
              <template v-else-if="preview.realTerms > 0">The cash is {{ pct(preview.realTerms) }} above inflation.</template>
              <template v-else>The cash matches inflation: pay holds its value.</template>
            </p>
            <p v-if="preview.meetsAsk" data-testid="pay-meets-ask">That's what your staff are asking: they'll take it.</p>
            <template v-else-if="preview.odds">
              <p>
                Staff accept an offer close to a fair rise for how your company is doing. Short of it, they counter, and a d20
                decides how far they come down: −{{ preview.odds.penalty }} for asking them down {{ percent(preview.odds.ask) }}<template
                  v-if="preview.odds.bonus > 0"
                >, +{{ preview.odds.bonus }} bonus</template
                ><template v-else-if="preview.odds.bonus < 0">, −{{ -preview.odds.bonus }} for dealing with staff directly</template>.
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
                    <td>
                      a {{ pct(preview.tribunal.cash[p]) }} rise<template v-if="raised.length">{{ p === "staff" ? ", no schemes" : " + your schemes" }}</template>
                    </td>
                  </tr>
                </tbody>
              </table>
            </template>
          </div>
          <p v-else-if="previewError" class="error" data-testid="pay-preview-error">{{ previewError }}</p>
          <p v-else class="muted">Type a rise from {{ pct(review.minOffer) }} to {{ pct(review.maxAsk) }} to see what it costs.</p>
          <button type="submit" :disabled="game.busy || !preview" data-testid="pay-offer">
            Offer {{ rise === null ? "" : pct(rise) }}<template v-if="raised.length"> + {{ raised.length }} {{ raised.length === 1 ? "scheme" : "schemes" }}</template>
            ({{ review.offersLeft }} {{ review.offersLeft === 1 ? "offer" : "offers" }} left)
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
        <p v-if="schemesHeld.length" data-testid="pay-schemes-held">
          Staff schemes from day {{ settled.startDay }}:
          {{ schemesHeld.map((s) => `${s.name}${s.toggle ? "" : ` ${s.level}`} (${formatCash(s.costPerDay)} a day)`).join(", ") }}.
        </p>
        <p v-if="shareSaveIssued" data-testid="pay-share-save-issued">
          Share save issued {{ shareSaveIssued.toLocaleString("en-GB") }} new shares to the staff share scheme: see who owns
          what on the Finance page's cap table.
        </p>
        <button data-testid="pay-done" @click="emit('close')">Play on</button>
      </template>
    </div>
  </AppModal>
</template>
