<script setup lang="ts">
import { computed } from "vue";
import { formatCount, formatPrice } from "../api";
import { days, useGame } from "../game";
import WaveChart from "../components/WaveChart.vue";

// The price wave under way: how far it has got, what it has done to users so far and what's still to come, and the
// lock countdown. Shown on Product, on Customers and in the Home card while a wave runs.
const game = useGame();
const wave = computed(() => game.company?.priceWave ?? null);
const rise = computed(() => wave.value?.direction === "rise");
</script>

<template>
  <section v-if="wave" :class="['card', 'price-wave', wave.direction]" aria-labelledby="wave-heading" data-testid="price-wave">
    <div class="row-between panel-head">
      <h2 id="wave-heading">{{ rise ? "Price rise backlash" : "Price cut wave" }}</h2>
      <span class="badge">{{ formatPrice(wave.from) }} → {{ formatPrice(wave.to) }}</span>
    </div>
    <p data-testid="wave-progress">
      <template v-if="wave.day === 0">
        Starts tomorrow and runs for {{ days(wave.length) }}.
      </template>
      <template v-else>
        Day {{ wave.day }} of {{ wave.length }}: {{ days(wave.remaining) }} to go.
      </template>
      {{
        rise
          ? "Customers are reacting to your rise: some paying users leave, some drop to free, and complaints add support tickets."
          : "Word of your cut is spreading: new users join and some free users start paying."
      }}
    </p>
    <div
      class="meter"
      role="meter"
      aria-label="Wave progress"
      aria-valuemin="0"
      :aria-valuemax="wave.length"
      :aria-valuenow="wave.day"
    >
      <div :class="['meter-fill', rise ? 'over' : 'ok']" :style="{ width: `${(100 * wave.day) / wave.length}%` }"></div>
    </div>
    <div class="stats">
      <template v-if="rise">
        <div class="stat">
          <span class="label">Paying users left</span>
          <span class="value neg" data-testid="wave-left">{{ formatCount(wave.done.left) }}</span>
          <small>of {{ formatCount(wave.total.left) }} expected</small>
        </div>
        <div class="stat">
          <span class="label">Dropped to free</span>
          <span class="value" data-testid="wave-to-free">{{ formatCount(wave.done.toFree) }}</span>
          <small>of {{ formatCount(wave.total.toFree) }} expected</small>
        </div>
        <div class="stat">
          <span class="label">Backlash tickets</span>
          <span class="value">{{ formatCount(wave.done.tickets) }}</span>
          <small>of {{ formatCount(wave.total.tickets) }} expected</small>
        </div>
      </template>
      <template v-else>
        <div class="stat">
          <span class="label">New users</span>
          <span class="value pos" data-testid="wave-joined">{{ formatCount(wave.done.joined) }}</span>
          <small>of {{ formatCount(wave.total.joined) }} expected</small>
        </div>
        <div class="stat">
          <span class="label">Upgraded to paid</span>
          <span class="value pos" data-testid="wave-upgraded">{{ formatCount(wave.done.upgraded) }}</span>
          <small>of {{ formatCount(wave.total.upgraded) }} expected</small>
        </div>
      </template>
    </div>
    <WaveChart :days="wave.days" :direction="wave.direction" :played="wave.day" />
    <p v-if="game.company!.priceLockDaysLeft" class="muted" data-testid="wave-lock">
      Price locked for {{ days(game.company!.priceLockDaysLeft) }} more.
    </p>
  </section>
</template>
