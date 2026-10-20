<script setup lang="ts">
import { nextTick, watch } from "vue";
import { useRoute } from "vue-router";
import CapacityPanel from "../../panels/CapacityPanel.vue";
import MigrationPanel from "../../panels/MigrationPanel.vue";
import ServersPanel from "../../panels/ServersPanel.vue";
import StackPanel from "../../panels/StackPanel.vue";

// Infrastructure: load and capacity (on IaaS, CU, DBU and CH, and the servers that give them), who looks after each layer, and migration. A link to #layer-<id>, such as an
// event card's, scrolls to that layer of the stack and focuses it.
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
    <ServersPanel />
    <StackPanel />
    <MigrationPanel class="span-all" />
  </div>
</template>
