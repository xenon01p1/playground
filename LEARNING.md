# Phase 1 notes

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
