<script setup lang="ts">
import { computed } from "vue";
import { useGame } from "../game";

// Launch, once the MVP is done: the company goes live on the next day played. Anything launching would be short of
// (no app server, no database, too few ops) is named above the button, from the same capacity the Infrastructure page
// shows, and the student can still go ahead. Shown on Home, the features panel and the pause banner. On a test or demo
// config that launches by itself, the student can still press it once the MVP is done.
const game = useGame();
const launch = computed(() => {
  const c = game.company;
  return c && !game.over && c.mvp.done && c.launch.day === null ? c.launch : null;
});
const goLive = computed(() => (game.company?.day ?? 0) + 1);
</script>

<template>
  <div v-if="launch" class="launch-action" data-testid="launch-action">
    <ul v-if="launch.missing.length" class="launch-missing warn-text" data-testid="launch-missing">
      <li v-for="m in launch.missing" :key="m">{{ m }}</li>
    </ul>
    <button type="button" :disabled="game.busy" data-testid="launch-button" @click="game.actFrom('launch', { type: 'launch' })">
      {{ launch.missing.length ? "Launch anyway" : "Launch" }}
    </button>
    <p class="muted">Go live on day {{ goLive }}: your first users arrive at the end of it, and hosting bills start then.</p>
  </div>
</template>
