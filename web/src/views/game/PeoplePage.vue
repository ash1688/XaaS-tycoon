<script setup lang="ts">
import { formatCash } from "../../api";
import { days, useGame } from "../../game";
import CsuitePanel from "../../panels/CsuitePanel.vue";
import PayHistoryPanel from "../../panels/PayHistoryPanel.vue";
import StaffPanel from "../../panels/StaffPanel.vue";
import { formatShare } from "../../shares";

// People: the staff, the C-suite, what each team does, the staff schemes agreed in pay reviews, and the pay history.
const game = useGame();
</script>

<template>
  <div class="page-grid">
    <StaffPanel />
    <CsuitePanel />
    <section v-if="game.meta && game.company" class="card" aria-labelledby="teams-heading">
      <h2 id="teams-heading">Who does what</h2>
      <ul class="teams">
        <li>
          <strong>Developers</strong>
          <span class="muted">
            Build features, a developer-day of work each a day for a mid. On SaaS they configure add-ons instead.
          </span>
        </li>
        <li>
          <strong>Ops staff</strong>
          <span class="muted">
            Keep the infrastructure running. Too few and capacity is cut. On IaaS and on-prem, every server you run needs a
            share of someone's time. On PaaS and SaaS the provider runs the servers, so a small fixed team keeps the
            service running.
          </span>
        </li>
        <li>
          <strong>Support staff</strong>
          <span class="muted">
            Answer your customers' tickets, on every model, SaaS included. Too few and a backlog builds, satisfaction
            falls and users leave.
          </span>
        </li>
        <li v-if="game.company.research.unlocked" data-testid="researchers-role">
          <strong>Researchers</strong>
          <span class="muted">
            Earn research points each day, shown on Research. Permanent hires only: an agency can't supply them.
          </span>
        </li>
        <li v-if="game.company.campaigns.unlocked" data-testid="marketers-role">
          <strong>Marketers</strong>
          <span class="muted">
            Run your campaigns, one each, planned on Marketing. Seniors bring in more users per pound, juniors fewer.
            Permanent hires only: an agency can't supply them.
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
        Day rates for a mid:
        {{
          game.meta.staff
            .filter((s) => game.company?.staff.some((p) => p.pool === s.id))
            .map((s) => `${s.name.toLowerCase()} ${formatCash(s.dayRate)}`)
            .join(", ")
        }}.
      </p>
      <table class="compare grades-table" data-testid="grades">
        <caption class="muted">Grades, the same in every team</caption>
        <thead>
          <tr><th scope="col">Grade</th><th scope="col">Pay</th><th scope="col">Work</th><th scope="col">Starts</th></tr>
        </thead>
        <tbody>
          <tr v-for="g in game.meta.grades" :key="g.id">
            <th scope="row">{{ g.name }}</th>
            <td>{{ g.payMultiplier }}× a mid's</td>
            <td>{{ g.output }}× a mid's</td>
            <td>{{ g.leadDays === 0 ? "at once" : days(g.leadDays) + " after hiring" }}</td>
          </tr>
          <tr data-testid="agency-terms">
            <th scope="row">Agency</th>
            <td>{{ game.meta.agency.payMultiplier }}× the same grade's</td>
            <td>{{ game.meta.agency.output }}× the same grade's</td>
            <td>{{ game.meta.agency.leadDays === 0 ? "at once" : days(game.meta.agency.leadDays) + " after hiring" }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted" data-testid="severance-terms">
        Agency staff are the dear way to cover a short gap: they start soon and go with no severance. Letting go permanent
        staff pays them {{ game.meta.severanceDays === 1 ? "a day's" : `${game.meta.severanceDays} days'` }} pay each in severance, at once.
      </p>
    </section>
    <section v-if="game.company" class="card" aria-labelledby="schemes-heading" data-testid="staff-schemes">
      <h2 id="schemes-heading">Staff schemes</h2>
      <p class="muted">
        Benefits agreed in pay reviews instead of cash. Each is paid every day for every permanent member of staff, and
        once given can't be lowered or taken away.
      </p>
      <table class="compare">
        <tbody>
          <tr v-for="s in game.company.staffSchemes" :key="s.id" :data-testid="`staff-scheme-${s.id}`">
            <th scope="row">{{ s.name }}</th>
            <td>{{ s.toggle ? (s.level ? "On" : "Off") : `Level ${s.level} of ${s.maxLevel}` }}</td>
            <td>{{ s.level ? `${formatCash(s.costPerDay)} a day` : "—" }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted" data-testid="staff-schemes-total">
        Running cost: {{ formatCash(game.company.staffSchemes.reduce((sum, s) => sum + s.costPerDay, 0)) }} a day.
      </p>
      <p v-if="game.company.payHistory.staffShareScheme" class="muted" data-testid="staff-share-scheme">
        The staff share scheme holds
        {{ game.company.payHistory.staffShareScheme.shares.toLocaleString("en-GB") }} shares from share save:
        {{ formatShare(game.company.payHistory.staffShareScheme.share) }} of the company.
      </p>
    </section>
    <PayHistoryPanel />
  </div>
</template>
