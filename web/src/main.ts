import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import HomeView from "./views/HomeView.vue";
import CompaniesView from "./views/CompaniesView.vue";
import GameView from "./views/GameView.vue";
import StaffView from "./views/StaffView.vue";
import "./styles.css";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: HomeView },
    { path: "/play/:code", component: CompaniesView, props: true },
    { path: "/play/:code/:id", component: GameView, props: true },
    { path: "/staff", component: StaffView },
  ],
});

createApp(App).use(router).mount("#app");
