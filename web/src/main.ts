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
import StaffView from "./views/StaffView.vue";
import StaffCompanyView from "./views/StaffCompanyView.vue";
import "./styles.css";

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
      ],
    },
    { path: "/staff", component: StaffView },
    { path: "/staff/companies/:id", component: StaffCompanyView, props: true },
  ],
  // A new page starts at the top. A link to a #anchor is left to the page, which scrolls to it.
  scrollBehavior: (to, from, saved) => saved ?? (to.hash || to.path === from.path ? false : { top: 0 }),
});

createApp(App).use(router).mount("#app");
