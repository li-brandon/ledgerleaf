# Contributing

## The rule: every change lands through a pull request

Nothing is pushed straight to `main`. Each change gets its own branch and pull request, and a pull request is merged only after Argus has reviewed it, every review comment has been addressed, and CI is green on the head commit; then Argus squash-merges it. That way every change on `main` has been reviewed, has passed lint, tests with coverage, the build and the audit, and links back to the Linear issue it came from.

GitHub does not enforce this (see [Why this isn't enforced](#why-this-isnt-enforced)), so it's a convention everyone follows, including agents (see [`AGENTS.md`](AGENTS.md)).

## Workflow

1. **Pick a Linear issue** in the `LIB` team. Every change has one; if there isn't one yet, create it.
2. **Create a branch** off an up-to-date `main`, one per issue (see [Branch names](#branch-names)).
3. **Commit** on that branch. Keep it to that issue: no unrelated changes.
4. **Run the CI checks locally** (see [What CI checks](#what-ci-checks)).
5. **Open a pull request** against `main`. The template ([`.github/pull_request_template.md`](.github/pull_request_template.md)) asks for the Linear issue, what changed and why, a test note and a checklist.
6. **Wait for CI to go green** on the head commit. If it fails, push fixes (new commits) to the same branch.
7. **Argus reviews.** Address every review comment with new commits (no force-pushes) and reply on each thread.
8. **Argus squash-merges** once every comment is addressed and CI is green on the head commit. The squash commit uses the PR title (see [Titles](#titles)).
9. **Move the Linear issue to Done.** The issue key in the branch name and PR links them to the issue in Linear.

Never push directly to `main`, and never force-push to it.

## Branch names

One branch per Linear issue, with the issue key in the name so Linear links the branch and PR to the issue.

- **Default:** Linear's branch name, from **Copy git branch name** on the issue, e.g. `librandon0706/lib-381-delete-a-single-transaction`.
- **Also accepted:** a [Conventional Branch](https://conventional-branch.github.io/) name with the issue key: `feature/`, `bugfix/`, `hotfix/`, `chore/` or `docs/` followed by `lib-NNN-short-description`, e.g. `feature/lib-381-delete-transaction`, `chore/lib-386-eslint`, `docs/lib-388-pr-only-workflow`.

## Titles

PR titles, and so the squash commits on `main`, look like this:

```
LIB-NNN <gitmoji> type(scope): description
```

For example `LIB-381 ✨ feat(transactions): delete a single transaction with an Undo toast` or `LIB-383 🐛 fix(db): keep multiple tabs from overwriting each other's data`. The type is a [Conventional Commits](https://www.conventionalcommits.org/) type (`feat`, `fix`, `chore`, `ci`, `docs`, …) and the emoji is the matching [gitmoji](https://gitmoji.dev/). GitHub appends the PR number (`(#13)`) when squash-merging. The PR body links the Linear issue.

## What CI checks

`.github/workflows/ci.yml` runs one job, `test-and-build`, on every pull request and on pushes to `main`, with the Node version from `.nvmrc`:

```sh
npm ci
npm run lint                  # ESLint, --max-warnings=0
npm run test:coverage         # Vitest with V8 coverage; thresholds in vite.config.ts must pass
npm run build                 # tsc --noEmit, then vite build
npm audit --audit-level=high  # fails on high or critical advisories
```

Run the same commands locally before opening a pull request.

## Files that are never committed

`openspec/`, `.claude/`, `.env` (and `.env.*` except `.env.example`) and `.plaid-data/` are local-only and listed in `.gitignore`. Don't force-add them.

## Why this isn't enforced

`li-brandon/ledgerleaf` is a private repository on a free GitHub plan. Branch protection and rulesets aren't available there: the API returns 403. So the PR-only rule is a convention, not a setting.

If enforcement is wanted later, there are two options:

- **Make the repository public.** Branch protection and rulesets are available on public repositories on the free plan.
- **Upgrade to GitHub Pro**, which offers branch protection and rulesets on private repositories.

Either way, a ruleset or branch protection rule on `main` would then:

- require a pull request before merging,
- require the `test-and-build` status check to pass,
- block force-pushes,
- block deleting the branch.
