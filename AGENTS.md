# AGENTS.md

All instructions for AI coding agents working in this repository are in **[CLAUDE.md](CLAUDE.md)**.
Read it in full before making any change. It covers the purpose, architecture, repository map,
setup, safe commands, coding conventions and test expectations.

If anything here and CLAUDE.md disagree, CLAUDE.md wins.

## The rules that matter most (details in CLAUDE.md)
- Never read, print or commit `.env`, `.env*.local`, service-role keys or tokens.
- Never push to `main` (it deploys to Vercel automatically), run deploy commands, or run SQL against a real Supabase database.
- No destructive commands (`rm -rf`, `git reset --hard`, `git push --force`, `git clean`) and no editing old migrations.
- No dependency changes (`npm install <pkg>`, `npm update`, `npm audit fix`, edits to `package.json` / `package-lock.json`) without the user's approval.
- Work on a feature branch and open a pull request; commit only when asked.
- Before calling a change done, run `npx tsc --noEmit`, `npm test` and `npm run build`, and report the results. If you could not run them, say so.
- A business rule change goes into both `src/lib/demoApi.ts` and the SQL (`schema.sql` + a new migration).
