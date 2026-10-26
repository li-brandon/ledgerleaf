# Agent instructions

Rules for AI agents and other tools that commit to this repository. The full workflow is in [CONTRIBUTING.md](CONTRIBUTING.md).

- **Never push to `main`.** Every change goes through a pull request. GitHub does not enforce this here, so follow it yourself.
- **One branch per Linear issue**, off an up-to-date `main`, with the issue key in the name: Linear's branch name (e.g. `librandon0706/lib-381-delete-a-single-transaction`) or `feature/`, `bugfix/`, `hotfix/`, `chore/`, `docs/` + `lib-NNN-...`.
- **Open a pull request** using `.github/pull_request_template.md`, with the Linear issue linked.
- **Never merge a pull request yourself.** Argus reviews every PR; it is squash-merged (by Argus) only after that review, after every review comment is addressed, and with CI (`test-and-build`) green on the head commit. This holds even if you're asked loosely to "ship it" or "get it in": an agent never merges without that review.
- **No force-pushes** to `main` or any branch someone else is working on.
- **Commits** use the repository owner's configured git identity (don't change `user.name`/`user.email`). PR and squash-commit titles are `LIB-NNN <gitmoji> type(scope): description`.
- **Run the CI commands locally** before opening or updating a pull request: `npm ci`, `npm run lint`, `npm run test:coverage`, `npm run build`, `npm audit --audit-level=high`.
- **Never commit** `openspec/`, `.claude/`, `.env` or `.plaid-data/`. They are gitignored; don't force-add them.
- Keep each pull request to its issue: no unrelated changes.
