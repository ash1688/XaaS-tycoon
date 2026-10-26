<script setup lang="ts">
import { computed, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import ApiPanel from "../../panels/ApiPanel.vue";
import FeaturesPanel from "../../panels/FeaturesPanel.vue";
import PriceWavePanel from "../../panels/PriceWavePanel.vue";
import PricingPanel from "../../panels/PricingPanel.vue";
import TiersPanel from "../../panels/TiersPanel.vue";
import { useGame } from "../../game";

// Product, in sub-tabs: the price, with the wave from the last change while it runs; features to build (the MVP and
// the developer time slider among them), or the add-on shop on SaaS; the tiers that unlock them; and the paid API on
// a product that has one. The open tab is in the URL (?tab=features), so a reload or a link keeps it. With none
// given, it's Features until the MVP is done, as that's the work before launch, then Price.
const game = useGame();
const route = useRoute();
const router = useRouter();

type TabId = "price" | "features" | "tiers" | "api";
const tabs = computed(() => {
  const list: { id: TabId; name: string }[] = [
    { id: "price", name: "Price" },
    { id: "features", name: game.onSaas ? "Add-ons" : "Features" },
    { id: "tiers", name: "Tiers" },
  ];
  if (game.company?.api) list.push({ id: "api", name: "API" });
  return list;
});
const current = computed<TabId>(() => {
  const asked = tabs.value.find((t) => t.id === route.query.tab);
  if (asked) return asked.id;
  return game.company && !game.company.mvp.done ? "features" : "price";
});

function pick(id: TabId) {
  if (route.query.tab !== id) router.replace({ query: { ...route.query, tab: id }, hash: route.hash });
}

// Arrow keys, Home and End move along the tabs and open the one they land on.
async function onKey(e: KeyboardEvent) {
  const i = tabs.value.findIndex((t) => t.id === current.value);
  const last = tabs.value.length - 1;
  const next =
    e.key === "ArrowRight" ? (i === last ? 0 : i + 1)
    : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1)
    : e.key === "Home" ? 0
    : e.key === "End" ? last
    : null;
  const tab = next === null ? undefined : tabs.value[next];
  if (!tab) return;
  e.preventDefault();
  pick(tab.id);
  await nextTick();
  document.getElementById(`product-tab-${tab.id}`)?.focus();
}
</script>

<template>
  <div class="page-grid single">
    <div class="subtabs" role="tablist" aria-label="Product" data-testid="product-tabs" @keydown="onKey">
      <button
        v-for="t in tabs"
        :id="`product-tab-${t.id}`"
        :key="t.id"
        type="button"
        role="tab"
        :class="['subtab', { on: t.id === current }]"
        :aria-selected="t.id === current"
        :aria-controls="`product-panel-${t.id}`"
        :tabindex="t.id === current ? 0 : -1"
        :data-tab="t.id"
        @click="pick(t.id)"
      >
        {{ t.name }}
      </button>
    </div>
    <div
      :id="`product-panel-${current}`"
      role="tabpanel"
      :aria-labelledby="`product-tab-${current}`"
      class="subtab-panel"
      :data-testid="`product-panel-${current}`"
    >
      <template v-if="current === 'price'">
        <PricingPanel />
        <PriceWavePanel />
      </template>
      <FeaturesPanel v-else-if="current === 'features'" />
      <TiersPanel v-else-if="current === 'tiers'" />
      <ApiPanel v-else />
    </div>
  </div>
</template>
