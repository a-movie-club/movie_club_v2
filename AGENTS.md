# AGENTS.md

## Workflow

**Never commit directly to `main`.** All work happens on a branch and lands via a pull request against `main`.

- **Branch first.** Before the first edit of a piece of work, cut a branch off up-to-date `main`: `git checkout main && git pull && git checkout -b <type>/<short-slug>`. Use `feat/`, `fix/`, `chore/`, `docs/`, or `refactor/` as the type. If you're already on `main` with uncommitted changes, branch and carry them over rather than committing where you are.
- **Open a PR against `main`.** When the work is ready, push and open one: `gh pr create --base main --fill`. Link the originating issue in the body with `Closes #<n>` so it closes on merge.
- **One PR per issue.** If the work spans several issues, it's several branches and several PRs.
- **Review before the PR.** Run `/code-review` against `main` (the merge-base) before opening it, and address the findings in the branch.
- **`main` stays green and deployable.** Don't force-push it; don't merge a red PR.

Throwaway `prototype/<name>` and `research/<name>` branches (created by `/prototype` and `/research`) are the exception — they're kept as primary sources and are never merged into `main`.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `Foifoif/movie_club_v2`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
