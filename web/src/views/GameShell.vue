<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { formatCash } from "../api";
import { days, provideGame } from "../game";

// The game's frame on every page: the nav bar with the day and Continue, the company's name and the teaching line.
// It loads the company once and shares it with the pages through provideGame, so switching page doesn't re-fetch.
const props = defineProps<{ code: string; id: string }>();
const game = provideGame(props.code, props.id);
game.load();

const route = useRoute();
// The pages, in nav order. A page added later goes here and in the routes in main.ts.
const PAGES = [
  { path: "", name: "Home" },
  { path: "/product", name: "Product" },
  { path: "/infrastructure", name: "Infrastructure" },
  { path: "/people", name: "People" },
  { path: "/customers", name: "Customers" },
  { path: "/finance", name: "Finance" },
];
const onHome = computed(() => route.name === "game-home");
const onFinance = computed(() => route.name === "game-finance");

// Each page visit goes in the playtest log, by its route name: "game-finance" is "finance".
watch(
  () => route.name,
  (name) => typeof name === "string" && game.track("page", { page: name.replace(/^game-/, "") }),
  { immediate: true },
);

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
            <RouterLink :to="`${game.base}${page.path}`" class="nav-link">{{ page.name }}</RouterLink>
          </li>
        </ul>
      </nav>
      <div v-if="game.company" class="day-controls">
        <span class="day-counter">
          <span class="label">Day</span>
          <strong data-testid="day">{{ game.company.day }} <small>of {{ game.company.finalDay }}</small></strong>
        </span>
        <div v-if="game.timedFlow && !game.over" class="timed-flow" data-testid="timed-flow">
          <!-- One button whose label changes, so keyboard focus stays on it. -->
          <button class="ghost play-pause" @click="togglePlay">
            {{ game.playing ? "Pause" : "Play" }}
          </button>
          <p class="muted timed-status" data-testid="timed-status">
            <span v-if="game.playing" role="timer">Next day in {{ game.secondsLeft }}s</span>
            <template v-else>Paused. A day plays every {{ game.timedFlow.seconds }}s.</template>
          </p>
        </div>
        <button
          class="continue"
          :disabled="game.busy || game.over || game.playing"
          :title="game.over ? 'This game has ended' : undefined"
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
      <p v-if="game.over && !onHome" class="readonly-note" data-testid="read-only">
        <span class="badge">Read only</span>
        This game has ended, so nothing here can change.
        <RouterLink :to="game.base">See how it went on Home</RouterLink>.
      </p>
      <RouterView />
    </template>
  </main>
</template>
