<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from "vue";
import type { PricePreviewView } from "@xaas/server/api-types";
import { api, formatCash, formatCount, formatPrice, formatRate } from "../api";
import { days, useGame } from "../game";
import AppModal from "../components/AppModal.vue";
import BandChart from "../components/BandChart.vue";
import WaveChart from "../components/WaveChart.vue";

// Pricing: what each paying user pays a month, and what that brings in a day. The price is changed in a modal, with
// the product's fair price as a hint and a live preview of the wave it would start, and applies from the next day
// played. After a change the price is locked for a while, with a countdown. On the payments app the price is a monthly
// fee and a transaction fee (a share of every payment) set together in one change: customers judge them together, as
// what a usual month costs a business.
const game = useGame();
const id = useId();
const open = ref(false);
const draft = ref<number | "">("");
// The payments app's transaction fee, as a percentage (2.5 for 2.5%).
const draftRate = ref<number | "">("");
const formError = ref("");

const payments = computed(() => game.company?.payments ?? null);
const maxPrice = computed(() => game.meta?.maxPrice ?? 0);
const maxRatePercent = computed(() => (payments.value ? payments.value.maxRate * 100 : 0));
/** A percentage typed in the form as a share, to a hundredth of a percent: 2.5 → 0.025. */
const shareOf = (percent: number) => Math.round(percent * 100) / 10_000;
/** A price for the screens: "£5", or on the payments app "£10 + 2%". */
const priceLabel = (price: number, rate: number | null) => (rate === null ? formatPrice(price) : `${formatPrice(price)} + ${formatRate(rate)}`);
// Price against the fair price, in words, so the student sees which side of it they are.
const priceNote = computed(() => {
  const c = game.company;
  if (!c) return "";
  const ratio = c.payments ? c.payments.monthly / c.payments.fairMonthly : c.price / c.fairPrice;
  if (Math.abs(ratio - 1) < 0.005) return "At the fair price.";
  const percent = Math.round(100 * Math.abs(ratio - 1));
  return ratio > 1 ? `${percent}% above the fair price.` : `${percent}% below the fair price.`;
});
const lockDaysLeft = computed(() => game.company?.priceLockDaysLeft ?? 0);
// From IPO approval to the bell the price can't change at all (#257).
const ipoLocked = computed(() => game.company?.ipo.status === "approved");
// The fair price moves with a quarter of each pay review's inflation (#251): why, in words, once it has.
const fairMoved = computed(() => {
  const f = game.company?.fairPriceView;
  if (!f || f.rise <= 0) return "";
  const last = f.lastInflation === null ? "" : `; the last pay review's inflation was ${formatRate(f.lastInflation)}`;
  return `Up ${formatRate(Math.round(f.rise * 10_000) / 10_000)} from ${formatPrice(f.baseFairPrice)}, by a quarter of each pay review's inflation${last}`;
});
// At or below the fair price, more free users start paying each day.
const atOrBelowFair = computed(() => {
  const c = game.company;
  if (!c) return false;
  return c.payments ? c.payments.monthly <= c.payments.fairMonthly : c.price <= c.fairPrice;
});

// The live preview: what the draft price would do, fetched from the sim a moment after the student stops typing.
// Only the latest request's answer is shown, so a slow one can't overwrite a newer one.
const PREVIEW_DELAY_MS = 250;
// For the playtest log: the prices previewed since the modal opened (not the current one it opens on), and whether the
// student went on to set one. Logged when it closes.
const tried: number[] = [];
// On the payments app, what a usual month would cost a business at the draft fee and rate: what's logged as tried.
const monthlyAt = (price: number, rate: number | null) => (payments.value && rate !== null ? price + rate * payments.value.volumePerPaidUser : price);
let confirmed = false;
watch(open, (isOpen) => {
  if (isOpen || (!tried.length && !confirmed)) return;
  game.track("pricePreview", { prices: tried.splice(0).slice(-20), confirmed });
  confirmed = false;
});
const preview = ref<PricePreviewView>();
const previewError = ref("");
const previewing = ref(false);
let previewTimer: number | undefined;
let previewSeq = 0;

