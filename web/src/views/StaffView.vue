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
      <button class="ghost" @click="signOut">Sign out</button>
    </div>

    <LiveDashboard @signed-out="signedIn = false" />

    <section class="card">
      <h2>Login codes</h2>
      <p class="muted">Give each student a code. It takes them to their companies.</p>
      <button :disabled="busy" @click="createCode">Create code</button>
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <table v-if="codes.length" class="codes">
        <thead>
          <tr><th>Code</th><th>Companies</th><th>Created</th></tr>
        </thead>
        <tbody>
          <tr v-for="c in codes" :key="c.code">
            <td class="mono" :data-code="c.code">{{ formatCode(c.code) }}</td>
            <td>{{ c.companyCount }}</td>
            <td>{{ formatDate(c.createdAt) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">No codes yet.</p>
    </section>
  </template>
</template>
