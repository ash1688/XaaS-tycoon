<script setup lang="ts">
import { computed } from "vue";
import { useGame } from "../game";

// The responsibility stack for the current model: who looks after each layer. Layers that decided today's events, a
// feature gap's layer and, the day a migration completes, the layers that changed hands are highlighted.
const game = useGame();
const OWNER_LABELS = { you: "You", provider: "Provider", shared: "Shared" } as const;
const previousOwners = computed(() => new Map(game.stackFor(game.previousModel).map((l) => [l.id, l.owner])));
</script>

<template>
  <section v-if="game.company && game.stack.length" class="card" aria-labelledby="stack-heading">
    <h2 id="stack-heading" class="panel-head">Who looks after what</h2>
    <ul class="legend" aria-label="Key">
      <li v-for="(label, owner) in OWNER_LABELS" :key="owner"><span :class="['swatch', owner]"></span>{{ label }}</li>
    </ul>
    <p v-if="game.migration" class="muted stack-note" data-testid="stack-note">
      This changes to {{ game.modelName(game.migration.to) }} when your migration completes.
    </p>
    <p v-else-if="game.previousModel" class="stack-note changed-note" data-testid="stack-note">
      Migration complete: moved from {{ game.modelName(game.previousModel) }}. Highlighted layers changed hands.
    </p>
    <p v-if="game.events.length" class="stack-note event-note" data-testid="stack-event-note">
      Today's {{ game.events.length === 1 ? "event was" : "events were" }} decided by the highlighted
      {{ game.eventsByLayer.size === 1 ? "layer" : "layers" }}: whoever owns
      {{ game.eventsByLayer.size === 1 ? "it" : "them" }} has to deal with it.
    </p>
    <ol class="resp-stack" data-testid="stack">
      <li
        v-for="layer in game.stack"
        :id="`layer-${layer.id}`"
        :key="layer.id"
        :class="[
          layer.owner,
          {
            changed: game.previousModel && previousOwners.get(layer.id) !== layer.owner,
            'event-layer': game.eventsByLayer.has(layer.id),
            'gap-layer': game.gapsByLayer.has(layer.id),
          },
        ]"
        :data-layer="layer.id"
        :data-event="game.eventsByLayer.get(layer.id)?.map((e) => e.id).join(' ')"
        :data-gap="game.gapsByLayer.get(layer.id)?.map((g) => g.id).join(' ')"
        tabindex="-1"
      >
        <span class="layer-name">
          {{ layer.name }}
          <small v-for="e in game.eventsByLayer.get(layer.id)" :key="e.id" class="event-tag">{{ e.name }}</small>
          <small v-if="game.gapsByLayer.has(layer.id) && !game.eventsByLayer.has(layer.id)" class="gap-tag">
            Feature gap
          </small>
        </span>
        <span class="owner">
          <small v-if="game.previousModel && previousOwners.get(layer.id) !== layer.owner" class="was">
            was {{ OWNER_LABELS[previousOwners.get(layer.id)!] }}
          </small>
          <strong>{{ OWNER_LABELS[layer.owner] }}</strong>
        </span>
      </li>
    </ol>
  </section>
</template>
