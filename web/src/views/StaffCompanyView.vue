<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { MetaView, TeacherSummaryView } from "@xaas/server/api-types";
import { api, RequestError } from "../api";
import SummaryPanel from "../components/SummaryPanel.vue";

// A company's summary, opened from the live dashboard. Read-only: the teacher watches, the student plays.
const props = defineProps<{ id: string }>();

const meta = ref<MetaView>();
const data = ref<TeacherSummaryView>();
const error = ref("");
const signedOut = ref(false);

const modelName = (id: string) => meta.value?.models.find((m) => m.id === id)?.name ?? id;
const formatCode = (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`;

onMounted(async () => {
  try {
    [meta.value, data.value] = await Promise.all([api.meta(), api.teacherSummary(props.id)]);
  } catch (e) {
    if (e instanceof RequestError && e.status === 401) signedOut.value = true;
    else error.value = (e as Error).message;
  }
});
</script>

<template>
  <p class="back"><RouterLink to="/staff">← Staff dashboard</RouterLink></p>
  <section v-if="signedOut" class="card narrow">
    <p>Your staff session has ended. <RouterLink to="/staff">Sign in again</RouterLink> to see this company.</p>
  </section>
  <p v-else-if="error" class="error" role="alert">{{ error }}</p>
  <template v-else-if="data">
    <p class="muted staff-company-code">
      Code <span class="mono">{{ formatCode(data.code) }}</span> · Preset
      <strong data-testid="company-preset">{{ data.preset }}</strong> · In the playtest logs as
      <strong>{{ data.player }}</strong> ·
      <RouterLink :to="`/staff/companies/${id}/timeline`">Activity timeline</RouterLink>
    </p>
    <SummaryPanel :summary="data.summary" :model-name="modelName(data.summary.model)" :retired="data.status === 'retired'" />
  </template>
</template>
