<script setup lang="ts">
import { computed } from "vue";
import { formatCash, formatCount } from "../../api";
import { useGame } from "../../game";

// Research: open from the first angel investor's approach, whatever the student made of them. Researchers (hired on
// People) earn research points (RP) a day, banked with no cap. The RP balance and RP a day sit at the top; spending RP
// on tier items comes later.
const game = useGame();
const research = computed(() => game.company?.research ?? null);
const researchers = computed(() => game.staffPool("researchers"));
const midRate = computed(() => game.meta?.staff.find((s) => s.id === "researchers")?.dayRate ?? 0);
</script>

<template>
  <div v-if="game.company && research" class="page-grid single">
    <section class="card" aria-labelledby="research-heading" data-testid="research">
      <h2 id="research-heading">Research</h2>
      <template v-if="research.unlocked">
        <div class="stats">
          <div class="stat">
            <span class="label">Research points</span>
            <span class="value" data-testid="research-points">{{ formatCount(research.points) }} RP</span>
            <small>banked, with no cap</small>
          </div>
          <div class="stat">
            <span class="label">RP a day</span>
            <span class="value" data-testid="research-per-day">{{ formatCount(research.pointsPerDay) }}</span>
            <small>
              from {{ researchers?.headcount ?? 0 }} researcher{{ researchers?.headcount === 1 ? "" : "s" }}
            </small>
          </div>
        </div>
        <p class="muted">
          Researchers earn research points each day: more for seniors, less for juniors. They're permanent hires only, from
          {{ formatCash(midRate) }} a day for a mid. Hire them on
          <RouterLink :to="`${game.base}/people`">People</RouterLink>.
        </p>
        <p class="muted" data-testid="research-later">
          Soon you'll spend research points to unlock new features and model benefits. Until then they bank.
        </p>
      </template>
      <p v-else class="muted" data-testid="research-locked">
        Research opens once your company grows up: when your first angel investor approaches.
      </p>
    </section>
  </div>
</template>
