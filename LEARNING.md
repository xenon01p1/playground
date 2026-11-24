# Backend playground learning notes

## Containers and ports

Compose creates a private bridge network named `cbr-playground_default`.
Its DNS resolves service names: the API connects to **`db:5432`**.
The API connects to Redis at **`redis:6379`** for optional product caching
using ioredis; PostgreSQL remains the source of truth.

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
has its own health check but is not a required startup dependency for the API. `--wait` also waits for
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
| `REDIS_HOST`, `REDIS_PORT` | Host-run API/client endpoint, default `127.0.0.1:6380`; Compose explicitly sets `redis:6379` inside the API container. |

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
`/data`. Container replacement retains the volume, including unexpired cache entries.

## Tables and money

Each order represents one product and quantity. Both tables have generated
integer primary keys. Orders reference products, and deletion of a referenced
product is restricted. Names must be nonblank, quantities positive, and prices,
totals, and stock nonnegative. Required fields cannot be null.

`price` and `total` use integer minor units (for example, 1299 means 12.99
in a currency with two decimal places). PostgreSQL INTEGER supports amounts
up to 2,147,483,647 minor units; there are no floating-point money values.
The order total is a stored amount; no SQL constraint calculates it from the
product's current price. Phase 5.1 adds deliberately unsafe order creation and stock adjustment for local learning.

Timestamps include time zones and default to insertion time. `updated_at`
is initialized automatically. The product PATCH route updates it explicitly;
there is no SQL trigger for updates made outside the API.

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
PostgreSQL, Redis, or Docker services and needs no `.env` file. Product route
tests use injected fakes; the opt-in integration script is not run by CI. There is no
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

## Phase 4.1: Redis cache-aside

A cache is a disposable copy of data used to avoid repeated database work.
PostgreSQL owns products; Redis stores only JSON snapshots for GET requests.
The key `cache:product:{id}` uses the normalized numeric ID, so `/products/01`
and `/products/1` share `cache:product:1`.

1. GET checks Redis. A valid cached product returns immediately with `X-Cache: HIT`.
2. A missing key is a MISS. Query PostgreSQL with `$1`, not string interpolation.
3. An existing product is serialized as JSON and stored using `SET key value EX 60`.
   A 404 is not cached. HITs do not refresh expiry; 60 seconds is a fixed TTL.
4. Redis GET, parsing, or SET failures produce `BYPASS` and the PostgreSQL result.
   Invalid cache JSON/shape is not trusted. Internal details stay in server logs.
5. PATCH/DELETE first modify PostgreSQL, then `DEL` the product key. Failed or
   missing database writes do not invalidate. POST does not populate the cache.

TTL means time to live. `TTL key` returns remaining seconds, `-2` means absent,
and `-1` means no expiry (unexpected for keys created by this API). Redis expires
keys independently of HTTP traffic. Deletion/invalidation forces the next GET
to load the current database value, rather than waiting for TTL.

The cache client has a 500ms connection timeout, 500ms command timeout, zero
request retries, no offline queue, and no replay of unfulfilled commands.
A 1000ms socket timeout breaks unresponsive sockets so reconnection can proceed.
Reconnection keeps running in the background with delays capped at 2 seconds.
HTTP requests do not wait for that retry loop. Separate awaited commands can
add their own timeout delay; these values are not a whole-request deadline.
Redis is optional, so it does not affect health or database readiness.

Invalidation can fail after a database commit. Returning a write error would
misrepresent a successful write, so we log the failure and preserve the HTTP
success. The old key may reappear after reconnect and serve stale data until
its remaining TTL expires. A racing GET can read old PostgreSQL data and fill
the cache after another request invalidates it. These are deliberate limits of
basic cache-aside, not solved by TTL alone. There are no locks or retry jobs.

We pin `ioredis@5.10.0` with its bundled TypeScript types. BullMQ supports
[ioredis connections](https://docs.bullmq.io/guide/connections) and currently
[accepts ioredis >=5](https://github.com/taskforcesh/bullmq/blob/master/package.json).
No BullMQ dependency or queue is added. Future blocking workers need their own
connections and retry policy; this fail-fast cache connection is unsuitable.
See [ioredis connection options](https://github.com/redis/ioredis/blob/v5.10.0/lib/redis/RedisOptions.ts).

README contains exact curl/redis-cli commands for hits, misses, TTL, invalidation,
and outages. `bun run test` uses infrastructure-independent fakes to verify
failure handling and SQL/DEL ordering; `bun run test:integration` explicitly
checks the real HTTP/Redis path against Compose, including a true 60s expiry
and Redis stop/start. It is deliberately excluded from normal CI discovery.

## Phase 5.1: Unsafe order creation and race conditions

`POST /orders/unsafe` is deliberately unsafe and local-learning-only. It reads
stock directly from PostgreSQL, checks the requested quantity, waits 100ms with
`Bun.sleep(100)`, writes `newStock = stock - quantity`, inserts the order using
integer `price * quantity`, and then invalidates the existing product cache.
Redis never decides whether inventory is available. Invalid input returns 400,
a missing product 404, insufficient stock 409, and a created order 201.
Totals outside PostgreSQL INTEGER range are rejected before either write.

Two requests can both read stock 100 and each sell 10. Each independently
calculates 90 and writes 90, while both orders are recorded. This lost update
leaves stock 90 instead of 80. With enough concurrent requests, accepted orders
can exceed the original stock: overselling. The stock constraint can still
remain satisfied because every stale calculated value is nonnegative.
Cache invalidation does not serialize these PostgreSQL operations.

Run the actual HTTP experiment against Compose:

```sh
docker compose up --build -d --wait
bun run test:race
```

The script creates a new product with stock 100, sends 100 concurrent requests
for 10 units each using `Promise.allSettled`, and reads final stock and
`SUM(quantity)` directly from PostgreSQL for that product. Expected remaining
stock is `100 - total units sold` (deliberately not clamped to zero); oversold
units are `max(0, total units sold - 100)`. A stock mismatch or overselling means
the experiment detected the race. Results depend on scheduling; they are not
hardcoded. Non-201 HTTP responses count as rejected orders; network/timeouts
are reported separately as request errors. A timeout does not prove no write
occurred, which is why the database measurements matter.

Each run prints its dedicated product ID and retains the product and orders
for inspection. It does not delete data, reuse a previous experiment's product,
or run in normal CI. Unit tests separately cover validation, parameterized SQL,
invalidation after both writes, and Redis failure handling without Docker.

There are deliberately no transactions, locks, atomic conditional stock
updates, or mutexes. An insert failure can leave the earlier stock update
committed without an order or cache invalidation. Failed Redis invalidation
still preserves a successful order response and can leave stale cached stock.
These limitations are part of Phase 5.1; no concurrency solutions are added.

Observed Docker run: 100 successful orders, 0 rejected orders, 0 request errors,
1,000 units sold, expected remaining stock -900, actual stock 90, and 900 units
oversold. These are measured results from one run, not guaranteed future values.
