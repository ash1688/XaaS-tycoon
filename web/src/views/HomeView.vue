<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api";

const LAST_CODE_KEY = "xaas:last-code";

function readLastCode() {
  try {
    return localStorage.getItem(LAST_CODE_KEY) ?? "";
  } catch {
    return "";
  }
}

const router = useRouter();
const code = ref(readLastCode());
const error = ref("");
const busy = ref(false);

async function submit() {
  const value = code.value.replace(/\s/g, "");
  error.value = "";
  if (!/^\d{8}$/.test(value)) {
    error.value = "Your code is 8 digits.";
    return;
  }
  busy.value = true;
  try {
    await api.code(value);
    try {
      localStorage.setItem(LAST_CODE_KEY, value);
    } catch {}
    await router.push(`/play/${value}`);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="card narrow">
    <h1>Enter your code</h1>
    <p class="muted">Your teacher gives you an 8-digit code. It takes you to your companies.</p>
    <form @submit.prevent="submit" class="stack">
      <label for="code">Login code</label>
      <input
        id="code"
        v-model="code"
        inputmode="numeric"
        autocomplete="off"
        maxlength="9"
        placeholder="12345678"
        class="code-input"
      />
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button type="submit" :disabled="busy">Go</button>
    </form>
  </section>
  <p class="footer-link"><RouterLink to="/staff">Staff dashboard</RouterLink></p>
</template>
