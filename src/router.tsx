import {
  redirect,
  createRootRoute,
  createRoute,
  createRouter
} from "@tanstack/react-router";
import { App } from "./App";
import { appPaths } from "./app-routing";
import { authPaths } from "./auth-routing";
import { docsPaths } from "./docs-routing";

const rootRoute = createRootRoute({
  component: App
});

const routePaths = [
  "/",
  ...authPaths,
  ...docsPaths,
  ...appPaths,
  "/admin/machines/$machineId/$machineSection",
  "$"
] as const;

const routes = routePaths.map((path) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    beforeLoad: path === "/reservations" ? () => { throw redirect({ href: "/calendar?mine=1", replace: true }); } : undefined
  })
);

const routeTree = rootRoute.addChildren(routes);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
