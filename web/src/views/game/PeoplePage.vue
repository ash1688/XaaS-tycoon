<script setup lang="ts">
import { formatCash } from "../../api";
import { useGame } from "../../game";
import StaffPanel from "../../panels/StaffPanel.vue";

// People: the staff, and what each team does.
const game = useGame();
</script>

<template>
  <div class="page-grid">
    <StaffPanel />
    <section v-if="game.meta && game.company" class="card" aria-labelledby="teams-heading">
      <h2 id="teams-heading">Who does what</h2>
      <ul class="teams">
        <li>
          <strong>Developers</strong>
          <span class="muted">
            Build features, one developer-day of work each a day. On SaaS they configure add-ons instead.
          </span>
        </li>
        <li>
          <strong>Ops staff</strong>
          <span class="muted">
            Keep the infrastructure running. Too few and capacity is cut. On IaaS and on-prem, every server you run needs a
            share of someone's time.
          </span>
        </li>
        <li>
          <strong>Support staff</strong>
          <span class="muted">
            Answer your customers' tickets, on every model, SaaS included. Too few and a backlog builds, satisfaction
            falls and users leave.
          </span>
        </li>
      </ul>
      <table class="compare ops-by-model">
        <caption class="muted">Ops staff each model needs</caption>
        <tbody>
          <tr v-for="m in game.meta.models" :key="m.id" :class="{ on: m.id === game.company.model }">
            <th scope="row">{{ m.name }}</th>
            <td>
              {{ m.id === game.company.model ? game.company.opsNeeded : m.opsNeeded }}
              <span v-if="m.id === 'iaas'" class="muted">{{ m.id === game.company.model ? "for your VMs" : "to start" }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="muted">
        Day rates:
        {{ game.meta.staff.map((s) => `${s.name.toLowerCase()} ${formatCash(s.dayRate)}`).join(", ") }}.
      </p>
    </section>
  </div>
</template>
