<script setup lang="ts">
import { computed, ref, useId } from "vue";
import { formatCash, formatCount, formatPrice } from "../api";
import { useGame } from "../game";
import AppModal from "../components/AppModal.vue";

// Pricing: what each paying user pays a month, and what that brings in a day. The price is changed in a modal, with
// the product's fair price as a hint, and applies from the next day played.
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
// What the draft price would bring in a day at today's paying users, by the same rule as the sim: paid × price ÷ 30.
const draftIncome = computed(() =>
  game.company && typeof draft.value === "number" && draft.value > 0
    ? Math.round((game.company.paidUsers * draft.value) / 30)
    : undefined,
);

function openModal() {
  draft.value = game.company?.price ?? "";
  formError.value = "";
  open.value = true;
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
  formError.value = "";
  await game.act({ type: "setPrice", price });
  if (!game.error) open.value = false;
}
</script>

<template>
  <section v-if="game.company" class="card" aria-labelledby="pricing-heading" data-testid="pricing">
    <div class="row-between panel-head">
      <h2 id="pricing-heading">Price</h2>
      <button type="button" :disabled="game.busy || game.over" aria-haspopup="dialog" @click="openModal">
        Change price
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
      <p v-if="draftIncome !== undefined" class="price-preview">
        At today's {{ formatCount(game.company!.paidUsers) }} paying users, that's
        <strong>{{ formatCash(draftIncome) }}</strong> a day.
      </p>
      <p v-if="formError || game.error" class="error" role="alert">{{ formError || game.error }}</p>
      <p class="muted">The new price applies from the next day you play.</p>
      <div class="confirm-buttons">
        <button type="submit" :disabled="game.busy" data-testid="save-price">Set price</button>
        <button type="button" class="ghost" @click="open = false">Cancel</button>
      </div>
    </form>
  </AppModal>
</template>