function schedulePreview(price: number | "", ratePercent: number | "" = "") {
  window.clearTimeout(previewTimer);
  const seq = ++previewSeq;
  const pay = payments.value;
  const rate = pay ? (typeof ratePercent === "number" ? shareOf(ratePercent) : null) : null;
  const badRate = !!pay && (rate === null || rate < 0 || rate > pay.maxRate);
  const badPrice = typeof price !== "number" || price < 0 || (!(price > 0) && !(rate && rate > 0)) || price > maxPrice.value;
  if (badPrice || badRate) {
    preview.value = undefined;
    previewError.value = "";
    previewing.value = false;
    return;
  }
  previewing.value = true;
  previewTimer = window.setTimeout(async () => {
    try {
      const result = await api.pricePreview(game.code, game.id, price, rate ?? undefined);
      if (seq !== previewSeq) return;
      const monthly = monthlyAt(price, rate);
      const now = game.company ? monthlyAt(game.company.price, game.company.payments?.rate ?? null) : undefined;
      if (monthly !== tried.at(-1) && (tried.length || monthly !== now)) tried.push(monthly);
      if (result.direction !== "none") compare(result);
      preview.value = result;
      previewError.value = "";
    } catch (e) {
      if (seq !== previewSeq) return;
      preview.value = undefined;
      previewError.value = (e as Error).message;
    } finally {
      if (seq === previewSeq) previewing.value = false;
    }
  }, PREVIEW_DELAY_MS);
}

watch([draft, draftRate], ([price, ratePercent]) => open.value && schedulePreview(price, ratePercent));
onBeforeUnmount(() => window.clearTimeout(previewTimer));

// The preview's change in income a day, once the wave settles.
const incomeChange = computed(() => (preview.value ? preview.value.dailyIncome - preview.value.currentDailyIncome : 0));
const signedCash = (n: number) => `${n < 0 ? "−" : "+"}${formatCash(Math.abs(n))}`;
// The preview in one sentence: what the price does to income, and what it costs in users.
const verdict = computed(() => {
  const p = preview.value;
  if (!p || p.direction === "none") return "";
  const change = incomeChange.value;
  const income =
    Math.abs(change) < 1
      ? `about the same income as now, ${formatCash(p.dailyIncome)} a day`
      : `${formatCash(Math.abs(change))} a day ${change > 0 ? "more" : "less"} than now (${formatCash(p.dailyIncome)} a day)`;
  const users =
    p.direction === "rise"
      ? `${formatCount(p.total.left)} paying users leave and ${formatCount(p.total.toFree)} drop to free.`
      : `${formatCount(p.total.joined)} new users join and ${formatCount(p.total.upgraded)} free users start paying.`;
  return `At ${priceLabel(p.price, p.rate)} you'd make ${income} once the wave settles. ${users}`;
});
// The rise's ticket burst against today's support (#163): what it comes to and whether support clears it. On a cut,
// only when the new users bring more tickets than support clears.
const ticketVerdict = computed(() => {
  const p = preview.value;
  if (!p || p.direction === "none") return "";
  const t = p.tickets;
  if (t.tickets === 0 && t.canClear) return "";
  const burst =
    t.tickets > 0
      ? `The rise brings about ${formatCount(t.tickets)} extra support tickets, up to ${formatCount(t.peakDay)} in a day. `
      : "The new users bring more support tickets than your team clears. ";
  if (t.canClear) return `${burst}Your support team clears ${formatCount(t.clearance)} a day, so it can keep up.`;
  const team = t.clearance === 0 ? "You have no support team" : `Your support team clears ${formatCount(t.clearance)} a day`;
  if (t.waitingAfter === 0) {
    return `${burst}${team}, so up to ${formatCount(t.peakWaiting)} wait at once and satisfaction dips until they're cleared.`;
  }
  return `${burst}${team}, so ${formatCount(t.waitingAfter)} are still waiting when the wave ends. Satisfaction falls and paying users leave. Hire support first.`;
});
/** A share as a percentage to one place: 0.2318 → "23.2%". */
const sharePercent = (share: number) => `${(100 * share).toFixed(1).replace(/\.0$/, "")}%`;
/** A customer type's name, lower case, from the company's mix. */
const typeName = (id: string) => (game.company?.customerMix.types.find((t) => t.id === id)?.name ?? id).toLowerCase();
// A step too small to matter: the student is better off trying a bigger one.
const tinyStep = computed(() => {
  const p = preview.value;
  return !!p && p.direction !== "none" && Math.abs(p.monthly - p.currentMonthly) / p.currentMonthly < 0.05;
});

