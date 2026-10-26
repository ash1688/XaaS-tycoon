<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { quarterName } from "@xaas/sim";
import { formatCash } from "../api";
import LaunchButton from "../components/LaunchButton.vue";
import PayReviewModal from "../components/PayReviewModal.vue";
import { days, provideGame } from "../game";

// The game's frame on every page: the nav bar with the day and Continue, the company's name and the teaching line.
// It loads the company once and shares it with the pages through provideGame, so switching page doesn't re-fetch.
const props = defineProps<{ code: string; id: string }>();
const game = provideGame(props.code, props.id);
game.load();

const route = useRoute();
// The pages, in nav order. A page added later goes here and in the routes in main.ts. The C-suite has its own page, after
// People. Research and Marketing appear once the first angel investor approaches, as the company grows up.
const PAGES = computed(() => [
  { path: "", name: "Home" },
  { path: "/product", name: "Product" },
  { path: "/infrastructure", name: "Infrastructure" },
  { path: "/people", name: "People" },
  { path: "/csuite", name: "C-suite" },
  ...(game.company?.research.unlocked ? [{ path: "/research", name: "Research" }] : []),
  ...(game.company?.campaigns.unlocked ? [{ path: "/marketing", name: "Marketing" }] : []),
  { path: "/customers", name: "Customers" },
  { path: "/finance", name: "Finance" },
]);
const onHome = computed(() => route.name === "game-home");
const onFinance = computed(() => route.name === "game-finance");
const onBell = computed(() => route.name === "game-ipo");
// An investor who has approached and is waiting for an answer: a notification on every page, and a badge on Finance.
const approach = computed(() => game.company?.investors.offer ?? null);
const vcApproach = computed(() => game.company?.investors.vc.approach ?? null);
// A pay review opens its modal by itself, on any page. Closed to look around, a note opens it again; the game holds
// either way. It stays open after settling, to show what was agreed, until it's closed.
const payModal = ref(false);
watch(
  () => game.payReviewOpen,
  (open) => open && (payModal.value = true),
  { immediate: true },
);

// Each page visit goes in the playtest log, by its route name: "game-finance" is "finance".
watch(
  () => route.name,
  (name) => typeof name === "string" && game.track("page", { page: name.replace(/^game-/, "") }),
  { immediate: true },
);

function changeSpeed(id: string) {
  game.track("control", { control: "timed-speed", value: id });
  game.setSpeed(id as NonNullable<typeof game.speed>["id"]);
}

function togglePlay() {
  game.track("control", { control: "timed-flow", value: game.playing ? "pause" : "play" });
  if (game.playing) game.pause();
  else game.play();
}

// On narrow screens the page links fold away behind a menu button; Continue stays in the bar.
const menuOpen = ref(false);
const menuButton = ref<HTMLButtonElement>();
watch(
  () => route.path,
  () => (menuOpen.value = false),
);
async function closeMenu() {
  if (!menuOpen.value) return;
  menuOpen.value = false;
  await nextTick();
  menuButton.value?.focus();
}
</script>

