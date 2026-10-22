<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import { useGameIfAny } from "../game";

// A modal dialog: labelled by its title, keeps keyboard focus inside while open, closes on Escape, the close button or
// a click on the backdrop, and hands focus back to whatever opened it. The rest of the page is inert while it's open.
// A backdrop click straight after opening is ignored: it's the second click of a double-click on whatever opened it,
// which used to close the modal before it could be read.
const props = defineProps<{ open: boolean; title: string }>();
const emit = defineEmits<{ close: [] }>();

const id = useId();
const dialog = ref<HTMLElement>();
let trigger: HTMLElement | null = null;
// In a game, each modal goes in the playtest log when it closes, with how long it was open.
const game = useGameIfAny();
let openedAt = 0;

const BACKDROP_GRACE_MS = 500;
function onBackdrop() {
  if (Date.now() - openedAt < BACKDROP_GRACE_MS) return;
  emit("close");
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const focusables = () =>
  [...(dialog.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((el) => !el.closest("fieldset:disabled"));

function setPageInert(inert: boolean) {
  const app = document.getElementById("app");
  if (app) app.inert = inert;
  document.body.classList.toggle("modal-open", inert);
}

async function opened() {
  openedAt = Date.now();
  trigger = document.activeElement as HTMLElement | null;
  setPageInert(true);
  await nextTick();
  // The first control after the close button, so the student lands on the content; the dialog itself if there's none.
  const [, first] = focusables();
  (first ?? dialog.value)?.focus();
}

function closed() {
  // Only one that was open: the watch also runs once on mount, closed.
  if (openedAt) game?.track("modal", { modal: props.title, ms: Date.now() - openedAt });
  openedAt = 0;
  setPageInert(false);
  if (trigger?.isConnected) trigger.focus();
  trigger = null;
}

watch(
  () => props.open,
  (open) => (open ? opened() : closed()),
  { immediate: true },
);
onBeforeUnmount(() => props.open && closed());

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    emit("close");
  } else if (e.key === "Tab") {
    const els = focusables();
    if (!els.length) return e.preventDefault();
    const [first, last] = [els[0]!, els.at(-1)!];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialog.value)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @mousedown.self="onBackdrop">
      <div
        ref="dialog"
        class="modal"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="`${id}-title`"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <header class="modal-head">
          <h2 :id="`${id}-title`">{{ title }}</h2>
          <button type="button" class="ghost modal-close" aria-label="Close" @click="emit('close')">✕</button>
        </header>
        <div class="modal-body">
          <slot />
        </div>
      </div>
    </div>
  </Teleport>
</template>
