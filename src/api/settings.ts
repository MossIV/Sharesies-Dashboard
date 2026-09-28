/**
 * Assumptions and stored settings (plan section 9, item 8).
 * Resolution order: settings table -> environment -> built-in default.
 */
import type { DatabaseSync } from "node:sqlite";
import { getSetting, setSetting } from "../db/client.ts";

export const SETTING_KEYS = {
  annualReturn: "assumed_annual_return",
  monthlyContribution: "assumed_monthly_contribution",
} as const;

export const DEFAULT_ANNUAL_RETURN = 0.07;
export const DEFAULT_MONTHLY_CONTRIBUTION = 500;

/** Sane guardrails so a typo cannot produce an absurd projection. */
export const ANNUAL_RETURN_RANGE = { min: -0.5, max: 0.5 } as const;
export const MONTHLY_CONTRIBUTION_RANGE = { min: 0, max: 1_000_000 } as const;

export interface Assumptions {
  annualReturn: number;
  monthlyContribution: number;
}

function readNumber(db: DatabaseSync, key: string, envName: string, fallback: number): number {
  const stored = getSetting(db, key);
  if (stored !== undefined) {
    const parsed = Number(stored);
    if (Number.isFinite(parsed)) return parsed;
  }
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    const parsed = Number(fromEnv);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function getAssumptions(db: DatabaseSync): Assumptions {
  return {
    annualReturn: readNumber(db, SETTING_KEYS.annualReturn, "ASSUMED_ANNUAL_RETURN", DEFAULT_ANNUAL_RETURN),
    monthlyContribution: readNumber(
      db,
      SETTING_KEYS.monthlyContribution,
      "ASSUMED_MONTHLY_CONTRIBUTION",
      DEFAULT_MONTHLY_CONTRIBUTION,
    ),
  };
}

export function setAssumptions(db: DatabaseSync, patch: Partial<Assumptions>): Assumptions {
  if (patch.annualReturn !== undefined) {
    setSetting(db, SETTING_KEYS.annualReturn, String(patch.annualReturn));
  }
  if (patch.monthlyContribution !== undefined) {
    setSetting(db, SETTING_KEYS.monthlyContribution, String(patch.monthlyContribution));
  }
  return getAssumptions(db);
}
