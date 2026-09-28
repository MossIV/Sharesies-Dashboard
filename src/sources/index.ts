/**
 * Source selection. Defaults to Akahu when both tokens are present, otherwise
 * falls back to the manual source so the dashboard works before Phase 0 is done.
 */
import type { DatabaseSync } from "node:sqlite";
import type { PortfolioSource } from "./PortfolioSource.ts";
import { AkahuSource } from "./AkahuSource.ts";
import { ManualSource } from "./ManualSource.ts";
import { getSetting } from "../db/client.ts";

export function resolveSource(db?: DatabaseSync): PortfolioSource {
  const requested = process.env["PORTFOLIO_SOURCE"]?.trim().toLowerCase();

  if (requested === "manual") return manualSource(db);
  if (requested === "akahu") {
    if (!AkahuSource.isConfigured()) {
      throw new Error(
        "PORTFOLIO_SOURCE=akahu but AKAHU_APP_TOKEN/AKAHU_USER_TOKEN are not set. " +
          "Fill them in .env, or set PORTFOLIO_SOURCE=manual.",
      );
    }
    return new AkahuSource();
  }

  return AkahuSource.isConfigured() ? new AkahuSource() : manualSource(db);
}

function manualSource(db?: DatabaseSync): PortfolioSource {
  return new ManualSource({
    getValue: () => {
      const stored = db ? getSetting(db, "manual_value_nzd") : undefined;
      if (stored !== undefined) {
        const parsed = Number(stored);
        if (Number.isFinite(parsed)) return parsed;
      }
      const raw = process.env["MANUAL_VALUE_NZD"];
      if (!raw || raw.trim() === "") return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    },
  });
}

export { AkahuSource, ManualSource };
export type { PortfolioSource };
