<!-- Title: LIB-NNN <gitmoji> type(scope): description -->

Linear: LIB-___ <!-- link: https://linear.app/... -->

## What

<!-- What changes, in a few lines. -->

## Why

<!-- The problem this solves, or the Linear issue's goal. -->

## Tests

<!-- What tests were added or changed, and what you ran. If you checked that a new test fails with the change reverted, say so. -->

## Checklist

- [ ] One branch for this Linear issue, with the issue key in the branch name
- [ ] Title follows `LIB-NNN <gitmoji> type(scope): description`
- [ ] `npm run lint`, `npm run test:coverage`, `npm run build` and `npm audit --audit-level=high` pass locally
- [ ] Argus has reviewed, every review comment is addressed, and CI is green on the head commit before Argus squash-merges
- [ ] Nothing from `openspec/`, `.claude/`, `.env` or `.plaid-data/` is committed
- [ ] Docs (README, CONTRIBUTING) updated if behaviour or workflow changed
- [ ] No unrelated changes
