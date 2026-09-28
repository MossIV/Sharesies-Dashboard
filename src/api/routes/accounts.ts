import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { getAccount, latestSnapshotPerAccount, listAccounts, listSnapshots, setAccountScope } from "../../db/repo.ts";
import { defaultScopeTypes, scopePattern } from "../../collector/select-accounts.ts";
import { badRequest, notFound, optBoolean, readJson } from "../validate.ts";

export function accountRoutes(db: DatabaseSync): Hono {
  const app = new Hono();

  /**
   * Every account the collector has ever seen, with its scope. This is the
   * Phase 4 answer to "Sharesies only, or also KiwiSaver and other accounts?"
   * (plan section 14.1): the choice is per account, not a code change.
   */
  app.get("/accounts", (c) => {
    const accounts = listAccounts(db);
    const latest = new Map(latestSnapshotPerAccount(db).map((snapshot) => [snapshot.accountId, snapshot]));

    return c.json({
      accounts: accounts.map((account) => {
        const snapshot = latest.get(account.accountId);
        return {
          ...account,
          latestValue: snapshot?.valueNzd ?? null,
          latestSnapshotDate: snapshot?.snapshotDate ?? null,
        };
      }),
      inScopeCount: accounts.filter((account) => account.inScope).length,
      // How a newly discovered account is judged, shown so the rule is not magic.
      defaultRule: {
        connectionMatch: scopePattern(),
        accountTypes: [...defaultScopeTypes()],
      },
    });
  });

  /** Include or exclude an account from the goal total. */
  app.patch("/accounts/:accountId", async (c) => {
    const accountId = c.req.param("accountId");
    const body = await readJson(c.req.raw);
    const inScope = optBoolean(body, "inScope");
    if (inScope === undefined) throw badRequest("Provide inScope: true or false", { inScope: "required" });

    const account = setAccountScope(db, accountId, inScope);
    if (!account) throw notFound(`No account with id ${accountId}`);
    return c.json({ account });
  });

  app.get("/accounts/:accountId", (c) => {
    const accountId = c.req.param("accountId");
    const account = getAccount(db, accountId);
    if (!account) throw notFound(`No account with id ${accountId}`);
    return c.json({
      account,
      snapshots: listSnapshots(db, { accountId, scope: "all" }),
    });
  });

  return app;
}
