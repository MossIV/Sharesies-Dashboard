-- 004_contribution_attribution.sql
--
-- Three things the contribution log needs before it can describe a real
-- Sharesies portfolio, all found by importing an actual transaction report.
--
-- 1. `account_id`. A Sharesies transaction report carries a Portfolio column
--    ("Investments", "High-growth portfolio"), and those are the accounts Akahu
--    already registers. Without attribution the log is one global total, so a
--    report's buys for an account *outside* the goal were summed into the goal's
--    contributions: 8,657.60 of deposits against a tracked value of 214.33, which
--    is what made "contributions vs growth" meaningless. NULL means "not
--    attributed", which is honest for a hand-entered row and for a report whose
--    portfolio could not be matched to an account.
--
-- 2. Currency and the rate used. The report lists trades in NZD, USD and AUD, and
--    the importer was adding all three into `amount_nzd` — a silent ~1.76x
--    overstatement on every USD row. `amount_nzd` stays the canonical converted
--    figure so no existing query changes; `currency`, `amount_original` and
--    `fx_rate` keep the conversion auditable rather than invisible.
--
-- 3. `category`. The report's rows are buys and sells, not deposits. Recording
--    what each row was lets the UI say "buy" instead of calling every row a
--    deposit, and it is what makes a sell visible as a sell.

ALTER TABLE contributions ADD COLUMN account_id TEXT;
ALTER TABLE contributions ADD COLUMN currency TEXT NOT NULL DEFAULT 'NZD';
ALTER TABLE contributions ADD COLUMN amount_original REAL;
ALTER TABLE contributions ADD COLUMN fx_rate REAL;
-- deposit | withdrawal | buy | sell | dividend | fee | interest | transfer
-- NULL for a row that predates this migration or was entered by hand.
ALTER TABLE contributions ADD COLUMN category TEXT;

CREATE INDEX IF NOT EXISTS idx_contributions_account ON contributions (account_id);

-- Existing rows were all NZD by construction (there was nowhere to record
-- anything else), so the conversion for them is the identity.
UPDATE contributions SET currency = 'NZD', fx_rate = 1, amount_original = amount_nzd
 WHERE amount_original IS NULL;

-- The rate used for each conversion, cached so a re-import of the same report
-- does not re-fetch, and so an offline re-run still reproduces the same numbers.
--
--   as_of_date  the trade date asked about (the cache key)
--   rate_date   the date the rate actually comes from
--
-- Those differ: the ECB publishes on business days only, so asking for a Sunday
-- returns Friday's rate. Keeping both is what lets the UI say which rate a row
-- used instead of implying a precision the source does not have.
CREATE TABLE IF NOT EXISTS fx_rates (
  base       TEXT NOT NULL,
  quote      TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  rate       REAL NOT NULL,
  rate_date  TEXT NOT NULL,
  source     TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (base, quote, as_of_date)
);
