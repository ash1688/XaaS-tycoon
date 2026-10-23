<script setup lang="ts">
import { computed } from "vue";
import { SERVER_SIZES, type RackSize } from "@xaas/sim";
import { formatCash } from "../api";
import { useGame } from "../game";

// On-prem racks: every server is installed in a rack and takes rack units (U) by its size, from the day it's ordered,
// so a growing company buys racks as well as servers. Each rack and server bought is charged cabling on top. IaaS,
// PaaS and SaaS have no racks, so the panel isn't shown there.
const game = useGame();
const racks = computed(() => game.company?.racks ?? null);
const serverCount = (n: number) => `${n} server${n === 1 ? "" : "s"}`;
const unitsTaken = computed(() =>
  racks.value ? SERVER_SIZES.map((size) => `${size} ${racks.value!.serverUnits[size]}U`).join(", ") : "",
);

function buyWhy(price: number, cabling: number) {
  if (game.company && price + cabling > game.company.cash) {
    return `That costs ${formatCash(price + cabling)} with its cabling and you have ${formatCash(game.company.cash)}.`;
  }
  return undefined;
}

async function buy(size: RackSize) {
  await game.act({ type: "buyRack", size });
}
async function sell(id: number) {
  await game.act({ type: "sellRack", id });
}
</script>

<template>
  <section v-if="game.company && racks" class="card" aria-labelledby="racks-heading" data-testid="racks-panel">
    <div class="row-between panel-head">
      <h2 id="racks-heading">Racks</h2>
      <span class="muted">
        <strong data-testid="racks-used">{{ racks.used }}U</strong> of {{ racks.units }}U used
      </span>
    </div>
    <p class="muted">
      Every server goes in a rack and takes rack units (U) by its size: {{ unitsTaken }}. It needs that much free in one
      rack from the day you order it. Most free in any one rack now:
      <strong data-testid="racks-most-free">{{ racks.mostFree }}U</strong>.
    </p>

    <ul class="server-list rack-list">
      <li v-for="r in racks.racks" :key="r.id" :data-testid="`rack-${r.id}`">
        <div class="server-info">
          <strong>Rack #{{ r.id }} · {{ r.size }}</strong>
          <span class="muted">{{ r.used }}U of {{ r.units }}U used · {{ serverCount(r.servers.length) }}</span>
        </div>
        <div
          class="order-meter"
          role="meter"
          :aria-label="`Rack ${r.id} space used`"
          :aria-valuenow="r.used"
          aria-valuemin="0"
          :aria-valuemax="r.units"
        >
          <div class="order-meter-fill" :style="{ width: `${Math.round((100 * r.used) / r.units)}%` }"></div>
        </div>
        <button
          v-if="!r.servers.length"
          class="ghost"
          :disabled="game.busy || game.over"
          :data-testid="`sell-rack-${r.id}`"
          @click="sell(r.id)"
        >
          Sell it for {{ formatCash(r.sellBack) }}
        </button>
      </li>
    </ul>

    <div class="rack-buy">
      <button
        v-for="o in racks.options"
        :key="o.size"
        :disabled="game.busy || game.over || !!buyWhy(o.price, o.cabling)"
        :title="buyWhy(o.price, o.cabling)"
        :data-testid="`buy-rack-${o.size}`"
        @click="buy(o.size)"
      >
        Buy a {{ o.size }} rack ({{ o.units }}U) · {{ formatCash(o.price) }}
      </button>
    </div>
    <p class="muted">
      Racks are installed at once. Cabling is {{ formatCash(racks.options[0]?.cabling ?? 0) }} on top of every rack and
      server you buy. An empty rack sells back at a loss, like a server.
    </p>
    <p class="muted" data-testid="power-and-cooling">
      Power and cooling for your server room: <strong>{{ formatCash(game.company.powerAndCooling) }}</strong> a day.
    </p>
  </section>
</template>

<style scoped>
.rack-list li {
  display: grid;
  grid-template-columns: 1fr minmax(6rem, 10rem) auto;
  align-items: center;
  gap: 0.75rem;
}

.rack-buy {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0.75rem 0;
}

@media (max-width: 600px) {
  .rack-list li {
    grid-template-columns: 1fr;
  }
}
</style>
