import type { StorageAPI } from "@wealthfolio/addon-sdk";
import type { AdanosAccountStatus } from "../types";

const STORAGE_KEY = "adanos_account_status";

interface StoredAccountStatus {
  keySuffix: string;
  status: AdanosAccountStatus;
}

function getKeySuffix(apiKey: string): string {
  return apiKey.slice(-6);
}

export async function loadStoredAccountStatus(
  storage: StorageAPI,
  apiKey: string | null,
): Promise<AdanosAccountStatus | null> {
  if (!apiKey) {
    return null;
  }

  try {
    const raw = await storage.get(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as StoredAccountStatus;
    if (!parsed?.status || parsed.keySuffix !== getKeySuffix(apiKey)) {
      return null;
    }

    return parsed.status;
  } catch {
    return null;
  }
}

export async function saveStoredAccountStatus(
  storage: StorageAPI,
  apiKey: string,
  status: AdanosAccountStatus,
): Promise<void> {
  const payload: StoredAccountStatus = {
    keySuffix: getKeySuffix(apiKey),
    status,
  };

  await storage.set(STORAGE_KEY, JSON.stringify(payload));
}

export async function clearStoredAccountStatus(storage: StorageAPI): Promise<void> {
  await storage.delete(STORAGE_KEY);
}
