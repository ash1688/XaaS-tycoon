<script setup lang="ts">
import { computed } from "vue";
import type { StaffGrade, StaffPool } from "@xaas/sim";
import { formatCash } from "../api";
import { useGame } from "../game";
import AppModal from "./AppModal.vue";

// Letting go permanent staff costs severance, paid at once: this shows what it comes to before the student confirms.
// Agency staff go with none, so they're let go without asking.
const props = defineProps<{ pool: StaffPool; grade: StaffGrade; count: number; control: string }>();
const open = defineModel<boolean>("open", { default: false });
const game = useGame();

const info = computed(() => game.meta?.staff.find((s) => s.id === props.pool));
const gradeView = computed(() => game.staffPool(props.pool)?.grades.find((g) => g.grade === props.grade));
const who = computed(() => {
  const g = gradeView.value?.name.toLowerCase() ?? props.grade;
  return `${props.count} ${g} ${props.count === 1 ? (info.value?.personName ?? props.pool) : (info.value?.name.toLowerCase() ?? props.pool)}`;
});
const severance = computed(() => props.count * (gradeView.value?.severance ?? 0));
const pay = computed(() => props.count * (gradeView.value?.dayRate ?? 0));
const affordable = computed(() => severance.value <= (game.company?.cash ?? 0));

async function confirm() {
  await game.actFrom(props.control, { type: "letGo", pool: props.pool, grade: props.grade, count: props.count });
  if (!game.error) open.value = false;
}
</script>

<template>
  <AppModal small :open="open" :title="`Let go ${who}?`" @close="open = false">
    <p v-if="game.error" class="error" role="alert">{{ game.error }}</p>
    <table class="quote" data-testid="severance-quote">
      <tbody>
        <tr>
          <th scope="row">Severance <span class="muted">{{ formatCash(gradeView?.severance ?? 0) }} each, paid now</span></th>
          <td data-testid="severance-cost">{{ formatCash(severance) }}</td>
        </tr>
        <tr>
          <th scope="row">Pay you stop</th>
          <td>{{ formatCash(pay) }} a day</td>
        </tr>
      </tbody>
    </table>
    <p v-if="!affordable" class="error" data-testid="severance-short">
      You have {{ formatCash(game.company?.cash ?? 0) }}: not enough to pay their severance.
    </p>
    <p class="muted">
      Permanent staff are paid severance when they go. Agency staff cost more a day but go with none: the cheaper way to
      cover a short gap.
    </p>
    <div class="confirm-buttons">
      <button :disabled="game.busy || !affordable" data-testid="severance-confirm" @click="confirm">
        Let go and pay {{ formatCash(severance) }}
      </button>
      <button class="ghost" :disabled="game.busy" @click="open = false">Keep them</button>
    </div>
  </AppModal>
</template>
