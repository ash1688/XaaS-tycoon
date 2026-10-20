<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { TeacherCodeView } from "@xaas/server/api-types";
import { api, RequestError } from "../api";
import LiveDashboard from "../components/LiveDashboard.vue";

const signedIn = ref<boolean>();
const password = ref("");
const error = ref("");
const codes = ref<TeacherCodeView[]>([]);
const busy = ref(false);
const dashboard = ref<InstanceType<typeof LiveDashboard>>();
// The code waiting on the teacher to confirm its deletion.
const confirmingDelete = ref<TeacherCodeView>();

async function loadCodes() {
  codes.value = await api.teacherCodes();
}

onMounted(async () => {
  try {
    await api.teacherMe();
    signedIn.value = true;
    await loadCodes();
  } catch (e) {
    if (!(e instanceof RequestError && e.status === 401)) error.value = (e as Error).message;
    signedIn.value = false;
  }
});

async function signIn() {
  error.value = "";
  busy.value = true;
  try {
    await api.teacherLogin(password.value);
    password.value = "";
    signedIn.value = true;
    await loadCodes();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function signOut() {
  await api.teacherLogout();
  signedIn.value = false;
  codes.value = [];
}

async function createCode() {
  error.value = "";
  busy.value = true;
  try {
    const code = await api.createCode();
    codes.value = [code, ...codes.value];
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

// Archiving or deleting a code changes the dashboard too, so both reload.
async function changeCode(run: () => Promise<unknown>) {
  error.value = "";
  busy.value = true;
  try {
    await run();
    confirmingDelete.value = undefined;
  } catch (e) {
    if (e instanceof RequestError && e.status === 401) signedIn.value = false;
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
  await Promise.all([loadCodes().catch(() => {}), dashboard.value?.load()]);
}

const archiveCode = (code: string) => changeCode(() => api.archiveCode(code));
const deleteCode = (code: string) => changeCode(() => api.deleteCode(code));

const formatCode = (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`;
const formatDate = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
</script>

<template>
  <section v-if="signedIn === false" class="card narrow">
    <h1>Staff dashboard</h1>
    <form @submit.prevent="signIn" class="stack">
      <label for="password">Teacher password</label>
      <input id="password" v-model="password" type="password" autocomplete="current-password" />
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button type="submit" :disabled="busy || !password">Sign in</button>
    </form>
  </section>

  <template v-else-if="signedIn">
    <div class="row-between staff-head">
      <h1>Staff dashboard</h1>
      <div class="staff-head-actions">
        <RouterLink to="/staff/config" class="button-link ghost">Game config</RouterLink>
        <button class="ghost" @click="signOut">Sign out</button>
      </div>
    </div>

    <LiveDashboard ref="dashboard" @signed-out="signedIn = false" @codes-changed="loadCodes().catch(() => {})" />

    <section class="card">
      <h2>Login codes</h2>
      <p class="muted">
        Give each student a code. It takes them to their companies. Archive a code when the class is done: it stops
        working, and it and its games move to the Archived tab above.
      </p>
      <button :disabled="busy" @click="createCode">Create code</button>
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <div v-if="codes.length" class="table-scroll">
        <table class="codes">
          <thead>
            <tr><th>Code</th><th>Companies</th><th>Created</th><th><span class="visually-hidden">Actions</span></th></tr>
          </thead>
          <tbody>
            <tr v-for="c in codes" :key="c.code">
              <td class="mono" :data-code="c.code">{{ formatCode(c.code) }}</td>
              <td>{{ c.companyCount }}</td>
              <td>{{ formatDate(c.createdAt) }}</td>
              <td class="row-actions">
                <button
                  class="ghost small"
                  :disabled="busy"
                  :aria-label="`Archive code ${formatCode(c.code)}`"
                  @click="archiveCode(c.code)"
                >
                  Archive
                </button>
                <button
                  class="ghost small danger"
                  :disabled="busy"
                  :aria-label="`Delete code ${formatCode(c.code)}`"
                  @click="confirmingDelete = c"
                >
                  Delete
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted">No codes yet.</p>

      <div
        v-if="confirmingDelete"
        class="retire-confirm"
        role="group"
        :aria-label="`Delete code ${formatCode(confirmingDelete.code)}?`"
      >
        <p>
          Delete code <strong class="mono">{{ formatCode(confirmingDelete.code) }}</strong> and its
          {{ confirmingDelete.companyCount }} compan{{ confirmingDelete.companyCount === 1 ? "y" : "ies" }} permanently?
          Students can't use the code again, and every game under it is removed. This can't be undone.
        </p>
        <div class="retire-actions">
          <button class="danger-fill" :disabled="busy" @click="deleteCode(confirmingDelete!.code)">
            Yes, delete the code
          </button>
          <button class="ghost" :disabled="busy" @click="confirmingDelete = undefined">Cancel</button>
        </div>
      </div>
    </section>
  </template>
</template>
