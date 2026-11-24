# Backend engineering playground

A small Bun + Hono API, PostgreSQL, and Redis stack for learning Docker.
No product/order endpoints or Redis integration are included.

## Start and stop

Requires Docker with Compose and Bun 1.4.4 for local type checking.

```sh
cp .env.example .env # First setup only; keep an existing .env.
# Edit .env and replace the example password with a local password.
docker compose config --quiet
docker compose up --build -d --wait
docker compose ps
```

`.env` is ignored by Git and excluded from the image. Use it only for this
local playground. A private `.env` was generated during initial setup.

```sh
docker compose stop        # Stop this project's containers; retain data.
docker compose start      # Start the existing containers again.
docker compose down       # Remove this project's containers/network; retain volumes.
```

Do not add `--volumes` / `-v` to `down`: that deletes persistent data.
After source changes, run `docker compose up --build -d --wait` again.
View logs with `docker compose logs --tail=100 api db redis`.

## Verify

The following uses the default host ports. Adjust URLs if you change `.env`.

```sh
curl -i --max-time 10 http://127.0.0.1:3100/health
curl -i --max-time 10 http://127.0.0.1:3100/ready
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT 1"'
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\dt"'
docker compose exec redis redis-cli ping
bun install --frozen-lockfile
bun run typecheck
```

Expected: both HTTP responses are 200, `SELECT 1` returns 1, `products` and
`orders` exist, Redis returns `PONG`, and type checking succeeds.
To inspect columns and constraints, replace `\dt` with `\d products` or `\d orders`.

Observe a database outage without deleting data:

```sh
docker compose stop db
curl -i --max-time 10 http://127.0.0.1:3100/health # 200
curl -i --max-time 10 http://127.0.0.1:3100/ready  # 503
docker compose up -d --wait db
curl -i --max-time 10 http://127.0.0.1:3100/ready  # 200 again
```

## Pinned versions

| Component | Version | Reason |
| --- | --- | --- |
| Bun image | `oven/bun:1.4.4` | Matches the host runtime; runs TypeScript directly. |
| PostgreSQL image | `postgres:17.11-alpine3.23` | Available locally; explicit PostgreSQL patch and Alpine version with the simple PostgreSQL 17 data path. |
| Redis image | `redis:7.4.12-alpine3.22` | Explicit Redis 7 maintenance release and Alpine version; sufficient for PING and persistence exercises. |
| Hono | `4.13.21` | Small framework with native Bun support. |
| `pg` | `8.23.1` | Simple PostgreSQL client with raw SQL and explicit timeout controls. |
| TypeScript | `5.9.3` | Stable compiler sufficient for this small project. |
| `@types/bun`, `@types/pg` | `1.4.4`, `8.23.1` | Types matched to the selected runtime/client. |
| Biome | `2.6.8` | One development tool for TypeScript/JavaScript/JSON formatting and linting. |
| Husky | `9.1.7` | Small Git hook manager; hooks use Bun commands. |

Direct dependencies are exact versions; `bun.lock` pins the resolved dependency
tree, and the Docker build uses `--frozen-lockfile`. Image tags pin versions,
but are not immutable content digests. Upstream images use version tags rather
than `latest`.

See [LEARNING.md](LEARNING.md) for networking, storage, initialization, and configuration.

## Development checks and hooks

After cloning, run `bun install --frozen-lockfile`. Its `prepare` lifecycle
initializes Husky; Bun must be available in the terminal or Git client's PATH.
To reinstall hooks manually, run `bun run prepare`. Check installation with
`git config --get core.hooksPath` (expected `.husky/_`).

```sh
bun run check         # Repository-wide formatting and linting; no writes.
bun run lint          # Lint only; no writes.
bun run format:check  # Check formatting; no writes.
bun run format        # Explicitly format supported files; writes files.
bun run check:staged  # Check working-tree contents of staged supported paths.
bun run typecheck     # TypeScript, including tests and TS hook scripts.
bun run test          # Bun Test; no Docker/database needed.
```

| Hook | Complete hook contents | Purpose |
| --- | --- | --- |
| `.husky/pre-commit` | `bun run check:staged` | Reject formatting/lint failures; never fix or stage files. |
| `.husky/commit-msg` | `bun run commitmsg "$1"` | Check the first line of the supplied message file. |
| `.husky/pre-push` | `bun run typecheck && bun run test` | Run tests only after type checking succeeds; either failure rejects the operation. |

Use messages such as `feat(api): add health endpoint`, `fix: handle outage`,
or `refactor(api)!: change response shape`. Allowed types are `feat`, `fix`,
`docs`, `test`, `refactor`, `chore`, `perf`, `build`, `ci`, `style`, and `revert`.
The validator is `scripts/commit-msg.ts`, with no extra validation dependency.

Manually execute installed hooks without committing or pushing:

```sh
sh .husky/_/pre-commit
message_file=$(mktemp)
printf '%s\n' 'docs: explain hooks' > "$message_file"
sh .husky/_/commit-msg "$message_file" # Expected exit 0.
printf '%s\n' 'invalid message' > "$message_file"
sh .husky/_/commit-msg "$message_file" # Expected nonzero exit.
sh .husky/_/pre-push
```

These commands exercise hook scripts, not actual Git commits/pushes. Pre-commit
checks only staged paths; with no supported files staged it succeeds without
checking source. For partially staged files, unstaged edits affect the result:
review both `git diff` and `git diff --cached`, and prefer staging the complete
file after formatting. Local hooks can be bypassed and are not enforcement
outside your machine. See [LEARNING.md](LEARNING.md) for details.

## Continuous Integration (CI)

CI automatically validates changes on GitHub using
[`.github/workflows/ci.yml`](.github/workflows/ci.yml). The `push` and
`pull_request` triggers start the `CI` workflow. Its single job, `CI checks`,
runs on a fresh GitHub-hosted Ubuntu runner (a virtual machine). Steps execute
in order: checkout, install Bun 1.4.4, install locked dependencies, run Biome,
check TypeScript types, and run tests. A failed step fails the job and skips
later validation steps.

Run the equivalent checks locally:

```sh
HUSKY=0 bun install --frozen-lockfile
bun run check
bun run typecheck
bun run test
```

CI sets `HUSKY=0` to skip hook installation through the existing prepare script.
The current health test needs no PostgreSQL, Redis, Docker, or secrets. This
workflow only validates code; it does not deploy or provide continuous delivery.

Local hooks give feedback before a commit/push and can be bypassed. Remote CI
checks the code checked out by GitHub, independently of local hook setup. CI
starts after GitHub accepts a push, so a later failure cannot undo or reject
that push. To enforce passing checks before merging, configure branch protection
or a ruleset for the target branch, require pull requests, and make `CI checks`
a required status check. The workflow file does not configure these repository
settings; bypass permissions also affect enforcement.

To verify remotely after you choose to commit and push these changes:

1. Ensure GitHub Actions is enabled for the repository and permits the actions
   used here. Open the **Actions** tab and inspect the `CI` run for your commit.
2. Open a pull request and inspect **Checks** for the `pull_request` run. By
   default, checkout tests the proposed merge with the target branch.
3. Confirm `CI checks` passes and expand its steps to inspect install, Biome,
   typecheck, and test logs. Fork pull requests may need maintainer approval.
4. Once the check has run, select `CI checks` as required in branch protection
   or a ruleset if you want merge enforcement. These settings are not enabled
   by this change.

See [GitHub Actions concepts](https://docs.github.com/en/actions/get-started/understand-github-actions)
and [branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
