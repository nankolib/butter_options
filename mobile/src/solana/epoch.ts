import type { Connection } from "@solana/web3.js";
import type {
  EpochConfigSnapshot,
  EpochTenorCandidate,
  EpochTenorSchedule
} from "../types";
import { epochConfigPda } from "./pdas";
import { createOptaProgram, fetchDecodedAccount, OptaAccountReadError } from "./program";
import { ensureDevnetConnection } from "./cluster";

const SECONDS_PER_DAY = 86_400;
const QUARTER_END_MONTHS = [2, 5, 8, 11] as const;

type EpochConfigAccount = {
  authority: EpochConfigSnapshot["authority"];
  weeklyExpiryDay: number;
  weeklyExpiryHour: number;
  monthlyEnabled: boolean;
  minEpochDurationDays: number;
  bump: number;
};

export async function loadEpochTenorCandidates(
  connection: Connection,
  nowMs = Date.now()
): Promise<EpochTenorSchedule> {
  await ensureDevnetConnection(connection);
  const program = createOptaProgram(connection);
  const publicKey = epochConfigPda(program.programId);
  const record = await fetchDecodedAccount<EpochConfigAccount>(program, "epochConfig", publicKey);
  if (!record) {
    throw new OptaAccountReadError("Epoch configuration is not initialized.");
  }

  const config: EpochConfigSnapshot = {
    publicKey,
    authority: record.account.authority,
    weeklyExpiryDay: record.account.weeklyExpiryDay,
    weeklyExpiryHour: record.account.weeklyExpiryHour,
    monthlyEnabled: record.account.monthlyEnabled,
    minEpochDurationDays: record.account.minEpochDurationDays,
    bump: record.account.bump
  };
  return {
    config,
    candidates: deriveEpochTenorCandidates(config, nowMs),
    fetchedAt: Date.now()
  };
}

export function deriveEpochTenorCandidates(
  config: Pick<
    EpochConfigSnapshot,
    "weeklyExpiryDay" | "weeklyExpiryHour" | "monthlyEnabled" | "minEpochDurationDays"
  >,
  nowMs = Date.now()
): EpochTenorCandidate[] {
  validateEpochConfig(config);
  const threshold = Math.floor(nowMs / 1000) + config.minEpochDurationDays * SECONDS_PER_DAY;
  const candidates: EpochTenorCandidate[] = [{
    tenor: "weekly",
    expiry: nextWeeklyBoundary(threshold, config.weeklyExpiryDay, config.weeklyExpiryHour)
  }];

  if (config.monthlyEnabled) {
    candidates.push({
      tenor: "monthly",
      expiry: nextMonthlyBoundary(threshold, config.weeklyExpiryDay, config.weeklyExpiryHour)
    });
    candidates.push({
      tenor: "quarterly",
      expiry: nextQuarterlyBoundary(threshold, config.weeklyExpiryDay, config.weeklyExpiryHour)
    });
  }
  return candidates;
}

export function isValidEpochCandidate(
  expiry: number,
  config: Pick<EpochConfigSnapshot, "weeklyExpiryDay" | "weeklyExpiryHour" | "minEpochDurationDays">,
  nowMs = Date.now()
): boolean {
  if (!Number.isSafeInteger(expiry) || expiry <= 0) return false;
  const date = new Date(expiry * 1000);
  const threshold = Math.floor(nowMs / 1000) + config.minEpochDurationDays * SECONDS_PER_DAY;
  return expiry >= threshold
    && date.getUTCDay() === config.weeklyExpiryDay
    && date.getUTCHours() === config.weeklyExpiryHour
    && date.getUTCMinutes() === 0
    && date.getUTCSeconds() === 0;
}

function validateEpochConfig(
  config: Pick<EpochConfigSnapshot, "weeklyExpiryDay" | "weeklyExpiryHour" | "minEpochDurationDays">
): void {
  if (!Number.isInteger(config.weeklyExpiryDay) || config.weeklyExpiryDay < 0 || config.weeklyExpiryDay > 6) {
    throw new Error("Epoch configuration has an invalid expiry day.");
  }
  if (!Number.isInteger(config.weeklyExpiryHour) || config.weeklyExpiryHour < 0 || config.weeklyExpiryHour > 23) {
    throw new Error("Epoch configuration has an invalid expiry hour.");
  }
  if (!Number.isInteger(config.minEpochDurationDays) || config.minEpochDurationDays < 0) {
    throw new Error("Epoch configuration has an invalid minimum duration.");
  }
}

function nextWeeklyBoundary(threshold: number, weekday: number, hour: number): number {
  const date = new Date(threshold * 1000);
  date.setUTCHours(hour, 0, 0, 0);
  const daysUntil = (weekday - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + daysUntil);
  let candidate = Math.floor(date.getTime() / 1000);
  if (candidate < threshold) candidate += 7 * SECONDS_PER_DAY;
  return candidate;
}

function nextMonthlyBoundary(threshold: number, weekday: number, hour: number): number {
  const date = new Date(threshold * 1000);
  let year = date.getUTCFullYear();
  let month = date.getUTCMonth();
  let candidate = lastWeekdayOfMonth(year, month, weekday, hour);
  while (candidate < threshold) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
    candidate = lastWeekdayOfMonth(year, month, weekday, hour);
  }
  return candidate;
}

function nextQuarterlyBoundary(threshold: number, weekday: number, hour: number): number {
  const date = new Date(threshold * 1000);
  let year = date.getUTCFullYear();
  let index = QUARTER_END_MONTHS.findIndex((month) => month >= date.getUTCMonth());
  if (index < 0) {
    index = 0;
    year += 1;
  }
  let candidate = lastWeekdayOfMonth(year, QUARTER_END_MONTHS[index], weekday, hour);
  while (candidate < threshold) {
    index += 1;
    if (index >= QUARTER_END_MONTHS.length) {
      index = 0;
      year += 1;
    }
    candidate = lastWeekdayOfMonth(year, QUARTER_END_MONTHS[index], weekday, hour);
  }
  return candidate;
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number, hour: number): number {
  const date = new Date(Date.UTC(year, month + 1, 0, hour, 0, 0, 0));
  const daysBack = (date.getUTCDay() - weekday + 7) % 7;
  date.setUTCDate(date.getUTCDate() - daysBack);
  return Math.floor(date.getTime() / 1000);
}
