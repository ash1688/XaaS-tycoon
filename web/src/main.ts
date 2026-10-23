import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import HomeView from "./views/HomeView.vue";
import CompaniesView from "./views/CompaniesView.vue";
import GameShell from "./views/GameShell.vue";
import GameHome from "./views/game/GameHome.vue";
import ProductPage from "./views/game/ProductPage.vue";
import InfrastructurePage from "./views/game/InfrastructurePage.vue";
import PeoplePage from "./views/game/PeoplePage.vue";
import CustomersPage from "./views/game/CustomersPage.vue";
import FinancePage from "./views/game/FinancePage.vue";
import OpeningBellPage from "./views/game/OpeningBellPage.vue";
import "./styles.css";

// The staff pages load on demand: students never open them, so they stay out of the bundle every student downloads.
const StaffView = () => import("./views/StaffView.vue");
const StaffCompanyView = () => import("./views/StaffCompanyView.vue");
const StaffConfigView = () => import("./views/StaffConfigView.vue");
const StaffTimelineView = () => import("./views/StaffTimelineView.vue");

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: HomeView },
    { path: "/play/:code", component: CompaniesView, props: true },
    {
      // The game shell loads the company once; each page is a child route, so it can be bookmarked.
      path: "/play/:code/:id",
      component: GameShell,
      props: true,
      meta: { game: true },
      children: [
        { path: "", name: "game-home", component: GameHome },
        { path: "product", name: "game-product", component: ProductPage },
        { path: "infrastructure", name: "game-infrastructure", component: InfrastructurePage },
        { path: "people", name: "game-people", component: PeoplePage },
        { path: "customers", name: "game-customers", component: CustomersPage },
        { path: "finance", name: "game-finance", component: FinancePage },
        // The opening bell, reached from the IPO readiness checklist on Finance once the IPO is approved.
        { path: "ipo", name: "game-ipo", component: OpeningBellPage },
      ],
    },
    // Wide, so the live dashboard's columns fit on a projector.
    { path: "/staff", component: StaffView, meta: { wide: true } },
    { path: "/staff/companies/:id", component: StaffCompanyView, props: true },
    { path: "/staff/companies/:id/timeline", component: StaffTimelineView, props: true },
    { path: "/staff/config", component: StaffConfigView },
  ],
  // A new page starts at the top. A link to a #anchor is left to the page, which scrolls to it.
  scrollBehavior: (to, from, saved) => saved ?? (to.hash || to.path === from.path ? false : { top: 0 }),
});

createApp(App).use(router).mount("#app");
