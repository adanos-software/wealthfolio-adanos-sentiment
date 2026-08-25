import type { NetworkAPI, NetworkResponse } from "@wealthfolio/addon-sdk";
import type {
  AdanosAccountStatus,
  AdanosAccountType,
  AdanosPlatformId,
  PlatformSnapshot,
  PortfolioSentimentResult,
  PortfolioSentimentRow,
  StockDetailRow,
  TrackedHolding,
} from "../types";
import {
  ADANOS_PRICING_URL,
  PLATFORM_ORDER,
  buildCompositeSignal,
  isMonthlyLimitExceededMessage,
} from "./utils";

const ADANOS_BASE_URL = "https://api.adanos.org";

const PLATFORM_CONFIG: Record<
  AdanosPlatformId,
  {
    label: string;
    stockPath: string;
    activityMetricLabel: string;
    activityMetricKey: keyof StockDetailRow;
  }
> = {
  reddit: {
    label: "Reddit",
    stockPath: "/reddit/stocks/v1/stock",
    activityMetricLabel: "Mentions",
    activityMetricKey: "mentions",
  },
  x: {
    label: "X.com",
    stockPath: "/x/stocks/v1/stock",
    activityMetricLabel: "Mentions",
    activityMetricKey: "mentions",
  },
  news: {
    label: "News",
    stockPath: "/news/stocks/v1/stock",
    activityMetricLabel: "Mentions",
    activityMetricKey: "mentions",
  },
  polymarket: {
    label: "Polymarket",
    stockPath: "/polymarket/stocks/v1/stock",
    activityMetricLabel: "Trades",
    activityMetricKey: "trade_count",
  },
};

interface FetchPortfolioSentimentArgs {
  network: NetworkAPI;
  apiKey: string;
  holdings: TrackedHolding[];
  lookbackDays: number;
  enabledPlatforms: AdanosPlatformId[];
  now?: Date;
}

interface CompareResult {
  response: StockDetailRow;
  accountStatus: AdanosAccountStatus | null;
}

class AdanosRequestError extends Error {
  accountStatus: AdanosAccountStatus | null;

  constructor(message: string, accountStatus: AdanosAccountStatus | null = null) {
    super(message);
    this.name = "AdanosRequestError";
    this.accountStatus = accountStatus;
  }
}

export async function fetchAccountStatus(
  network: NetworkAPI,
  apiKey: string,
  now = new Date(),
): Promise<AdanosAccountStatus> {
  const url = new URL(`${ADANOS_BASE_URL}/reddit/stocks/v1/compare`);
  const dateRange = buildUtcDateRange(1, now);
  url.searchParams.set("tickers", "TSLA");
  url.searchParams.set("from", dateRange.from);
  url.searchParams.set("to", dateRange.to);

  const response = await network.request({
    url: url.toString(),
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-API-Key": apiKey,
    },
  });

  const accountStatusFromHeaders = parseAccountStatusFromHeaders(response);

  if (!isSuccessful(response.status)) {
    const errorPayload = readJsonSafely(response);
    const accountStatusFromError = parseAccountStatusFromError(errorPayload);
    const mergedAccountStatus = mergeAccountStatuses(
      [accountStatusFromHeaders, accountStatusFromError].filter(
        (status): status is AdanosAccountStatus => status !== null,
      ),
    );

    if (mergedAccountStatus) {
      return mergedAccountStatus;
    }

    throw new AdanosRequestError(`Account status: ${extractErrorMessage(errorPayload, response.status)}`);
  }

  if (!accountStatusFromHeaders) {
    throw new Error("Account status headers missing from Adanos response.");
  }

  return accountStatusFromHeaders;
}

function resolveActivityMetricValue(
  stock: StockDetailRow | undefined,
  metricKey: keyof StockDetailRow,
): number | null {
  if (!stock) {
    return null;
  }
  if (metricKey === "mentions") {
    return asNumber(stock.mentions ?? stock.total_mentions);
  }
  return asNumber(stock[metricKey]);
}

