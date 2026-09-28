-- 003_goal_source_and_single_active.sql
--
-- Two fixes found while switching from demo data to a real Akahu connection.
--
-- 1. `goals.source`. The demo seeder created a goal, and its `--reset` could not
--    remove it: snapshots and contributions carry a `source`, goals did not. The
--    leftover goal stayed active and `getActiveGoal` returned it ahead of the real
--    one, so the dashboard measured a $100k demo target instead of the user's own.
--    Seeded goals now say so, and the reset deletes exactly those.
--
-- 2. Exactly one active goal. The schema allows several rows with is_active = 1,
--    and `getActiveGoal` then picked the lowest id: a new goal was silently
--    ignored. The app has one progress bar and no goal switcher, so "active" is a
--    single-valued property. It is enforced in the repository rather than with a
--    partial unique index, which SQLite does not support directly.

ALTER TABLE goals ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';

-- Any goal that already exists is the user's own or the old seeded one. The
-- seeded shape is unambiguous: the demo name, target and target date.
UPDATE goals
   SET source = 'demo'
 WHERE name = 'First $100k'
   AND target_amount_nzd = 100000;

-- Collapse any existing multiple-active-goal state to the newest, which is the
-- one the user most recently created or reactivated.
UPDATE goals
   SET is_active = 0
 WHERE is_active = 1
   AND id <> (SELECT MAX(id) FROM goals WHERE is_active = 1);