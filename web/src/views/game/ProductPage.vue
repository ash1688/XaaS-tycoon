<script setup lang="ts">
import { computed } from "vue";
import SubTabs from "../../components/SubTabs.vue";
import ApiPanel from "../../panels/ApiPanel.vue";
import FeaturesPanel from "../../panels/FeaturesPanel.vue";
import PriceWavePanel from "../../panels/PriceWavePanel.vue";
import PricingPanel from "../../panels/PricingPanel.vue";
import TiersPanel from "../../panels/TiersPanel.vue";
import { useGame } from "../../game";

// Product, in sub-tabs: the price, with the wave from the last change while it runs; features to build (the MVP and
// the developer time slider among them), or the add-on shop on SaaS; the tiers that unlock them; and the paid API on
// a product that has one. The open tab is in the URL (?tab=features), so a reload or a link keeps it. With none
// given, it's Features until the MVP is done, as that's the work before launch, then Price. Tabs open with their phase
// (#236): Price at Launch, Tiers and the API at Grow. Until features open, the Features tab is the MVP.
const game = useGame();

type TabId = "price" | "features" | "tiers" | "api";
const tabs = computed(() => {
  const list: { id: TabId; name: string }[] = [];
  if (game.isOpen("price")) list.push({ id: "price", name: "Price" });
  list.push({ id: "features", name: !game.isOpen("features") ? "MVP" : game.onSaas ? "Add-ons" : "Features" });
  if (game.isOpen("research")) list.push({ id: "tiers", name: "Tiers" });
  if (game.company?.api && game.isOpen("api")) list.push({ id: "api", name: "API" });
  return list;
});
const fallback = computed<TabId>(() =>
  game.company && !game.company.mvp.done ? "features" : game.isOpen("price") ? "price" : "features",
);
</script>

<template>
  <div class="page-grid single">
    <SubTabs v-slot="{ current }" name="product" label="Product" :tabs="tabs" :fallback="fallback">
      <template v-if="current === 'price'">
        <PricingPanel />
        <PriceWavePanel />
      </template>
      <FeaturesPanel v-else-if="current === 'features'" />
      <TiersPanel v-else-if="current === 'tiers'" />
      <ApiPanel v-else />
    </SubTabs>
  </div>
</template>
