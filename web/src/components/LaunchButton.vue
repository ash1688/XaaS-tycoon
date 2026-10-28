<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from "vue";
import type { PriceBandsView } from "@xaas/server/api-types";
import { api, formatPrice, formatRate } from "../api";
import { useGame } from "../game";
import AppModal from "./AppModal.vue";
import BandChart from "./BandChart.vue";

// Launch, once the MVP is done: the company goes live on the next day played. Anything launching would be short of
// (no app server, no database, too few ops) is named above the button, from the same capacity the Infrastructure page
// shows, and the student can still go ahead. Pressing it opens the Launch step: the opening price (the fair price to
// start), with a chart of how launch users would split at it, updating as it changes; the price then holds until the
// usual lock after go-live (#257). Shown on Home, the features panel and the pause banner. On a test or demo config
// that launches by itself, the student can still press it once the MVP is done.
const game = useGame();
const id = useId();
const launch = computed(() => {
  const c = game.company;
  return c && !game.over && c.mvp.done && c.launch.day === null ? c.launch : null;
});
const goLive = computed(() => (game.company?.day ?? 0) + 1);
const payments = computed(() => game.company?.payments ?? null);

const open = ref(false);
const draft = ref<number | "">("");
// The payments app's transaction fee, as a percentage (2.5 for 2.5%).
const draftRate = ref<number | "">("");
const formError = ref("");
const bands = ref<PriceBandsView>();
const shareOf = (percent: number) => Math.round(percent * 100) / 10_000;
const rateOrNone = () => (payments.value && typeof draftRate.value === "number" ? shareOf(draftRate.value) : undefined);

// The chart, fetched a moment after the student stops typing; only the latest answer is shown.
let timer: number | undefined;
let seq = 0;
function scheduleBands() {
  window.clearTimeout(timer);
  const mine = ++seq;
  const price = draft.value;
  if (typeof price !== "number" || price < 0) {
    bands.value = undefined;
    return;
  }
  timer = window.setTimeout(async () => {
    try {
      const result = await api.launchBands(game.code, game.id, price, rateOrNone());
      if (mine === seq) bands.value = result;
    } catch {
      if (mine === seq) bands.value = undefined;
    }
  }, 250);
}
watch([draft, draftRate], () => open.value && scheduleBands());
onBeforeUnmount(() => window.clearTimeout(timer));

const percent = (share: number) => `${Math.round(100 * share)}%`;
const share = (id: string) => bands.value?.total.find((b) => b.id === id)?.share ?? 0;

function openModal() {
  const c = game.company;
  draft.value = c?.fairPrice ?? "";
  draftRate.value = c?.payments ? Math.round(c.payments.fairRate * 10_000) / 100 : "";
  formError.value = "";
  open.value = true;
  scheduleBands();
}

async function confirm() {
  const price = draft.value;
  if (typeof price !== "number" || price < 0 || (!payments.value && !(price > 0))) {
    formError.value = payments.value ? "Enter a monthly fee of £0 or more." : "Enter an opening price above £0.";
    return;
  }
  formError.value = "";
  const rate = rateOrNone();
  await game.actFrom("launch", { type: "launch", price, ...(rate === undefined ? {} : { rate }) });
  if (!game.error) open.value = false;
}
</script>

<template>
  <div v-if="launch" class="launch-action" data-testid="launch-action">
    <ul v-if="launch.missing.length" class="launch-missing warn-text" data-testid="launch-missing">
      <li v-for="m in launch.missing" :key="m">{{ m }}</li>
    </ul>
    <button type="button" :disabled="game.busy" aria-haspopup="dialog" data-testid="launch-button" @click="openModal">
      {{ launch.missing.length ? "Launch anyway" : "Launch" }}
    </button>
    <p class="muted">Go live on day {{ goLive }}: your first users arrive at the end of it, and hosting bills start then.</p>
  </div>

  <AppModal :open="open" title="Launch at an opening price" @close="open = false">
    <form class="price-form" novalidate data-testid="launch-dialog" @submit.prevent="confirm">
      <label :for="`${id}-price`">{{ payments ? "Opening monthly fee per paying business (£)" : "Opening monthly price per paying user (£)" }}</label>
      <input :id="`${id}-price`" v-model.number="draft" type="number" inputmode="decimal" min="0" step="0.01" data-testid="launch-price-input" />
      <template v-if="payments">
        <label :for="`${id}-rate`">Transaction fee (% of every payment)</label>
        <input :id="`${id}-rate`" v-model.number="draftRate" type="number" inputmode="decimal" min="0" step="0.01" data-testid="launch-rate-input" />
      </template>
      <p class="muted price-hint">
        Fair price: <strong>{{ formatPrice(game.company!.fairPrice) }}</strong> a month<template v-if="payments">
          plus {{ formatRate(payments.fairRate) }} of every payment</template
        >. Launch users react to your opening price: above the fair price fewer join, and fewer of those who do pay.
      </p>
      <BandChart v-if="bands" :bands="bands" caption="How launch users would split, by customer type" />
      <p v-if="bands" class="muted" data-testid="launch-bands-summary">
        Of every 100 launch users, about {{ percent(share("joinPaid")) }} would join paying,
        {{ percent(share("joinFree")) }} free, and {{ percent(share("notJoin")) }} wouldn't join.
      </p>
      <p class="muted">
        Your price holds from now until {{ game.meta?.priceLockDays ?? 14 }} days after go-live on day {{ goLive }}: you
        can't change it until then.
      </p>
      <p v-if="formError || game.error" class="error" role="alert">{{ formError || game.error }}</p>
      <div class="confirm-buttons">
        <button type="submit" :disabled="game.busy" data-testid="launch-confirm">
          {{ launch?.missing.length ? "Launch anyway" : "Launch" }}
        </button>
        <button type="button" class="ghost" @click="open = false">Cancel</button>
      </div>
    </form>
  </AppModal>
</template>
