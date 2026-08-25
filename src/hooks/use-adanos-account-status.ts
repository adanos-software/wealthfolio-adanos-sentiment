import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AddonContext } from "@wealthfolio/addon-sdk";
import { fetchAccountStatus } from "../lib/adanos-client";
import {
  clearStoredAccountStatus,
  loadStoredAccountStatus,
  saveStoredAccountStatus,
} from "../lib/account-status-storage";

export function getAccountStatusQueryKey(apiKey: string | null) {
  return ["adanos-account-status", apiKey ? apiKey.slice(-6) : "missing"] as const;
}

export function useAdanosAccountStatus(ctx: AddonContext, apiKey: string | null) {
  const queryClient = useQueryClient();
  const queryKey = getAccountStatusQueryKey(apiKey);

  const query = useQuery({
    queryKey,
    queryFn: async () => loadStoredAccountStatus(ctx.api.storage, apiKey),
    staleTime: Infinity,
  });

  const mutation = useMutation({
    mutationFn: async (nextApiKey?: string | null) => {
      const effectiveApiKey = nextApiKey?.trim() || apiKey;

      if (!effectiveApiKey) {
        return null;
      }

      const status = await fetchAccountStatus(ctx.api.network, effectiveApiKey);
      await saveStoredAccountStatus(ctx.api.storage, effectiveApiKey, status);
      return status;
    },
  });

  const clearStatus = async () => {
    await clearStoredAccountStatus(ctx.api.storage);
    queryClient.removeQueries({ queryKey: ["adanos-account-status"] });
  };

  const refreshStatus = async (nextApiKey?: string | null) => {
    const effectiveApiKey = nextApiKey?.trim() || apiKey;
    const status = await mutation.mutateAsync(nextApiKey);
    queryClient.setQueryData(getAccountStatusQueryKey(effectiveApiKey ?? null), status);
    return status;
  };

  return {
    accountStatus: query.data ?? null,
    isLoading: query.isLoading,
    isRefreshing: mutation.isPending,
    error: mutation.error as Error | null,
    refreshAccountStatus: refreshStatus,
    clearAccountStatus: clearStatus,
  };
}