export async function fetchPortfolioSentiment({
  network,
  apiKey,
  holdings,
  lookbackDays,
  enabledPlatforms,
  now = new Date(),
}: FetchPortfolioSentimentArgs): Promise<PortfolioSentimentResult> {
  const tickers = holdings.map((holding) => holding.symbol);
  const platforms = PLATFORM_ORDER.filter((platformId) => enabledPlatforms.includes(platformId));

  const settledResponses = await Promise.allSettled(
    platforms.flatMap((platformId) =>
      tickers.map(async (ticker) => ({
        platformId,
        ticker,
        response: await fetchStock(network, apiKey, platformId, ticker, lookbackDays, now),
      })),
    ),
  );

  const platformRows = new Map<AdanosPlatformId, Map<string, StockDetailRow>>();
  const accountStatuses: AdanosAccountStatus[] = [];
  const errors: string[] = [];

  for (const settledResponse of settledResponses) {
    if (settledResponse.status === "fulfilled") {
      const rows = platformRows.get(settledResponse.value.platformId) ?? new Map<string, StockDetailRow>();
      rows.set(settledResponse.value.ticker.toUpperCase(), settledResponse.value.response.response);

      if (settledResponse.value.response.accountStatus) {
        accountStatuses.push(settledResponse.value.response.accountStatus);
      }

      platformRows.set(settledResponse.value.platformId, rows);
      continue;
    }

    if (settledResponse.reason instanceof AdanosRequestError && settledResponse.reason.accountStatus) {
      accountStatuses.push(settledResponse.reason.accountStatus);
    }

    errors.push(
      settledResponse.reason instanceof Error ? settledResponse.reason.message : "Request failed",
    );
  }

  const rows: PortfolioSentimentRow[] = holdings.map((holding) => {
    const snapshots: PlatformSnapshot[] = platforms.map((platformId) => {
      const config = PLATFORM_CONFIG[platformId];
      const stock = platformRows.get(platformId)?.get(holding.symbol);

      return {
        platformId,
        label: config.label,
        buzzScore: stock?.buzz_score ?? null,
        bullishPct: asNumber(stock?.bullish_pct),
        trend: normalizeTrend(stock?.trend),
        sentiment: stock?.sentiment_score ?? null,
        activityMetricLabel: config.activityMetricLabel,
        activityMetricValue: resolveActivityMetricValue(stock, config.activityMetricKey),
      };
    });

    const buzzValues = snapshots
      .map((snapshot) => snapshot.buzzScore)
      .filter((value): value is number => value !== null);
    const sentimentValues = snapshots
      .map((snapshot) => snapshot.sentiment)
      .filter((value): value is number => value !== null);

    return {
      ...holding,
      compositeBuzz: buzzValues.length ? average(buzzValues) : null,
      compositeSentiment: sentimentValues.length ? average(sentimentValues) : null,
      coverage: buzzValues.length,
      compositeSignal: buildCompositeSignal(snapshots),
      platforms: snapshots,
    };
  });

  return {
    holdings: rows,
    errors,
    fetchedAt: new Date().toISOString(),
    quota: mergeAccountStatuses(accountStatuses),
  };
}

async function fetchStock(
  network: NetworkAPI,
  apiKey: string,
  platformId: AdanosPlatformId,
  ticker: string,
  lookbackDays: number,
  now: Date,
): Promise<CompareResult> {
  const config = PLATFORM_CONFIG[platformId];
  const url = new URL(`${ADANOS_BASE_URL}${config.stockPath}/${encodeURIComponent(ticker)}`);
  const dateRange = buildUtcDateRange(lookbackDays, now);
  url.searchParams.set("from", dateRange.from);
  url.searchParams.set("to", dateRange.to);

  const response = await network.request({
    url: url.toString(),
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-API-Key": apiKey,
    },
  });

  const accountStatusFromHeaders = parseAccountStatusFromHeaders(response);

  if (response.status === 404) {
    return {
      response: {
        ticker,
        company_name: null,
        found: false,
      },
      accountStatus: accountStatusFromHeaders,
    };
  }

  if (!isSuccessful(response.status)) {
    const errorPayload = readJsonSafely(response);
    const accountStatusFromError = parseAccountStatusFromError(errorPayload);
    throw new AdanosRequestError(
      `${config.label}: ${extractErrorMessage(errorPayload, response.status)}`,
      mergeAccountStatuses(
        [accountStatusFromHeaders, accountStatusFromError].filter(
          (status): status is AdanosAccountStatus => status !== null,
        ),
      ),
    );
  }

  return {
    response: readJsonSafely(response) as StockDetailRow,
    accountStatus: accountStatusFromHeaders,
  };
}

function readJsonSafely(response: NetworkResponse): unknown {
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    return null;
  }
}

function isSuccessful(status: number): boolean {
  return status >= 200 && status < 300;
}

