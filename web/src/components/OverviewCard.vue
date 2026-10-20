<script setup lang="ts">
import { ref } from "vue";
import { useGame } from "../game";
import AppModal from "./AppModal.vue";

// A Home card: a glance at one part of the company that opens a modal with the detail and its quick actions. The
// whole card is the button; its title is the button's name and the modal's title. A slice adding a card to Home adds
// one of these, with the glance in the default slot and the detail in #detail.
// tone: "warn" draws the card in the warning colours, for something that needs the student's attention.
// wide: spans two columns on wider screens, for a card with more to show; full: the whole row.
defineProps<{ title: string; tone?: "warn" | "ok"; wide?: boolean; full?: boolean }>();
const game = useGame();
const open = ref(false);
</script>

<template>
  <article :class="['overview-card', tone, { wide, full }]">
    <h3>
      <button type="button" class="card-open" aria-haspopup="dialog" @click="open = true">{{ title }}</button>
    </h3>
    <div class="overview-body">
      <slot />
    </div>
    <span class="card-more" aria-hidden="true">Details →</span>
  </article>
  <AppModal :open="open" :title="title" @close="open = false">
    <p v-if="game.error" class="error" role="alert">{{ game.error }}</p>
    <slot name="detail" />
  </AppModal>
</template>
