# Backend playground learning notes

## Containers and ports

Compose creates a private bridge network named `cbr-playground_default`.
Its DNS resolves service names: the API connects to **`db:5432`**.
Other containers could reach Redis at **`redis:6379`**, but this API does not
use Redis and has no Redis client dependency.

`localhost` inside a container means that container itself. The API listens
on `0.0.0.0:3000` so Docker can forward requests to it.

| Service | Address from the host | Port inside the container |
| --- | --- | --- |
| API | `127.0.0.1:3100` | `3000` |
| PostgreSQL | `127.0.0.1:5433` | `5432` |
| Redis | `127.0.0.1:6380` | `6379` |

Published ports bind to IPv4 loopback, so they are reachable locally.
Host port changes do not change internal service addresses. PostgreSQL and
Redis host publications are for learning and direct tools; the API does not
need them to communicate with the database.

The API waits for the database health check on initial Compose startup. Redis
has its own health check but is not an API dependency. `--wait` also waits for
Redis to become healthy. Startup dependencies do not prevent later outages
or automatically restart dependent services.

## Environment variables

Compose reads `.env` for interpolation; it passes only the listed variables
to each container. `.env.example` documents values without real credentials.

| Variable in `.env` | Purpose |
| --- | --- |
| `POSTGRES_USER` | Initial database role; also passed to the API as `PGUSER`. |
| `POSTGRES_PASSWORD` | Initial database password; passed to the API as `PGPASSWORD`. |
| `POSTGRES_DB` | Initial database name; passed to the API as `PGDATABASE`. |
| `API_HOST_PORT` | Host port forwarded to API port 3000; default 3100. |
| `POSTGRES_HOST_PORT` | Host port forwarded to database port 5432; default 5433. |
| `REDIS_HOST_PORT` | Host port forwarded to Redis port 6379; default 6380. |

Compose also sets API variables `PGHOST=db` and `PGPORT=5432`. `pg` reads
these standard PostgreSQL client variables directly. Separating fields avoids
having to URL-encode passwords in a connection string. Redis has no credentials
in this local learning setup. Database credentials remain visible to anyone
with access to the Docker daemon; this is not a production secrets system.

If a preferred host port is occupied, change only its `*_HOST_PORT` in `.env`
(for example, 3101, 5434, or 6381), then run `docker compose up -d --wait`.

## Persistence and initialization

The named volume `cbr-playground_postgres_data` is mounted at
`/var/lib/postgresql/data`. `cbr-playground_redis_data` is mounted at `/data`.
They live in Docker's storage, not in this repository. With the `desktop-linux`
context, that storage is inside Docker Desktop's Linux VM. Inspect them using:

```sh
docker volume inspect cbr-playground_postgres_data cbr-playground_redis_data
```

PostgreSQL runs `db/init.sql` from `/docker-entrypoint-initdb.d/01-init.sql`
only when its data directory is empty. The read-only SQL bind mount uses `Z`
for Fedora SELinux labeling. Initialization creates the configured role and
database, then creates both tables in a transaction. No seed data is inserted.
The TCP database health check waits for the final database server rather than
the temporary socket-only initialization server.

Restarting containers does not rerun SQL. Editing `init.sql` or changing initial
database credentials in `.env` does not alter an existing database volume.
For later schema changes, apply reviewed SQL to the existing database; do not
delete the volume to rerun initialization. Changing the password requires
changing the database role password as well as `.env`.

Redis starts with append-only persistence enabled, writing its data under
`/data`. Container replacement retains the volume. No cache behavior exists yet.

## Tables and money

Each order represents one product and quantity. Both tables have generated
integer primary keys. Orders reference products, and deletion of a referenced
product is restricted. Names must be nonblank, quantities positive, and prices,
totals, and stock nonnegative. Required fields cannot be null.

`price` and `total` use integer minor units (for example, 1299 means 12.99
in a currency with two decimal places). PostgreSQL INTEGER supports amounts
up to 2,147,483,647 minor units; there are no floating-point money values.
The order total is a stored amount; no SQL constraint calculates it from the
product's current price. There is no order processing or stock adjustment yet.

