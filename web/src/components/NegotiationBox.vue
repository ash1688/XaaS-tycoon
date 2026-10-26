<script lang="ts">
/** One term the student can counter on: cash in pounds, a share typed as a percent, or a whole number of days. */
export interface CounterField {
  key: string;
  /** "Cash (£)", "Their share (%)". */
  label: string;
  /** Typed as a percent of a 0–1 share. */
  percent?: boolean;
  step: number;
  min?: number;
  max?: number;
  testid: string;
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { CounterOdds, NegotiationView, RollResult, Terms } from "@xaas/sim";
import { useGame } from "../game";

// Negotiating any offer: its offers and rolls so far, and a counter being drafted with its live odds. The offer it's
// for (friends and family, the grant, an investor) says what its terms are, how they read, and how to fetch the odds
// and send the counter, or auto-negotiate from it: the same counter repeated on every offer to the final one, with the
// same rolls, shown as a short transcript. It never accepts: the offer's own Accept and Decline answer it.
const props = defineProps<{
  talks: NegotiationView;
  fields: CounterField[];
  termsText: (t: Terms) => string;
  /** "a smaller share", "a shorter condition": what else a better counter asks for, for the hint. */
  better: string;
  odds: (terms: Partial<Terms>) => Promise<CounterOdds>;
  counter: (terms: Partial<Terms>) => Promise<void>;
  auto: (terms: Partial<Terms>) => Promise<void>;
}>();

const game = useGame();
const drafts = ref<Record<string, number | "">>({});
const percentOf = (share: number) => Math.round(share * 1000) / 10;
const standing = () => props.talks.offers.at(-1)!;
const shown = (f: CounterField) => (f.percent ? percentOf(standing()[f.key]!) : standing()[f.key]!);
function resetDraft() {
  drafts.value = Object.fromEntries(props.fields.map((f) => [f.key, shown(f)]));
}
watch(() => props.talks.offers.length, resetDraft, { immediate: true });

// Only the terms changed from the offer that stands are asked for, so a share shown rounded isn't counted as one.
const draftTerms = computed((): Partial<Terms> | null => {
  const terms: Partial<Terms> = {};
  for (const f of props.fields) {
    const value = drafts.value[f.key];
    if (typeof value !== "number") return null;
    if (value !== shown(f)) terms[f.key] = f.percent ? value / 100 : value;
  }
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
  odds.value = undefined;
  oddsError.value = "";
  if (!terms || props.talks.final) return;
  oddsTimer = window.setTimeout(async () => {
    try {
      const result = await props.odds(terms);
      if (seq === oddsSeq) odds.value = result;
    } catch (e) {
      if (seq === oddsSeq) oddsError.value = (e as Error).message;
    }
  }, ODDS_DELAY_MS);
});
onBeforeUnmount(() => window.clearTimeout(oddsTimer));

async function send() {
  const terms = draftTerms.value;
  if (!terms) return;
  await props.counter(terms);
  if (!game.error) resetDraft();
}

async function autoNegotiate() {
  const terms = draftTerms.value;
  if (!terms) return;
  await props.auto(terms);
  if (!game.error) resetDraft();
}

const RESULT: Record<RollResult, string> = {
  high: "a high roll",
  middle: "a middle roll",
  low: "a low roll",
};
/** What the roll did to the offer: towards the counter, or (a low roll, by default) away from it. */
const moveText = (move: number) =>
  move < 0 ? "they dug in: their offer got worse" : move >= 0.75 ? "they moved most of the way" : move >= 0.4 ? "they met you halfway" : "they barely moved";
const percent = (n: number) => `${Math.round(n * 100)}%`;
/** The rounds Auto-negotiate played, each with the offer it brought: "Offer 2: they met you halfway". */
const autoRounds = computed(() =>
  props.talks.rounds.flatMap((r, i) => (r.auto ? [{ offer: i + 2, text: moveText(r.move), terms: props.talks.offers[i + 1]! }] : [])),
);
const signed = (n: number) => (n < 0 ? `−${-n}` : String(n));
</script>

<template>
  <section class="negotiation" aria-labelledby="negotiation-heading" data-testid="negotiation">
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
        ><template v-if="r.bonus"> + {{ r.bonus }} bonus</template> = {{ signed(r.total) }}: <strong>{{ RESULT[r.result] }}: {{ moveText(r.move) }}</strong>.
        Offer {{ i + 2 }}: {{ termsText(talks.offers[i + 1]!) }}.
      </li>
    </ol>
    <p v-if="autoRounds.length" class="auto-transcript" role="status" data-testid="auto-transcript">
      <strong>Auto-negotiated.</strong>
      <span v-for="a in autoRounds" :key="a.offer" data-testid="auto-round">
        Offer {{ a.offer }}: {{ a.text }} ({{ termsText(a.terms) }}).
      </span>
    </p>
    <p v-if="talks.final" class="muted">This is their final offer: accept it or decline it.</p>
    <form v-else-if="!game.over" class="counter-form" novalidate @submit.prevent="send">
      <label v-for="f in fields" :key="f.key">
        {{ f.label }}
        <input
          v-model.number="drafts[f.key]"
          type="number"
          :inputmode="f.step < 1 ? 'decimal' : 'numeric'"
          :min="f.min"
          :max="f.max"
          :step="f.step"
          :data-testid="f.testid"
        />
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
      <p v-else class="muted">Ask for more cash or {{ better }} to see your odds.</p>
      <div class="confirm-buttons">
        <button type="submit" :disabled="game.busy || !odds" data-testid="funding-counter">
          Counter ({{ talks.countersLeft }} left)
        </button>
        <button type="button" class="ghost" :disabled="game.busy || !odds" data-testid="auto-negotiate" @click="autoNegotiate">
          Auto-negotiate
        </button>
      </div>
      <p class="muted">
        Auto-negotiate plays the rest for you: the same counter on every offer, with the same rolls as by hand, to their
        final offer. It never accepts for you.
      </p>
    </form>
    <p class="muted">
      They never walk away: their latest offer stands until you accept or decline it. The more you ask, the worse your
      odds; a counter can ask up to {{ percent(talks.maxAsk) }} better terms in all.
    </p>
  </section>
</template>
