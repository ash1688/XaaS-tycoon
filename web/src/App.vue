<script setup lang="ts">
import { useRoute } from "vue-router";

// The game has its own bar, with the page nav and Continue, so it replaces the plain top bar.
const route = useRoute();
</script>

<template>
  <!-- Keyed by company, so opening another company loads it afresh; switching page within one keeps the shell. -->
  <RouterView v-if="route.meta.game" :key="`${route.params.code}/${route.params.id}`" />
  <template v-else>
    <header class="topbar">
      <RouterLink to="/" class="brand">XaaS Tycoon</RouterLink>
    </header>
    <main class="page">
      <RouterView />
    </main>
  </template>
</template>
