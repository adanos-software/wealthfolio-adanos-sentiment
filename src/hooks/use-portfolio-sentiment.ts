import { useQuery } from "@tanstack/react-query";
import type { AddonContext } from "@wealthfolio/addon-sdk";
import React from "react";
import { fetchPortfolioSentiment } from "../lib/adanos-client";
import { saveStoredAccountStatus } from "../lib/account-status-storage";
import { buildTrackedHoldings } from "../lib/utils";
import type { AdanosPreferences, PortfolioSentimentResult } from "../types";

interface UsePortfolioSentimentArgs {
  ctx: AddonContext;
  apiKey: string | null;
  preferences: AdanosPreferences;
}

export function usePortfolioSentiment({ ctx, apiKey, preferences }: UsePortfolioSentimentArgs) {
  const query = useQuery<PortfolioSentimentResult>({
    queryKey: [
      "adanos-portfolio-sentiment",
      apiKey ? apiKey.slice(-6) : "missing",
      preferences.lookbackDays,
      preferences.enabledPlatforms.join(","),
    ],
    queryFn: async () => {
      const holdings = await ctx.api.portfolio.getHoldings("TOTAL");
      const trackedHoldings = buildTrackedHoldings(holdings);

      if (!apiKey) {
        throw new Error("Adanos API key is not configured.");
      }

      if (trackedHoldings.length === 0) {
        return {
          holdings: [],
          errors: [],
          fetchedAt: new Date().toISOString(),
          quota: null,
        };
      }

      return fetchPortfolioSentiment({
        network: ctx.api.network,
        apiKey,
        holdings: trackedHoldings,
        lookbackDays: preferences.lookbackDays,
        enabledPlatforms: preferences.enabledPlatforms,
      });
    },
    enabled: Boolean(apiKey),
    staleTime: 60 * 1000,
    gcTime: 5 * 60 * 1000,
  });

  React.useEffect(() => {
    if (apiKey && query.data?.quota) {
      void saveStoredAccountStatus(ctx.api.storage, apiKey, query.data.quota).catch((error) => {
        ctx.api.logger.warn(
          "Failed to cache Adanos account status: " + (error as Error).message,
        );
      });
    }
  }, [apiKey, ctx.api.logger, ctx.api.storage, query.data?.quota]);

  return query;
}
