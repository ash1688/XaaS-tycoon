<script setup lang="ts">
import FeaturesPanel from "../../panels/FeaturesPanel.vue";
import PriceWavePanel from "../../panels/PriceWavePanel.vue";
import PricingPanel from "../../panels/PricingPanel.vue";

// Product: the price, with the wave from the last change while it runs, and features to build, or the add-on shop on SaaS.
</script>

<template>
  <div class="page-grid single">
    <PricingPanel />
    <PriceWavePanel />
    <FeaturesPanel />
  </div>
</template>
