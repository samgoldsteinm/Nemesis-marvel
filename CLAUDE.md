# Project notes for Claude

Before making changes, read `HANDOVER.md` — it has the architecture, workflow (tests, screenshots, deploy),
the change log and the list of mistakes already made and fixed. After you change something or fix a problem,
add a line to the change log and, for fixes, to "Problems we hit" in `HANDOVER.md`.

- Original game only: never use names, characters, art or music from existing franchises.
- Type-check with `npx tsc --noEmit`; run `node tests/checks.cjs` (dev server on :5173) before pushing — all checks must pass.
- Pushing the branch deploys to production on Vercel.
