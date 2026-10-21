<script setup lang="ts">
import { computed, useId } from "vue";
import { useGameIfAny } from "../game";

// A − / + pair around the current value, which is announced as it changes. Each button says what it does, and when one
// is disabled the reason is shown under it and tied to it, so nobody is left guessing why nothing happens.
// testid: data-testid for the group; the buttons and value get `${testid}-down`, `-up`, `-value` and `-why`.
const props = defineProps<{
  label: string;
  value: string;
  downLabel: string;
  upLabel: string;
  /** Why − can't be used now; set, it disables −. */
  downWhy?: string;
  /** Why + can't be used now; set, it disables +. */
  upWhy?: string;
  disabled?: boolean;
  testid: string;
}>();
const emit = defineEmits<{ down: []; up: [] }>();
const id = useId();
// Each press goes in the playtest log, by the stepper's testid.
const game = useGameIfAny();
function press(value: "down" | "up") {
  game?.track("control", { control: props.testid, value });
  if (value === "down") emit("down");
  else emit("up");
}
const why = computed(() => [props.downWhy, props.upWhy].filter(Boolean).join(" "));
</script>

<template>
  <div class="stepper">
    <div class="counter" role="group" :aria-label="label" :data-testid="testid">
      <button
        class="ghost"
        :disabled="disabled || !!downWhy"
        :aria-label="downLabel"
        :aria-describedby="downWhy ? `${id}-why` : undefined"
        :data-testid="`${testid}-down`"
        @click="press('down')"
      >
        −
      </button>
      <output class="stepper-value" aria-live="polite" :data-testid="`${testid}-value`">{{ value }}</output>
      <button
        class="ghost"
        :disabled="disabled || !!upWhy"
        :aria-label="upLabel"
        :aria-describedby="upWhy ? `${id}-why` : undefined"
        :data-testid="`${testid}-up`"
        @click="press('up')"
      >
        +
      </button>
    </div>
    <p v-if="why" :id="`${id}-why`" class="muted stepper-why" :data-testid="`${testid}-why`">{{ why }}</p>
  </div>
</template>
