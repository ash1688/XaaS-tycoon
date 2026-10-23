<script setup lang="ts">
import ApiPanel from "../../panels/ApiPanel.vue";
import FeaturesPanel from "../../panels/FeaturesPanel.vue";
import PriceWavePanel from "../../panels/PriceWavePanel.vue";
import PricingPanel from "../../panels/PricingPanel.vue";

// Product: the price, with the wave from the last change while it runs, features to build, or the add-on shop on SaaS,
// and the paid API on a product that has one.
</script>

<template>
  <div class="page-grid single">
    <PricingPanel />
    <PriceWavePanel />
    <FeaturesPanel />
    <ApiPanel />
  </div>
</template>