Timestamps include time zones and default to insertion time. `updated_at`
is initialized automatically but must be explicitly set in any future UPDATE;
there is no trigger to maintain it yet.

## Health and readiness

`GET /health` returns 200 with `{"status":"ok"}` when the API process can
answer HTTP. It never queries the database.

`GET /ready` executes `SELECT 1` through a small connection pool. Success
returns 200 with `{"status":"ready"}`; database errors return 503 with
`{"status":"unavailable"}`. It checks connectivity, not table presence or Redis.

The pool allows at most five connections. Connection establishment and waiting
for a pool connection are bounded at two seconds. Client query and server
statement timeouts are also two seconds each; an individual request may spend
time both acquiring a connection and executing SQL. Idle connections expire
after ten seconds. Idle connection errors are handled so an outage does not
crash the API, and subsequent requests can reconnect when PostgreSQL returns.

References: [Hono on Bun](https://hono.dev/docs/getting-started/bun),
[pg pool options](https://node-postgres.com/apis/pool),
[pg client timeouts](https://node-postgres.com/apis/client),
[PostgreSQL image initialization](https://hub.docker.com/_/postgres), and
[Redis image](https://hub.docker.com/_/redis).

## Git hooks and development automation

Native Git hooks are executable programs Git runs at named points in an
operation. Their default directory is `.git/hooks`, which is not tracked or
copied by a clone. Husky configures `core.hooksPath` to `.husky/_`, generates
the executable wrappers there, and dispatches to our tracked `.husky` scripts.
The generated `_` directory is ignored by Git. Husky manages installation;
Git still decides when to run each hook.

`bun install` runs our `prepare` script (`scripts/prepare.mjs`), which installs
these wrappers and reports installation errors. This makes setup reproducible
after cloning. Docker copies that script but installs only runtime dependencies
with `HUSKY=0`; the script exits before importing the omitted Husky dependency.
No Git repository or development tools are needed in the production image.

### Checks and exit codes

`biome.json` configures two-space formatting, single-quoted TypeScript strings,
and recommended lint rules. We explicitly include `.ts`, `.mjs`, and `.json`
files and respect Git ignores. SQL, YAML, Markdown, shell hooks, and `bun.lock`
are outside this configuration. `check` combines formatting and linting;
`lint` and `format:check` run them separately. Only the explicit `format`
command writes files. Check/lint commands also fail on warnings.

`pre-commit` runs `check:staged`. Biome selects staged paths and checks their
working-tree contents. It never runs with `--write` and never calls `git add`.
This keeps staging under your control but does **not** validate the exact index
snapshot of a partially staged file: good unstaged changes can hide bad staged
content, and bad unstaged changes can reject good staged content. Staging a whole
file after formatting avoids that mismatch. Deleted and unsupported paths do
not need checks. Repository-wide `check` also covers unstaged and untracked
supported files, while `check:staged` covers only staged paths.

`commit-msg` receives the proposed message file as its first argument. A small
regular expression checks its first line: an allowed lowercase type, optional
scope, optional `!`, colon, space, and nonempty description. Bodies and footers
are not validated. Merge/revert/fixup messages without that header shape are
rejected too; write a conforming message when these hooks run.

`pre-push` runs type checking and then `bun test` on the current working tree.
`&&` stops the sequence if type checking fails and otherwise returns the test
command's exit code. It does not inspect every outgoing commit or match a dirty
working tree to the commits being pushed. The health test imports `src/app.ts`
and calls Hono's `app.request()` directly. `src/index.ts` alone opens the HTTP
server. The PostgreSQL pool connects lazily, so testing `/health` needs neither
a database nor a listening port; database query behavior is unchanged.

An exit code of 0 means success. A nonzero result from these hooks tells Git to
abort the corresponding operation. Directly running a hook only proves its
exit behavior; it does not prove an actual commit or push was rejected.

### Limits and manual experiments

Git hooks are local convenience checks. A developer can skip relevant hooks
with `git commit --no-verify` or `git push --no-verify`, set `HUSKY=0`, change
the local hook configuration, or uninstall them. They do not replace checks
on a shared server; the CI workflow below supplies remote validation.

README lists all manual commands and the exact hook contents. To experiment
with failures, use a disposable copy: stage badly formatted TypeScript and run
`sh .husky/_/pre-commit`; write an invalid message to a temporary file and pass
it to `sh .husky/_/commit-msg`; add a test with a deliberately false assertion
and run `sh .husky/_/pre-push`. Restore the fixture before continuing.

During hook validation, direct execution of the installed Husky wrappers
in a temporary Git repository rejected formatting, lint, invalid-message, and
test failures. Passing fixtures succeeded, the failed test was removed, and
the real repository's index was left unchanged. No commit or push was attempted.

References: [Husky setup and skipping hooks](https://typicode.github.io/husky/how-to.html)
and [Biome CLI](https://biomejs.dev/reference/cli/).

## Phase 2: Continuous Integration with GitHub Actions

Continuous Integration (CI) runs automated validation when code changes are
shared, helping detect problems before merging. In this project,
`.github/workflows/ci.yml` reuses the same package scripts as local development.

| Workflow concept | Meaning in this project |
| --- | --- |
| Trigger (`on`) | `push` runs for pushed branches/tags; `pull_request` runs by default when a PR is opened, reopened, or its head branch is updated. No branch filters are set. |
| Job (`jobs.checks`) | `CI checks` groups validation on one runner and reports a status to GitHub. |
| Runner (`runs-on`) | `ubuntu-latest` selects a fresh GitHub-hosted Ubuntu virtual machine; it does not use the developer's machine or installed packages. |
| Step (`steps`) | An ordered action (`uses`) or shell command (`run`). Later validation steps run only if earlier steps succeed. |

`actions/checkout@v7` retrieves repository code and `oven-sh/setup-bun@v2`
installs Bun 1.4.4. These are current action major versions; the Bun runtime
version is pinned separately. `bun install --frozen-lockfile` installs the
dependency versions in `bun.lock` and fails if the manifest requires lockfile
changes. Commit the manifest and lockfile together when dependencies change.
The job grants only `contents: read` token permission and sets `HUSKY=0` so
`scripts/prepare.mjs` skips local hook installation.

The remaining steps run `bun run check`, `bun run typecheck`, and
`bun run test`. Biome's existing configuration does not check YAML or Markdown;
passing Biome alone does not validate the workflow file. The health test calls
`app.request('/health')` without querying the database, so this job starts no
PostgreSQL, Redis, or Docker services and needs no `.env` file. There is no
deployment or continuous delivery stage.

### Local feedback and remote enforcement

Local hooks run on the developer's current working tree before Git completes
an operation. They are fast feedback but depend on local installation and can
be skipped. CI runs independently on GitHub's checkout: for a push, the pushed
commit; for a pull request, normally GitHub's proposed merge commit with the
target branch. A branch with an open PR can therefore produce both push and
PR runs. CI does not run the commit-message hook or enforce message conventions.

A failing remote check records a failure after the push was accepted. It does
not roll back that push or automatically prevent another one. Branch protection
or rulesets provide enforcement: require pull requests and select `CI checks`
as a required status check for the target branch. GitHub then gates merging on
that result, subject to configured bypass permissions. This can restrict direct
pushes to the protected branch while allowing failing work on feature branches.
Adding YAML alone does not enable protection; repository settings must be
configured separately after the check has appeared.

For local commands and remote verification steps, see README's CI section.
Local success checks the current workspace; only a run in GitHub's Actions tab
verifies execution on a GitHub runner.

References: [GitHub Actions concepts](https://docs.github.com/en/actions/get-started/understand-github-actions),
[checkout](https://github.com/actions/checkout),
[setup-bun](https://github.com/oven-sh/setup-bun), and
[required status checks and branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
