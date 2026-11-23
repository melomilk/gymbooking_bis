# Agent task: R-02 — use the Almaty date for membership expiry

## Goal
The database decides "Expired" with `current_date` (UTC) in `v_me`, and new members get
`current_date + 30`. The rest of the app uses Asia/Almaty. Make the database use the
Almaty date in both places, without changing anything else.

## Branch
- Create `agent/r02-almaty-date` from `main`, in a fresh clone or worktree.
- Commit only to this branch. Push only this branch and open a **draft** pull request.

## Allowed files
| File | Allowed change |
|---|---|
| `supabase/migration_membership_dates.sql` | create (new migration for existing databases) |
| `supabase/schema.sql` | edit only `v_me` and the member-creation function (`current_date` → `(now() at time zone 'Asia/Almaty')::date`) |
| `tests/backend/consistency.test.ts` | add TC-39: these two places in `schema.sql` must not use `current_date` |
| `docs/DATABASE.md` | one line about membership dates in Almaty time |
| `agent-output/R-02/*` | the artifacts below |
| `supabase/rollback_membership_dates.sql` | create: restores the old `v_me` and member-creation function exactly as in `main`. 
Everything else is read-only.

## Allowed commands
`git checkout -b`, `git status`, `git diff`, `git add <allowed files>`, `git commit`,
`git push origin agent/r02-almaty-date`, `npm ci`, `npx tsc --noEmit`, `npm test`,
`npm run build`, read-only search (`grep`, `cat`).

## Time limits
- Whole task: 60 minutes. One command: 10 minutes.
- If the same check fails 3 times, stop, write the artifacts and report. Don't keep trying.

## Prohibited
- Pushing to `main`, merging, force-push, `git reset --hard`, `git clean`, deleting files.
- Running any SQL against a real Supabase project; using the Supabase or Vercel CLI; deploying.
- Reading or printing `.env`, `.env*.local` or any key.
- `npm install <pkg>`, `npm update`, `npm audit fix`, editing `package.json` / `package-lock.json`.
- Editing old migrations, or any file not in the allowed list.
- Changing or deleting existing tests to make them pass.

## Required artifacts (in `agent-output/R-02/`)
1. `SUMMARY.md`: what changed and why, file by file, in 10 lines or fewer.
2. `changes.diff`: output of `git diff main...HEAD`.
3. `baseline.txt`: `npx tsc --noEmit` and `npm test` output **before** any change, with exit codes.
4. `test-log.txt`: full `npm test` output **after** the change, with exit code.
5. `typecheck-log.txt`: `npx tsc --noEmit` output and exit code.
6. `build-log.txt`: `npm run build` output and exit code.
7. `RISK_NOTES.md`: what was not verified (the migration was not run on a real database),
   any test that failed and why, and anything outside the allowed files that should change.

Logs must be the real command output. If a command could not run, say so. Don't describe a result you didn't see.

## Done when
## Human review and approval (required)
The agent never merges, deploys or applies SQL. Every step past the draft PR is done by a person.

| Gate | Who | What must be true |
|---|---|---|
| G1 Draft PR | Agent | PR is a **draft**, from `agent/r02-almaty-date` to `main`, contains only allowed files, and all artifacts are in `agent-output/R-02/`. The agent may not mark it "Ready for review". |
| G2 Code review | A team member (not the person who started the agent) | Reads `SUMMARY.md`, `RISK_NOTES.md` and the whole diff. Re-runs on their own machine: `npm ci`, `npx tsc --noEmit`, `npm test`, `npm run build`. Checks that the rollback script matches `main`. Writes "Approved" in the PR with their name and date. |
| G3 Merge | The reviewer from G2, after approval | Every check passed in G2 and nothing new was pushed after the approval. A merge to `main` **deploys the app to Vercel automatically**, so merging counts as deploying. |
| G4 Database change | Team member who owns Supabase | After the merge: note the current `v_me` definition, run `migration_membership_dates.sql` in the SQL Editor, then run the README check query and `select * from v_me;` as a test member. Post the result in the PR. |

If any gate fails, the change does not move on. Recommended: turn on branch protection for `main` in GitHub
(require 1 approving review, no direct pushes).

## Failure handling
| Situation | What the agent does |
|---|---|
| A check already fails on the **baseline** | Stop before changing anything. Write `baseline.txt` and `RISK_NOTES.md` ("baseline failing: …"). Don't try to fix it. |
| A check fails **because of the change** | At most 3 attempts to fix it, inside the allowed files only. Then stop and report. |
| Environment problem (`npm ci` fails, no network, command times out) | Stop. Record the command, the error and the exit code. Don't change dependencies or work around it. |
| Time limit reached | Stop. Commit nothing unfinished. Write the artifacts with `STATUS: INCOMPLETE` at the top of `SUMMARY.md`. |
| The fix seems to need a file outside the allowed list | Don't edit it. Describe the needed change under "Needs human decision" in `RISK_NOTES.md`. |

Either way, the agent always writes the artifacts and leaves the PR as a draft. A failed run is reported, never hidden.

## Rollback
| Stage | How to undo | Who |
|---|---|---|
| Before merge | Close the draft PR and delete the `agent/r02-almaty-date` branch. `main` was never touched. | Reviewer |
| After merge, app problem | Revert the merge commit (`git revert -m 1 <merge-commit>`) in a new PR, review it, then merge. Vercel redeploys the previous code. For an urgent fix, the Supabase owner can also redeploy the previous deployment from the Vercel dashboard. | Reviewer |
| After the migration was applied | Run `supabase/rollback_membership_dates.sql` in the SQL Editor; it restores the old `v_me` and member-creation function. Run the README check query again. | Supabase owner |

**Data impact:** `v_me` is a view and stores no data, so undoing it loses nothing. The member-creation change only affects
accounts created while it was live; their expiry dates are correct (Almaty date), so they need no repair after rollback.

Record every rollback in the PR: what was undone, when, by whom and why.