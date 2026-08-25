import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { AddonContext, AddonEnableFunction } from "@wealthfolio/addon-sdk";
import type { ReactNode } from "react";
import DashboardPage from "./pages/dashboard-page";
import SettingsPage from "./pages/settings-page";

let addonCtx: AddonContext | undefined;

const withProviders = (page: ReactNode) => (
  <QueryClientProvider client={addonCtx!.api.query.getClient() as QueryClient}>
    {page}
  </QueryClientProvider>
);

const DashboardRoute = () => withProviders(<DashboardPage ctx={addonCtx!} />);
const SettingsRoute = () => withProviders(<SettingsPage ctx={addonCtx!} />);

const enable: AddonEnableFunction = (context) => {
  addonCtx = context;
  context.api.logger.info("Adanos Sentiment addon is being enabled");

  try {
    context.router.add({
      id: "adanos-sentiment",
      path: "/addons/adanos-sentiment",
      component: DashboardRoute,
    });

    context.router.add({
      id: "adanos-sentiment-settings",
      path: "/addons/adanos-sentiment/settings",
      component: SettingsRoute,
    });

    context.api.logger.info("Adanos Sentiment addon enabled successfully");
  } catch (error) {
    context.api.logger.error(
      "Failed to initialize Adanos Sentiment addon: " + (error as Error).message,
    );
    throw error;
  }

  context.onDisable(() => {
    context.api.logger.info("Adanos Sentiment addon is being disabled");
    addonCtx = undefined;
  });
};

export default enable;