<template>
  <header class="game-bar">
    <div class="game-bar-inner">
      <RouterLink to="/" class="brand">XaaS Tycoon</RouterLink>
      <nav class="game-nav" aria-label="Game" @keydown.esc="closeMenu">
        <button
          ref="menuButton"
          type="button"
          class="ghost nav-toggle"
          aria-controls="game-nav-links"
          :aria-expanded="menuOpen"
          @click="menuOpen = !menuOpen"
        >
          <span aria-hidden="true">☰</span> Menu
        </button>
        <ul id="game-nav-links" :class="{ open: menuOpen }">
          <li v-for="page in PAGES" :key="page.name">
            <RouterLink :to="`${game.base}${page.path}`" class="nav-link">
              {{ page.name
              }}<span v-if="page.name === 'Finance' && (approach || vcApproach) && !game.over" class="nav-badge" data-testid="finance-badge" aria-hidden="true">1</span>
            </RouterLink>
          </li>
        </ul>
      </nav>
      <div v-if="game.company" class="day-controls">
        <span class="day-counter">
          <span class="label">Day</span>
          <strong data-testid="day">{{ game.company.day }} <small v-if="game.company.finalDay !== null">of {{ game.company.finalDay }}</small></strong>
          <span class="date" data-testid="date">{{ game.company.calendar.today.text }}</span>
        </span>
        <div v-if="game.timedFlow && !game.over && !game.ipoApproved && !game.payReviewOpen" class="timed-flow" data-testid="timed-flow">
          <!-- One button whose label changes, so keyboard focus stays on it. -->
          <button
            class="ghost play-pause"
            :title="game.playing ? 'Stop the clock' : `Play a ${game.tickName} every ${game.speed?.seconds}s on its own`"
            @click="togglePlay"
          >
            {{ game.playing ? "Pause" : "Play" }}
          </button>
          <select
            class="speed"
            aria-label="Speed"
            data-testid="timed-speed"
            :value="game.speed?.id"
            @change="changeSpeed(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="s in game.timedFlow.speeds" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
          <p class="muted timed-status" data-testid="timed-status">
            <span v-if="game.playing" role="timer">Next {{ game.tickName }} in {{ game.secondsLeft }}s</span>
            <template v-else>Paused. Play: a {{ game.tickName }} every {{ game.speed?.seconds }}s. Continue: one {{ game.tickName }} now.</template>
          </p>
        </div>
        <button
          class="continue"
          :disabled="game.busy || game.over || game.playing || game.ipoApproved || game.payReviewOpen"
          :title="
            game.over
              ? 'This game has ended'
              : game.ipoApproved
                ? 'Ring the opening bell first'
                : game.payReviewOpen
                  ? 'Settle the pay review first'
                  : undefined
          "
          :aria-label="game.tickName === 'week' ? 'Continue a week' : 'Continue'"
          @click="game.continueDay()"
        >
          Continue
        </button>
      </div>
    </div>
  </header>

  <main class="page game-page">
    <section v-if="game.loadError" class="card narrow">
      <p class="error" role="alert">{{ game.loadError }}</p>
      <p><RouterLink :to="`/play/${code}`">← Your companies</RouterLink></p>
    </section>
    <template v-else-if="game.company">
      <div class="game-head">
        <p class="back"><RouterLink :to="`/play/${code}`">← Your companies</RouterLink></p>
        <h1>{{ game.company.name }}</h1>
        <p class="muted">{{ game.productName(game.company.productType) }} · {{ game.modelName(game.company.model) }}</p>
        <p class="teaching-line">
          Whatever you pick, your customers get your product as SaaS. You're the customer of the layer below.
        </p>
      </div>
      <p v-if="game.error" class="error game-error" role="alert">{{ game.error }}</p>
      <div v-if="game.pauses.length && !game.over" class="pause-reasons" role="status" data-testid="pause-reasons">
        <span class="badge">Paused</span>
        <p>
          <strong>Time stopped on day {{ game.pausedOnDay }}, {{ game.company.calendar.today.text }},</strong> because
          something needs you:
        </p>
        <ul>
          <li v-for="p in game.pauses" :key="p.id">{{ p.text }}</li>
        </ul>
        <LaunchButton v-if="game.pauses.some((p) => p.id === 'mvp')" />
      </div>
      <div v-if="game.lowCash && game.runway" class="low-cash" role="status" data-testid="low-cash">
        <span class="badge">Low cash</span>
        <p>
          <strong>
            {{ game.runway.days ? `Cash runs out in about ${days(game.runway.days)}.` : "Cash runs out on the next day you play." }}
          </strong>
          You're losing {{ formatCash(-game.runway.dailyNet) }} a day and have {{ formatCash(game.company.cash) }}. <template v-if="game.company.rescue">Below £0
            again there's no second rescue: it's liquidation, and the game ends.</template>
          <template v-else>Below £0 a vulture VC rescues the company, but takes most of it; a second time is
            liquidation.</template>
          <template v-if="game.company.loanQuote">
            Take a {{ formatCash(game.company.loanQuote.amount) }} bank loan now, or cut costs: let staff go or drop servers.
          </template>
          <template v-else>Cut costs now: let staff go or drop servers.</template>
          <RouterLink v-if="!onFinance" :to="`${game.base}/finance`">Open Finance</RouterLink>
        </p>
      </div>
      <p v-if="approach && !game.over" class="ipo-note investor-note" role="status" data-testid="investor-note">
        <span class="badge">Investor</span>
        {{ approach.investor }}, an angel investor, likes what you're doing and wants to invest
        {{ formatCash(approach.amount) }}. Answer by day {{ approach.lastDay }}, or it lapses.
        <RouterLink v-if="!onFinance" :to="`${game.base}/finance`">See their offer on Finance</RouterLink>
        <template v-else>Their offer is below.</template>
      </p>
      <p v-if="vcApproach && !game.over" class="ipo-note investor-note" role="status" data-testid="vc-note">
        <span class="badge">{{ vcApproach.name }}</span>
        Three venture capitalists want to invest. Pick one to negotiate with by day {{ vcApproach.lastDay }}, or their
        offers lapse.
        <RouterLink v-if="!onFinance" :to="`${game.base}/finance`">See their offers on Finance</RouterLink>
        <template v-else>Their offers are below.</template>
      </p>
      <p v-if="game.payReviewOpen && !payModal" class="ipo-note" role="status" data-testid="pay-review-note">
        <span class="badge">Pay review</span>
        Your staff want to talk about pay before {{ quarterName(game.company.payReview!) }}: the game waits until you've
        agreed a rise.
        <button class="ghost" data-testid="pay-review-open" @click="payModal = true">Open the pay review</button>
      </p>
      <p v-if="game.ipoApproved && !onBell" class="ipo-note" role="status" data-testid="ipo-approved-note">
        <span class="badge">IPO approved</span>
        Your company is ready to float. Choose your float and ring the opening bell: the game waits for you.
        <RouterLink :to="`${game.base}/ipo`">Go to the opening bell</RouterLink>
      </p>
      <p v-if="game.over && !onHome && !onBell" class="readonly-note" data-testid="read-only">
        <span class="badge">Read only</span>
        This game has ended, so nothing here can change.
        <RouterLink :to="game.base">See how it went on Home</RouterLink>.
      </p>
      <RouterView />
      <PayReviewModal :open="payModal" @close="payModal = false" />
    </template>
  </main>
</template>
