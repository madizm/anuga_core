# Repository Guidelines

## Git remotes

This repository is maintained as a fork of the official ANUGA repository.

- `upstream`: `https://github.com/anuga-community/anuga_core.git` — official repository
- `origin`: `https://github.com/madizm/anuga_core.git` — maintained fork

Never push directly to `upstream`. Push branches and tags to `origin`; contribute
changes back to the official project through pull requests.

## Branch roles

- `main` mirrors `upstream/main` and must not contain fork-specific commits.
- `custom/main` is the integration and release branch for fork-specific changes.
- `feature/<name>` and `fix/<name>` are short-lived branches created from
  `custom/main` for normal development.
- Branches intended for an upstream pull request must be created from the
  relevant `upstream` branch and contain only the changes proposed upstream.

Do not develop directly on `main` or rewrite shared branch history.

## Syncing with upstream

Refresh the local official mirror before integrating upstream changes:

```bash
git fetch upstream --tags
git switch main
git reset --hard upstream/main
git push origin main
```

Then update the fork integration branch:

```bash
git switch custom/main
git rebase upstream/main
git push --force-with-lease origin custom/main
```

Use this rebase workflow only when `custom/main` is maintained by a single
owner and history rewriting has been coordinated. If multiple contributors
share the branch, merge `upstream/main` instead and push normally.

Always use `--force-with-lease`, never an unconditional force push.

## Development workflow

Create each change on a focused branch:

```bash
git switch custom/main
git pull --ff-only origin custom/main
git switch -c feature/<name>
```

Before committing:

1. Review `git status` and `git diff`.
2. Exclude generated files, caches, build outputs, credentials, and unrelated
   changes.
3. Run the relevant tests and quality checks documented in `CLAUDE.md`.
4. Keep commits focused and independently understandable.

Use Conventional Commits subjects:

```text
<type>(<scope>): <imperative summary>
```

Common types are `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, and `chore`.
Keep the subject at 72 characters or fewer, with no trailing period.

Push the development branch to `origin` and merge it into `custom/main` through
a pull request when practical.

## Upstream contributions

For changes suitable for the official project, start from the current upstream
branch rather than from `custom/main`:

```bash
git fetch upstream
git switch -c fix/<name> upstream/main
```

Push the branch to `origin`, then open a pull request from the fork to the
official repository. Do not include fork-only commits in upstream pull requests.

## Releases

Create releases from `custom/main`, not `main`. Use tags that clearly distinguish
fork releases from official ANUGA releases, for example:

```bash
git switch custom/main
git tag -a custom-v3.3.8.1 -m "Custom ANUGA 3.3.8.1"
git push origin custom-v3.3.8.1
```

Do not reuse or move official tags. If publishing a Python distribution, use a
distinct distribution name so it cannot be confused with the official package.