function extractErrorMessage(payload: unknown, status: number): string {
  if (!payload || typeof payload !== "object") {
    return `HTTP ${status}`;
  }

  const detail = (payload as { detail?: unknown }).detail;

  if (typeof detail === "string") {
    return detail;
  }

  if (detail && typeof detail === "object" && "message" in detail) {
    const message = (detail as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }

  return `HTTP ${status}`;
}

export function parseAccountStatusFromHeaders(response: NetworkResponse): AdanosAccountStatus | null {
  const accountType = normalizeAccountType(getHeader(response.headers, "X-Account-Type"));
  const monthlyLimit = parseMonthlyCount(getHeader(response.headers, "X-RateLimit-Limit-Monthly"));
  const monthlyRemaining = parseMonthlyCount(
    getHeader(response.headers, "X-RateLimit-Remaining-Monthly"),
  );
  const monthlyUsed = parseMonthlyCount(getHeader(response.headers, "X-RateLimit-Used-Monthly")) ?? 0;

  if (!accountType && monthlyLimit === undefined && monthlyRemaining === undefined) {
    return null;
  }

  return {
    status:
      accountType === "free" && monthlyLimit !== null && (monthlyRemaining ?? 0) <= 0
        ? "monthly_limit_exceeded"
        : "active",
    accountType: accountType ?? "free",
    monthlyLimit: monthlyLimit ?? null,
    monthlyUsed,
    monthlyRemaining: monthlyRemaining ?? null,
    hasUnlimitedRequests: monthlyLimit === null,
    pricingUrl: ADANOS_PRICING_URL,
    apiKeyPersistsAfterUpgrade: true,
    checkedAt: new Date().toISOString(),
  };
}

function getHeader(headers: Record<string, string>, name: string): string | null {
  const normalizedName = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === normalizedName);
  return entry?.[1] ?? null;
}

export function buildUtcDateRange(lookbackDays: number, now = new Date()) {
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1) {
    throw new Error("Lookback must be a positive whole number of UTC days.");
  }

  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (lookbackDays - 1));

  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}

export function parseAccountStatusFromError(payload: unknown): AdanosAccountStatus | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const detail = (payload as { detail?: unknown }).detail;
  if (!detail || typeof detail !== "object") {
    return null;
  }

  const message = "message" in detail ? detail.message : null;
  if (typeof message !== "string" || !isMonthlyLimitExceededMessage(message)) {
    return null;
  }

  const limit = parseNumberField("limit" in detail ? detail.limit : null) ?? 250;
  const used = parseNumberField("used" in detail ? detail.used : null) ?? limit;
  const accountType = normalizeAccountType("account_type" in detail ? detail.account_type : null) ?? "free";

  return {
    status: "monthly_limit_exceeded",
    accountType,
    monthlyLimit: accountType === "free" ? limit : null,
    monthlyUsed: used,
    monthlyRemaining: accountType === "free" ? Math.max(0, limit - used) : null,
    hasUnlimitedRequests: accountType !== "free",
    pricingUrl: ADANOS_PRICING_URL,
    apiKeyPersistsAfterUpgrade: true,
    checkedAt: new Date().toISOString(),
  };
}

function normalizeAccountType(value: unknown): AdanosAccountType | null {
  if (typeof value !== "string") {
    return null;
  }

  switch (value.toLowerCase()) {
    case "free":
    case "hobby":
    case "professional":
    case "premium":
      return value.toLowerCase() as AdanosAccountType;
    default:
      return null;
  }
}

function parseMonthlyCount(value: string | null): number | null | undefined {
  if (value === null) {
    return undefined;
  }

  if (value.toLowerCase() === "unlimited") {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseNumberField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function mergeAccountStatuses(statuses: AdanosAccountStatus[]): AdanosAccountStatus | null {
  if (statuses.length === 0) {
    return null;
  }

  return statuses.reduce((selected, current) => {
    if (!selected) {
      return current;
    }

    if (current.status === "monthly_limit_exceeded" && selected.status !== "monthly_limit_exceeded") {
      return current;
    }

    if (selected.status === "monthly_limit_exceeded") {
      return selected;
    }

    const selectedRemaining = selected.monthlyRemaining ?? Number.POSITIVE_INFINITY;
    const currentRemaining = current.monthlyRemaining ?? Number.POSITIVE_INFINITY;
    if (currentRemaining < selectedRemaining) {
      return current;
    }

    if (current.monthlyUsed > selected.monthlyUsed) {
      return current;
    }

    return selected;
  }, null as AdanosAccountStatus | null);
}

function average(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeTrend(value: unknown): "rising" | "falling" | "stable" | null {
  if (value === "rising" || value === "falling" || value === "stable") {
    return value;
  }

  return null;
}
