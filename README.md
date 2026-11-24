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

Direct dependencies are exact versions; `bun.lock` pins the resolved dependency
tree, and the Docker build uses `--frozen-lockfile`. Image tags pin versions,
but are not immutable content digests. Upstream images use version tags rather
than `latest`.

See [LEARNING.md](LEARNING.md) for networking, storage, initialization, and configuration.
