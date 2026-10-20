<script setup lang="ts">
import { useRouter } from "vue-router";
import type { EventView, LayerId } from "@xaas/sim";
import { useGame } from "../game";

// Scripted events on the day just played, and feature gaps still slowing growth. Each names the layer of the
// responsibility stack that decided it, and links to that layer on the Infrastructure page.
const game = useGame();
const router = useRouter();

// The event happened on the model it hit; if a migration completed the same day, the stack has already moved on.
const eventModelNote = (e: EventView) =>
  e.model !== game.company?.model ? ` (you were on ${game.modelName(e.model)})` : "";
const eventTone = (e: EventView) => (e.hit ? "hit" : e.owner === "you" ? "handled" : "covered");
const EVENT_TONES = { hit: "It hurt", handled: "You handled it", covered: "Not your problem" } as const;
const slowerBy = (multiplier: number) => `${Math.round(100 * (1 - multiplier))}%`;

const showLayer = (id: LayerId) => router.push({ path: `${game.base}/infrastructure`, hash: `#layer-${id}` });
</script>

<template>
  <section
    v-for="event in game.events"
    :key="event.id"
    :class="['event-card', event.owner, eventTone(event)]"
    role="status"
    :aria-labelledby="`event-${event.id}`"
    data-testid="event-card"
    :data-event="event.id"
  >
    <p class="event-head">
      <span class="badge">Event</span>
      <strong :id="`event-${event.id}`" class="event-name">{{ event.name }}</strong>
      <span class="event-tone" data-testid="event-tone">{{ EVENT_TONES[eventTone(event)] }}</span>
    </p>
    <p class="event-description">{{ event.description }}</p>
    <p class="event-why">
      <span class="layer-chip">{{ game.layerName(event.layer) }}</span>
      <strong data-testid="event-responsibility">{{ event.responsibility }}</strong>{{ eventModelNote(event) }}
    </p>
    <p class="event-outcome" data-testid="event-outcome">{{ event.outcome }}</p>
    <button type="button" class="link-button" @click="showLayer(event.layer)">
      See {{ game.layerName(event.layer) }} in the stack
    </button>
  </section>

  <section
    v-for="gap in game.openGaps"
    :key="gap.id"
    :class="['feature-gap', gap.owner]"
    role="status"
    :aria-labelledby="`gap-${gap.id}`"
    data-testid="feature-gap"
    :data-event="gap.id"
  >
    <p class="event-head">
      <span class="badge">Feature gap</span>
      <strong :id="`gap-${gap.id}`" class="event-name">{{ gap.name }}</strong>
      <span class="event-tone">Still slowing you down</span>
    </p>
    <p>
      Your customers want <strong>{{ gap.feature }}</strong>, and no add-on offers it. Growth is
      <strong>{{ slowerBy(gap.growthMultiplier) }} slower</strong> every day until you migrate to another model and
      build it yourself.
    </p>
    <button type="button" class="link-button" @click="showLayer(gap.layer)">
      See {{ game.layerName(gap.layer) }} in the stack
    </button>
  </section>
</template>
