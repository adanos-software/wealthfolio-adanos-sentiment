import type { NetworkAPI, NetworkRequest, NetworkResponse } from "@wealthfolio/addon-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  buildUtcDateRange,
  fetchAccountStatus,
  fetchPortfolioSentiment,
  mergeAccountStatuses,
  parseAccountStatusFromError,
  parseAccountStatusFromHeaders,
} from "./adanos-client";

const API_KEY = "placeholder";

function response(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): NetworkResponse {
  return { status, headers, body: JSON.stringify(body) };
}

function networkWith(
  implementation: (request: NetworkRequest) => Promise<NetworkResponse>,
): NetworkAPI & { request: ReturnType<typeof vi.fn> } {
  return { request: vi.fn(implementation) };
}

describe("Adanos network client", () => {
  it("builds inclusive UTC date ranges without the deprecated days parameter", () => {
    const now = new Date("2026-08-25T23:45:00-07:00");

    expect(buildUtcDateRange(1, now)).toEqual({ from: "2026-08-26", to: "2026-08-26" });
    expect(buildUtcDateRange(7, now)).toEqual({ from: "2026-08-20", to: "2026-08-26" });
  });

  it("parses unlimited professional headers case-insensitively", () => {
    expect(
      parseAccountStatusFromHeaders({
        status: 200,
        body: "{}",
        headers: {
          "x-account-type": "professional",
          "x-ratelimit-limit-monthly": "unlimited",
          "x-ratelimit-remaining-monthly": "unlimited",
          "x-ratelimit-used-monthly": "39875",
        },
      }),
    ).toMatchObject({
      status: "active",
      accountType: "professional",
      monthlyLimit: null,
      monthlyRemaining: null,
      monthlyUsed: 39875,
      hasUnlimitedRequests: true,
    });
  });

  it("parses monthly limit exceeded payloads", () => {
    expect(
      parseAccountStatusFromError({
        detail: {
          message: "Free tier limit of 250 requests per month exceeded",
          limit: "250",
          used: "250",
          account_type: "free",
        },
      }),
    ).toMatchObject({
      status: "monthly_limit_exceeded",
      accountType: "free",
      monthlyLimit: 250,
      monthlyRemaining: 0,
      monthlyUsed: 250,
      hasUnlimitedRequests: false,
    });
  });

  it("prefers exhausted quota states when merging", () => {
    const base = {
      accountType: "free" as const,
      monthlyLimit: 250,
      hasUnlimitedRequests: false,
      pricingUrl: "https://adanos.org/pricing",
      apiKeyPersistsAfterUpgrade: true,
    };
    const merged = mergeAccountStatuses([
      {
        ...base,
        status: "active",
        monthlyUsed: 120,
        monthlyRemaining: 130,
        checkedAt: "2026-03-16T20:00:00.000Z",
      },
      {
        ...base,
        status: "monthly_limit_exceeded",
        monthlyUsed: 250,
        monthlyRemaining: 0,
        checkedAt: "2026-03-16T20:00:01.000Z",
      },
    ]);

    expect(merged?.status).toBe("monthly_limit_exceeded");
    expect(merged?.monthlyRemaining).toBe(0);
  });

  it("returns quota status instead of throwing on a brokered 429 response", async () => {
    const network = networkWith(async () =>
      response(
        {
          detail: {
            message: "Free tier limit of 250 requests per month exceeded",
            limit: 250,
            used: 250,
            account_type: "free",
          },
        },
        429,
        {
          "X-Account-Type": "free",
          "X-RateLimit-Limit-Monthly": "250",
          "X-RateLimit-Remaining-Monthly": "0",
          "X-RateLimit-Used-Monthly": "250",
        },
      ),
    );

    await expect(
      fetchAccountStatus(network, API_KEY, new Date("2026-08-25T12:00:00Z")),
    ).resolves.toMatchObject({
      status: "monthly_limit_exceeded",
      accountType: "free",
      monthlyRemaining: 0,
    });
    expect(network.request).toHaveBeenCalledWith({
      url: "https://api.adanos.org/reddit/stocks/v1/compare?tickers=TSLA&from=2026-08-25&to=2026-08-25",
      method: "GET",
      headers: { Accept: "application/json", "X-API-Key": API_KEY },
    });
  });

  it("uses the network broker and explicit dates for each source", async () => {
    const network = networkWith(async ({ url }) => {
      const source = url.includes("/polymarket/") ? "polymarket" : "reddit";
      return response(
        {
          ticker: "TSLA",
          company_name: "Tesla, Inc.",
          found: true,
          buzz_score: source === "reddit" ? 75.2 : 82.9,
          sentiment_score: source === "reddit" ? -0.01 : 0.3,
          bullish_pct: source === "reddit" ? 32 : 30,
          mentions: source === "reddit" ? 650 : undefined,
          trade_count: source === "polymarket" ? 3485 : undefined,
          trend: "falling",
        },
        200,
        {
          "X-Account-Type": "free",
          "X-RateLimit-Limit-Monthly": "250",
          "X-RateLimit-Remaining-Monthly": source === "reddit" ? "245" : "244",
          "X-RateLimit-Used-Monthly": source === "reddit" ? "5" : "6",
        },
      );
    });

    const result = await fetchPortfolioSentiment({
      network,
      apiKey: API_KEY,
      holdings: [
        {
          symbol: "TSLA",
          name: "Tesla, Inc.",
          weight: 12.5,
          marketValueBase: 6900,
          baseCurrency: "EUR",
        },
      ],
      lookbackDays: 7,
      enabledPlatforms: ["reddit", "polymarket"],
      now: new Date("2026-08-25T12:00:00Z"),
    });

    const urls = network.request.mock.calls.map(([request]) => request.url);
    expect(urls).toEqual([
      "https://api.adanos.org/reddit/stocks/v1/stock/TSLA?from=2026-08-19&to=2026-08-25",
      "https://api.adanos.org/polymarket/stocks/v1/stock/TSLA?from=2026-08-19&to=2026-08-25",
    ]);
    expect(network.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        headers: { Accept: "application/json", "X-API-Key": API_KEY },
      }),
    );
    expect(result.holdings[0].platforms).toEqual([
      expect.objectContaining({
        platformId: "reddit",
        buzzScore: 75.2,
        bullishPct: 32,
        activityMetricLabel: "Mentions",
        activityMetricValue: 650,
      }),
      expect.objectContaining({
        platformId: "polymarket",
        buzzScore: 82.9,
        bullishPct: 30,
        activityMetricLabel: "Trades",
        activityMetricValue: 3485,
      }),
    ]);
    expect(result.quota).toMatchObject({ accountType: "free", monthlyRemaining: 244 });
  });
});
