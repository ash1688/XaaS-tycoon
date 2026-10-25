<script setup lang="ts">
import { nextTick, watch } from "vue";
import { useRoute } from "vue-router";
import BenefitsPanel from "../../panels/BenefitsPanel.vue";
import CapacityPanel from "../../panels/CapacityPanel.vue";
import DriftPanel from "../../panels/DriftPanel.vue";
import HardwarePanel from "../../panels/HardwarePanel.vue";
import MigrationPanel from "../../panels/MigrationPanel.vue";
import PlatformPanel from "../../panels/PlatformPanel.vue";
import RacksPanel from "../../panels/RacksPanel.vue";
import ServersPanel from "../../panels/ServersPanel.vue";
import StackPanel from "../../panels/StackPanel.vue";
import { useGame } from "../../game";

// Infrastructure: load and capacity (CU, DBU and CH, and the servers that give them: bought on-prem, rented on IaaS,
// instances and managed services on PaaS; on SaaS, the provider's), on-prem the racks they go in and each server's
// hardware slider, the model's benefits, in a long game how prices and kit drift each year, who looks after each
// layer, and migration. A link
// to #layer-<id>, such as an event card's, scrolls to that layer of the stack and focuses it.
const game = useGame();
const route = useRoute();
watch(
  () => route.hash,
  async (hash) => {
    if (!hash.startsWith("#layer-")) return;
    await nextTick();
    const el = document.getElementById(hash.slice(1));
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.focus({ preventScroll: true });
  },
  { immediate: true },
);
</script>

<template>
  <div class="page-grid">
    <CapacityPanel />
    <PlatformPanel v-if="game.managed" />
    <ServersPanel v-else />
    <RacksPanel v-if="game.company?.racks" />
    <HardwarePanel />
    <BenefitsPanel />
    <DriftPanel />
    <StackPanel />
    <MigrationPanel class="span-all" />
  </div>
</template>