// Every price previewed since the modal opened, by price, so they can be compared side by side without typing each
// one again. The one bringing in the most once the wave settles is marked. On the payments app a price is a fee and
// rate together, ordered by what a usual month costs.
type ComparedRow = { key: string; price: number; rate: number | null; monthly: number; dailyIncome: number; change: number };
const compared = ref<ComparedRow[]>([]);
const keyOf = (price: number, rate: number | null) => `${price}|${rate ?? ""}`;
function compare(p: PricePreviewView) {
  const row = { key: keyOf(p.price, p.rate), price: p.price, rate: p.rate, monthly: p.monthly, dailyIncome: p.dailyIncome, change: p.dailyIncome - p.currentDailyIncome };
  compared.value = [...compared.value.filter((r) => r.key !== row.key), row].toSorted((a, b) => a.monthly - b.monthly || a.price - b.price).slice(-8);
}
const bestPrice = computed(() =>
  compared.value.length > 1 ? compared.value.reduce((best, r) => (r.dailyIncome > best.dailyIncome ? r : best)).key : undefined,
);
const draftKey = computed(() =>
  typeof draft.value === "number" ? keyOf(draft.value, payments.value && typeof draftRate.value === "number" ? shareOf(draftRate.value) : null) : "",
);
// Quick steps from the price now, so trying a price is one click. On the payments app each moves the fee and the
// rate together.
const quickPrices = computed(() => {
  const c = game.company;
  if (!c) return [];
  const round = (n: number) => Math.max(c.payments ? 0 : 0.01, Math.min(maxPrice.value, Math.round(n * 100) / 100));
  const pay = c.payments;
  const rate = (r: number) => (pay ? Math.min(pay.maxRate, Math.round(r * 10_000) / 10_000) : null);
  const step = (m: number) => ({ price: round(c.price * m), rate: pay ? rate(pay.rate * m) : null });
  return [
    { label: "−25%", ...step(0.75) },
    { label: "−10%", ...step(0.9) },
    { label: "Fair price", price: round(c.fairPrice), rate: pay ? pay.fairRate : null },
    { label: "+10%", ...step(1.1) },
    { label: "+25%", ...step(1.25) },
  ];
});
function tryPrice(price: number, label: string, rate: number | null = null) {
  game.track("control", { control: "price-quick", value: label });
  draft.value = price;
  if (rate !== null) draftRate.value = Math.round(rate * 10_000) / 100;
}

function openModal() {
  draft.value = game.company?.price ?? "";
  draftRate.value = payments.value ? Math.round(payments.value.rate * 10_000) / 100 : "";
  compared.value = [];
  formError.value = "";
  open.value = true;
  schedulePreview(draft.value, draftRate.value);
}

async function save() {
  const price = draft.value;
  const pay = payments.value;
  const ratePercent = draftRate.value;
  if (pay) {
    if (typeof ratePercent !== "number" || ratePercent < 0 || ratePercent > maxRatePercent.value) {
      formError.value = `Enter a transaction fee from 0% to ${formatRate(pay.maxRate)}.`;
      return;
    }
    if (typeof price !== "number" || price < 0) {
      formError.value = "Enter a monthly fee of £0 or more.";
      return;
    }
    if (price === 0 && ratePercent === 0) {
      formError.value = "Charge a monthly fee, a transaction fee or both.";
      return;
    }
  } else if (typeof price !== "number" || !(price > 0)) {
    formError.value = "Enter a price above £0.";
    return;
  }
  if (price > maxPrice.value) {
    formError.value = `The highest price you can set is ${formatCash(maxPrice.value)} a month.`;
    return;
  }
  if (ipoLocked.value) {
    formError.value = "Your price is locked from your IPO's approval until the opening bell.";
    return;
  }
  if (lockDaysLeft.value) {
    formError.value = `Your price is locked for ${days(lockDaysLeft.value)} more.`;
    return;
  }
  formError.value = "";
  await game.act({ type: "setPrice", price, ...(pay && typeof ratePercent === "number" ? { rate: shareOf(ratePercent) } : {}) });
  if (game.error) return;
  confirmed = true;
  open.value = false;
}
</script>

