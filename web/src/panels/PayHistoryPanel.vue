<script setup lang="ts">
import { computed } from "vue";
import { quarterName, type PayHistoryEntry, type TribunalPick } from "@xaas/sim";
import { formatCash } from "../api";
import { useGame } from "../game";
import { formatShare } from "../shares";

// The pay history: each settled pay review with its date, inflation, how it ended, the cash rise and schemes agreed, any
// tribunal fee and share save's new shares, and the pay multiplier after; with every rise so far compounded, and when the
// next review comes. Read-only.
const game = useGame();
// Pay reviews start about a month into Grow (#236): before it, there's no first review to give a day for.
const beforeGrow = computed(() => game.company?.phase.phases.find((p) => p.id === "grow")?.day === null);
const history = computed(() => game.company?.payHistory ?? null);

/** A rise as a percent to a tenth: 3.4%. */
const pct = (n: number) => `${(Math.round(n * 1000) / 10).toFixed(1)}%`;
/** Points above or below inflation: "+0.5 pts", "−1.0 pts". */
const points = (n: number) => `${n < 0 ? "−" : "+"}${(Math.round(Math.abs(n) * 1000) / 10).toFixed(1)} pts`;
const PICK: Record<TribunalPick, string> = { student: "your offer", middle: "the middle", staff: "staff's figure" };

/** How a review ended, in words. */
function ended(r: PayHistoryEntry): string {
  if (r.outcome === "offerAccepted") return `Agreed: staff accepted your ${ordinal(r.offers)} offer`;
  if (r.outcome === "counterAccepted") return "You accepted staff's counter";
  return `Tribunal picked ${PICK[r.tribunalPick!]}`;
}
/** "q3", or in a long game's later years "y2q1", for the test ids. */
const quarterId = (r: PayHistoryEntry) => `${r.year > 1 ? `y${r.year}` : ""}q${r.quarter}`;
/** "Quarter 3", or "Quarter 1 of year 2". */
const quarterTitle = (r: PayHistoryEntry) => quarterName(r).replace(/^q/, "Q");
const ordinal = (n: number) => ["first", "second", "final"][n - 1] ?? `${n}th`;
/** The schemes a review raised: "Pension top-up 0 → 2, Death in service". */
const raises = (r: PayHistoryEntry) =>
  r.schemeRaises.map((s) => (s.toggle ? s.name : `${s.name} ${s.from} → ${s.to}`)).join(", ");
</script>

<template>
  <section v-if="history" class="card" aria-labelledby="pay-history-heading" data-testid="pay-history">
    <h2 id="pay-history-heading">Pay history</h2>
    <p data-testid="pay-multiplier">
      Pay is <strong>×{{ history.payMultiplier.toFixed(3) }}</strong> the day rates:
      {{ history.reviews.length ? `+${pct(history.payMultiplier - 1)} from every rise so far, compounded.` : "no rises yet." }}
    </p>
    <p v-if="!history.reviews.length" class="muted" data-testid="pay-history-empty">
      No pay reviews yet.<template v-if="history.nextReview">
        The first comes in {{ quarterName(history.nextReview) }}, with its rise from day {{ history.nextReview.startDay }}.</template
      ><template v-else-if="beforeGrow && !game.over">
        The first comes about a month into the Grow phase, when your first angel investor has approached.</template
      >
    </p>
    <ol v-else class="pay-history">
      <li v-for="r in history.reviews" :key="r.startDay" :data-testid="`pay-history-${quarterId(r)}`">
        <div class="head">
          <strong>{{ quarterTitle(r) }}</strong>
          <span class="muted">{{ r.date }} (day {{ r.startDay }})</span>
          <span class="after" title="Pay as a multiple of the day rates after this review">×{{ r.payMultiplier.toFixed(3) }}</span>
        </div>
        <div data-testid="pay-history-ended">
          {{ ended(r) }}<template v-if="r.tribunalFee"
            >, <span data-testid="pay-history-fee">tribunal fee {{ formatCash(r.tribunalFee) }}</span></template
          >
        </div>
        <div data-testid="pay-history-rise">
          Cash rise <strong>{{ pct(r.rise) }}</strong> on inflation of {{ pct(r.inflation) }}
          <span class="muted">({{ points(r.realTerms) }})</span>
        </div>
        <div class="muted">
          Schemes raised: <span data-testid="pay-history-schemes">{{ raises(r) || "none" }}</span
          ><template v-if="r.shareSaveShares"
            >. <span data-testid="pay-history-shares"
              >{{ r.shareSaveShares.toLocaleString("en-GB") }} new shares to the staff share scheme</span
            ></template
          >
        </div>
      </li>
    </ol>
    <p v-if="history.tribunalFees" class="muted" data-testid="pay-history-fees">
      Tribunal fees paid: {{ formatCash(history.tribunalFees) }}.
    </p>
    <p v-if="history.reviews.length && history.nextReview" class="muted" data-testid="pay-history-next">
      The next review comes in {{ quarterName(history.nextReview) }}, with its rise from day {{ history.nextReview.startDay }}.
    </p>
  </section>
</template>

<style scoped>
.pay-history {
  list-style: none;
  margin: 0;
  padding: 0;
}
.pay-history li {
  display: grid;
  gap: 0.2rem;
  padding: 0.6rem 0;
  border-top: 1px solid var(--border);
}
.pay-history .head {
  display: flex;
  flex-wrap: wrap;
  gap: 0 0.5rem;
  align-items: baseline;
}
.pay-history .after {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
</style>
