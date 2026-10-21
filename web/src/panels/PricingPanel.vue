<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from "vue";
import type { PricePreviewView } from "@xaas/server/api-types";
import { api, formatCash, formatCount, formatPrice } from "../api";
import { days, useGame } from "../game";
import AppModal from "../components/AppModal.vue";
import WaveChart from "../components/WaveChart.vue";

// Pricing: what each paying user pays a month, and what that brings in a day. The price is changed in a modal, with
// the product's fair price as a hint and a live preview of the wave it would start, and applies from the next day
// played. After a change the price is locked for a while, with a countdown.
const game = useGame();
const id = useId();
const open = ref(false);
const draft = ref<number | "">("");
const formError = ref("");

const maxPrice = computed(() => game.meta?.maxPrice ?? 0);
// Price against the fair price, in words, so the student sees which side of it they are.
const priceNote = computed(() => {
  const c = game.company;
  if (!c) return "";
  const ratio = c.price / c.fairPrice;
  if (Math.abs(ratio - 1) < 0.005) return "At the fair price.";
  const percent = Math.round(100 * Math.abs(ratio - 1));
  return ratio > 1 ? `${percent}% above the fair price.` : `${percent}% below the fair price.`;
});
const lockDaysLeft = computed(() => game.company?.priceLockDaysLeft ?? 0);

// The live preview: what the draft price would do, fetched from the sim a moment after the student stops typing.
// Only the latest request's answer is shown, so a slow one can't overwrite a newer one.
const PREVIEW_DELAY_MS = 250;
// For the playtest log: the prices previewed since the modal opened (not the current one it opens on), and whether the
// student went on to set one. Logged when it closes.
const tried: number[] = [];
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

function schedulePreview(price: number | "") {
  window.clearTimeout(previewTimer);
  const seq = ++previewSeq;
  if (typeof price !== "number" || !(price > 0) || price > maxPrice.value) {
    preview.value = undefined;
    previewError.value = "";
    previewing.value = false;
    return;
  }
  previewing.value = true;
  previewTimer = window.setTimeout(async () => {
    try {
      const result = await api.pricePreview(game.code, game.id, price);
      if (seq !== previewSeq) return;
      if (price !== tried.at(-1) && (tried.length || price !== game.company?.price)) tried.push(price);
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

watch(draft, (price) => open.value && schedulePreview(price));
onBeforeUnmount(() => window.clearTimeout(previewTimer));

// The preview's change in income a day, once the wave settles.
const incomeChange = computed(() => (preview.value ? preview.value.dailyIncome - preview.value.currentDailyIncome : 0));
const signedCash = (n: number) => `${n < 0 ? "−" : "+"}${formatCash(Math.abs(n))}`;

function openModal() {
  draft.value = game.company?.price ?? "";
  formError.value = "";
  open.value = true;
  schedulePreview(draft.value);
}

async function save() {
  const price = draft.value;
  if (typeof price !== "number" || !(price > 0)) {
    formError.value = "Enter a price above £0.";
    return;
  }
  if (price > maxPrice.value) {
    formError.value = `The highest price you can set is ${formatCash(maxPrice.value)} a month.`;
    return;
  }
  if (lockDaysLeft.value) {
    formError.value = `Your price is locked for ${days(lockDaysLeft.value)} more.`;
    return;
  }
  formError.value = "";
  await game.act({ type: "setPrice", price });
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
        {{ lockDaysLeft ? "Preview a price" : "Change price" }}
      </button>
    </div>
    <div class="stats">
      <div class="stat">
        <span class="label">Monthly price</span>
        <span class="value" data-testid="price">{{ formatPrice(game.company.price) }}</span>
        <small>{{ priceNote }}</small>
      </div>
      <div class="stat">
        <span class="label">Fair price</span>
        <span class="value" data-testid="fair-price">{{ formatPrice(game.company.fairPrice) }}</span>
        <small>What users think it's worth</small>
      </div>
      <div class="stat">
        <span class="label">Income a day</span>
        <span class="value pos" data-testid="daily-income">{{ formatCash(game.company.dailyIncome) }}</span>
        <small>{{ formatCount(game.company.paidUsers) }} paying users</small>
      </div>
      <div class="stat">
        <span class="label">Price lock</span>
        <span class="value" data-testid="price-lock">{{ lockDaysLeft ? days(lockDaysLeft) : "Unlocked" }}</span>
        <small>{{ lockDaysLeft ? "until you can change it again" : "You can change it now" }}</small>
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
    <p class="muted">
      Each paying user pays a day's share of the monthly price: {{ formatPrice(game.company.price) }} a month is
      {{ formatPrice(Math.round((game.company.price / 30) * 100) / 100) }} a day. Free users pay nothing. Charge more than
      the fair price and fewer people sign up, and fewer of those who do will pay.
    </p>
  </section>

  <AppModal :open="open" title="Set your price" @close="open = false">
    <form class="price-form" novalidate @submit.prevent="save">
      <label :for="`${id}-price`">Monthly price per paying user (£)</label>
      <input
        :id="`${id}-price`"
        v-model.number="draft"
        type="number"
        inputmode="decimal"
        min="0.01"
        :max="maxPrice"
        step="0.01"
        :aria-describedby="`${id}-hint`"
        data-testid="price-input"
      />
      <p :id="`${id}-hint`" class="muted price-hint" data-testid="fair-price-hint">
        Fair price for {{ game.productName(game.company!.productType).toLowerCase() }}:
        <strong>{{ formatPrice(game.company!.fairPrice) }}</strong> a month. You can charge up to
        {{ formatCash(maxPrice) }}.
      </p>
      <p v-if="lockDaysLeft" class="price-locked" data-testid="price-locked-note">
        <span class="badge">Locked</span> You changed your price recently, so it's locked for
        {{ days(lockDaysLeft) }} more. You can still preview what a new price would do.
      </p>
      <div class="price-preview" data-testid="price-preview" aria-live="polite" :aria-busy="previewing">
        <template v-if="preview && preview.direction === 'none'">
          <p class="muted">That's your price now: nothing changes.</p>
        </template>
        <template v-else-if="preview">
          <h3 class="price-preview-title">
            If nothing else changes
            <span v-if="previewing" class="muted">· updating…</span>
          </h3>
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
                <strong>{{ formatCount(preview.total.tickets) }}</strong>
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
          <WaveChart :days="preview.days" :direction="preview.direction === 'rise' ? 'rise' : 'cut'" />
          <p class="muted">
            {{
              preview.direction === "rise"
                ? `A small reaction tomorrow, then a backlash over ${days(preview.days.length)} as word spreads.`
                : `Word of mouth spreads over ${days(preview.days.length)}.`
            }}
            {{ formatCount(preview.paidUsers) }} paying users at {{ formatPrice(preview.price) }} a month, then the
            price is locked for {{ days(preview.lockDays) }}.
          </p>
        </template>
        <p v-else-if="previewing" class="muted">Working out what that price would do…</p>
        <p v-else-if="previewError" class="error">{{ previewError }}</p>
      </div>
      <p v-if="formError || game.error" class="error" role="alert">{{ formError || game.error }}</p>
      <p class="muted">The new price applies from the next day you play.</p>
      <div class="confirm-buttons">
        <button type="submit" :disabled="game.busy || lockDaysLeft > 0" data-testid="save-price">Set price</button>
        <button type="button" class="ghost" @click="open = false">Cancel</button>
      </div>
    </form>
  </AppModal>
</template>
