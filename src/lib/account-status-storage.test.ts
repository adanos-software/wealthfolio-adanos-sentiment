import type { StorageAPI } from "@wealthfolio/addon-sdk";
import { describe, expect, it, vi } from "vitest";
import type { AdanosAccountStatus } from "../types";
import {
  clearStoredAccountStatus,
  loadStoredAccountStatus,
  saveStoredAccountStatus,
} from "./account-status-storage";

function createStorage(): StorageAPI {
  const values = new Map<string, string>();
  return {
    get: vi.fn(async (key) => values.get(key) ?? null),
    set: vi.fn(async (key, value) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key) => {
      values.delete(key);
    }),
  };
}

describe("account status storage", () => {
  it("uses Wealthfolio storage and isolates cached status by API-key suffix", async () => {
    const storage = createStorage();
    const status: AdanosAccountStatus = {
      status: "active",
      accountType: "free",
      monthlyLimit: 250,
      monthlyUsed: 10,
      monthlyRemaining: 240,
      hasUnlimitedRequests: false,
      pricingUrl: "https://adanos.org/pricing",
      apiKeyPersistsAfterUpgrade: true,
      checkedAt: "2026-08-25T12:00:00.000Z",
    };

    await saveStoredAccountStatus(storage, "test-key-abcdef", status);

    await expect(loadStoredAccountStatus(storage, "test-key-abcdef")).resolves.toEqual(status);
    await expect(loadStoredAccountStatus(storage, "test-key-other0")).resolves.toBeNull();

    await clearStoredAccountStatus(storage);
    await expect(loadStoredAccountStatus(storage, "test-key-abcdef")).resolves.toBeNull();
  });
});