<template>
  <section v-if="game.company" class="card" aria-labelledby="pricing-heading" data-testid="pricing">
    <div class="row-between panel-head">
      <h2 id="pricing-heading">Price</h2>
      <button type="button" :disabled="game.busy || game.over" aria-haspopup="dialog" @click="openModal">
        {{ lockDaysLeft || ipoLocked ? "Preview a price" : "Change price" }}
      </button>
    </div>
    <div v-if="payments" class="stats">
      <div class="stat">
        <span class="label">Monthly fee</span>
        <span class="value" data-testid="price">{{ formatPrice(payments.fee) }}</span>
        <small data-testid="fair-price-moved">Fair {{ formatPrice(payments.fairFee) }}{{ fairMoved ? ` · ${fairMoved}` : "" }}</small>
      </div>
      <div class="stat">
        <span class="label">Transaction fee</span>
        <span class="value" data-testid="transaction-rate">{{ formatRate(payments.rate) }}</span>
        <small>of every payment · fair {{ formatRate(payments.fairRate) }}</small>
      </div>
      <div class="stat">
        <span class="label">A usual month per business</span>
        <span class="value" data-testid="monthly-cost">{{ formatPrice(payments.monthly) }}</span>
        <small>{{ priceNote }} Fair {{ formatPrice(payments.fairMonthly) }}</small>
      </div>
    </div>
    <div class="stats">
      <template v-if="!payments">
        <div class="stat">
          <span class="label">Monthly price</span>
          <span class="value" data-testid="price">{{ formatPrice(game.company.price) }}</span>
          <small>{{ priceNote }}</small>
        </div>
        <div class="stat">
          <span class="label">Fair price</span>
          <span class="value" data-testid="fair-price">{{ formatPrice(game.company.fairPrice) }}</span>
          <small data-testid="fair-price-moved">{{ fairMoved || "What users think it's worth" }}</small>
        </div>
      </template>
      <div class="stat">
        <span class="label">Income a day</span>
        <span class="value pos" data-testid="daily-income">{{ formatCash(game.company.dailyIncome) }}</span>
        <small>{{ formatCount(game.company.paidUsers) }} paying users</small>
      </div>
      <div class="stat">
        <span class="label">Price lock</span>
        <span class="value" data-testid="price-lock">{{ ipoLocked ? "Until the bell" : lockDaysLeft ? days(lockDaysLeft) : "Unlocked" }}</span>
        <small>{{ ipoLocked ? "Locked from your IPO's approval" : lockDaysLeft ? "until you can change it again" : "You can change it now" }}</small>
      </div>
    </div>
    <div
      v-if="lockDaysLeft && game.meta"
      class="meter"
      role="meter"
      aria-label="Days of the price lock left"
      aria-valuemin="0"
      :aria-valuemax="game.meta.priceLockDays"
      :aria-valuenow="lockDaysLeft"
    >
      <div class="meter-fill high" :style="{ width: `${(100 * lockDaysLeft) / game.meta.priceLockDays}%` }"></div>
    </div>
    <p v-if="payments" class="muted" data-testid="payments-note">
      Each paying business pays a day's share of the monthly fee, and you take {{ formatRate(payments.rate) }} of every
      payment it takes: about {{ formatCash(payments.volumePerPaidUser) }} a month for a usual business, so
      {{ formatPrice(payments.monthly) }} a month in all. Customers judge the two together, so raising either is a price
      rise. Payments, and the transaction fees they bring, are busier on paydays and Black Friday. While you're down
      no payments are taken and businesses aren't charged the fee for those hours.
    </p>
    <p v-else class="muted">
      Each paying user pays a day's share of the monthly price: {{ formatPrice(game.company.price) }} a month is
      {{ formatPrice(Math.round((game.company.price / 30) * 100) / 100) }} a day. Free users pay nothing. Charge more than
      the fair price and fewer people sign up, and fewer of those who do will pay.
    </p>
    <p v-if="atOrBelowFair" class="muted" data-testid="price-conversion-note">
      At or below the fair price, more of your free users start paying each day.
    </p>
  </section>

  <AppModal :open="open" title="Set your price" @close="open = false">
    <form class="price-form" novalidate @submit.prevent="save">
      <label :for="`${id}-price`">{{ payments ? "Monthly fee per paying business (£)" : "Monthly price per paying user (£)" }}</label>
      <input
        :id="`${id}-price`"
        v-model.number="draft"
        type="number"
        inputmode="decimal"
        :min="payments ? 0 : 0.01"
        :max="maxPrice"
        step="0.01"
        :aria-describedby="`${id}-hint`"
        data-testid="price-input"
      />
      <template v-if="payments">
        <label :for="`${id}-rate`">Transaction fee (% of every payment)</label>
        <input
          :id="`${id}-rate`"
          v-model.number="draftRate"
          type="number"
          inputmode="decimal"
          min="0"
          :max="maxRatePercent"
          step="0.01"
          :aria-describedby="`${id}-hint`"
          data-testid="rate-input"
        />
      </template>
      <div class="price-quick" role="group" aria-label="Try a price" data-testid="price-quick">
        <span class="muted">Try:</span>
        <button
          v-for="q in quickPrices"
          :key="q.label"
          type="button"
          class="ghost"
          :aria-label="`Try ${priceLabel(q.price, q.rate)} (${q.label})`"
          @click="tryPrice(q.price, q.label, q.rate)"
        >
          {{ q.label }} <small>{{ priceLabel(q.price, q.rate) }}</small>
        </button>
      </div>
      <p v-if="payments" :id="`${id}-hint`" class="muted price-hint" data-testid="fair-price-hint">
        Fair for a payments app: <strong>{{ formatPrice(payments.fairFee) }}</strong> a month plus
        <strong>{{ formatRate(payments.fairRate) }}</strong> of every payment, {{ formatPrice(payments.fairMonthly) }} a usual
        month. One change sets both, and locks both. You can charge up to {{ formatCash(maxPrice) }} and
        {{ formatRate(payments.maxRate) }}.
      </p>
      <p v-else :id="`${id}-hint`" class="muted price-hint" data-testid="fair-price-hint">
        Fair price for {{ game.productName(game.company!.productType).toLowerCase() }}:
        <strong>{{ formatPrice(game.company!.fairPrice) }}</strong> a month<template v-if="fairMoved">
          ({{ fairMoved.charAt(0).toLowerCase() + fairMoved.slice(1) }})</template
        >. You can charge up to {{ formatCash(maxPrice) }}.
      </p>
      <p v-if="ipoLocked" class="price-locked" data-testid="price-ipo-locked-note">
        <span class="badge">Locked</span> Your IPO is approved, so your price is locked until the opening bell: investors
        are buying the company as it stands.
      </p>
      <p v-if="lockDaysLeft" class="price-locked" data-testid="price-locked-note">
        <span class="badge">Locked</span> You changed your price recently, so it's locked for
        {{ days(lockDaysLeft) }} more. You can still preview what a new price would do.
      </p>
      <div class="price-preview" data-testid="price-preview" aria-live="polite" :aria-busy="previewing">
        <template v-if="preview && preview.direction === 'none'">
          <p v-if="preview.price !== preview.currentPrice || preview.rate !== preview.currentRate" class="muted" data-testid="price-same-monthly">
            A usual month still costs a business {{ formatPrice(preview.monthly) }}, so customers won't react: you only
            move money between the fee and the transaction fee. It still locks your price.
          </p>
          <p v-else class="muted">That's your price now: nothing changes.</p>
        </template>
        <template v-else-if="preview">
          <h3 class="price-preview-title">
            If nothing else changes
            <span v-if="previewing" class="muted">· updating…</span>
          </h3>
          <p :class="['price-verdict', incomeChange < 0 ? 'neg' : 'pos']" data-testid="price-verdict">{{ verdict }}</p>
          <p v-if="ticketVerdict" :class="['price-tickets', preview.tickets.canClear ? 'muted' : 'neg']" data-testid="preview-tickets">
            {{ ticketVerdict }}
          </p>
          <p v-if="tinyStep" class="muted" data-testid="price-tiny-step">
            That's a small change from {{ priceLabel(preview.currentPrice, preview.currentRate) }}, so the effect is small too. Try a bigger
            step to see the difference.
          </p>
          <div class="preview-figures">
            <div class="preview-figure">
              <span class="label">Income a day after the wave</span>
              <strong data-testid="preview-income">{{ formatCash(preview.dailyIncome) }}</strong>
              <small :class="incomeChange < 0 ? 'neg' : 'pos'">
                {{ signedCash(incomeChange) }} on today's {{ formatCash(preview.currentDailyIncome) }}
              </small>
            </div>
            <template v-if="preview.direction === 'rise'">
              <div class="preview-figure">
                <span class="label">Paying users who leave</span>
                <strong class="neg" data-testid="preview-left">{{ formatCount(preview.total.left) }}</strong>
              </div>
              <div class="preview-figure">
                <span class="label">Drop to free</span>
                <strong data-testid="preview-to-free">{{ formatCount(preview.total.toFree) }}</strong>
              </div>
              <div class="preview-figure">
                <span class="label">Backlash tickets</span>
                <strong :class="{ neg: !preview.tickets.canClear }" data-testid="preview-backlash">{{ formatCount(preview.total.tickets) }}</strong>
                <small data-testid="preview-support">
                  {{ preview.tickets.canClear ? "Support keeps up" : `${formatCount(preview.tickets.peakWaiting)} wait at most` }}
                </small>
              </div>
            </template>
            <template v-else>
              <div class="preview-figure">
                <span class="label">New users</span>
                <strong class="pos" data-testid="preview-joined">+{{ formatCount(preview.total.joined) }}</strong>
                <small>{{ formatCount(preview.total.joinedPaid) }} of them paying</small>
              </div>
              <div class="preview-figure">
                <span class="label">Free users who upgrade</span>
                <strong class="pos" data-testid="preview-upgraded">+{{ formatCount(preview.total.upgraded) }}</strong>
              </div>
            </template>
          </div>
          <p v-if="preview.noWave" class="muted" data-testid="price-no-wave">{{ preview.noWave }}</p>
          <WaveChart :days="preview.days" :direction="preview.direction === 'rise' ? 'rise' : 'cut'" />
          <BandChart :bands="preview.bands" />
          <p class="muted" data-testid="price-expected">
            Customers expect {{ formatPrice(preview.expectedPrice) }}, the price that has held a month: a cut counts from
            it. A rise counts from the lowest price they remember, {{ formatPrice(preview.rememberedPrice) }}.
            <template v-if="preview.direction === 'rise'">Those who grumble online send new users to your rivals while the backlash lasts.</template>
          </p>
          <p v-if="preview.direction === 'rise'" class="muted" data-testid="preview-reaction">
            Price reaction: {{ sharePercent(preview.reaction) }} of paying users. That's each customer type's reaction
            weighted by its share of users:
            {{ preview.reactions.filter((r) => r.share > 0).map((r) => `${typeName(r.id)} ${sharePercent(r.reaction)} × ${sharePercent(r.share)}`).join(", ") }}.
          </p>
          <p class="muted">
            {{
              preview.direction === "rise"
                ? `A small reaction tomorrow, then a backlash over ${days(preview.days.length)} as word spreads.`
                : `Word of mouth spreads over ${days(preview.days.length)}.`
            }}
            {{ formatCount(preview.paidUsers) }} paying users at {{ priceLabel(preview.price, preview.rate) }}, then the
            price is locked for {{ days(preview.lockDays) }}.
          </p>
        </template>
        <p v-else-if="previewing" class="muted">Working out what that price would do…</p>
        <p v-else-if="previewError" class="error">{{ previewError }}</p>
      </div>
      <table v-if="compared.length > 1" class="compare price-compare" data-testid="price-compare">
        <caption class="muted">Prices you've tried: income a day once the wave settles</caption>
        <thead>
          <tr>
            <th scope="col">Price</th>
            <th scope="col">Income a day</th>
            <th scope="col">On today's</th>
            <th scope="col"><span class="visually-hidden">Use</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in compared" :key="r.key" :class="{ on: r.key === draftKey }">
            <th scope="row">
              {{ priceLabel(r.price, r.rate) }}
              <span v-if="r.key === bestPrice" class="badge best-badge">Most income</span>
            </th>
            <td>{{ formatCash(r.dailyIncome) }}</td>
            <td :class="r.change < 0 ? 'neg' : 'pos'">{{ signedCash(r.change) }}</td>
            <td>
              <button v-if="r.key !== draftKey" type="button" class="ghost" @click="tryPrice(r.price, 'compared', r.rate)">Use</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="formError || game.error" class="error" role="alert">{{ formError || game.error }}</p>
      <p class="muted">The new price applies from the next day you play.</p>
      <div class="confirm-buttons">
        <button type="submit" :disabled="game.busy || lockDaysLeft > 0 || ipoLocked" data-testid="save-price">Set price</button>
        <button type="button" class="ghost" @click="open = false">Cancel</button>
      </div>
    </form>
  </AppModal>
</template>
