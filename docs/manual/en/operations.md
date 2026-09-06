# Deployment and operations

Allocube uses one Node.js process for the web app and APIs, with SQLite for storage. Run only one Allocube instance per database.

## Runtime requirements

- Node.js 22 or a newer supported version.
- Local persistent disk; do not place SQLite files on network filesystems like NFS or SMB.
- In production, use Caddy or another reverse proxy to provide a domain and TLS.

## Local development

```text
npm ci
npm run dev
```

The development frontend runs by default on `http://localhost:5173`, and the Fastify API runs by default on `127.0.0.1:8787` and is proxied by Vite. Do not mix `localhost`, `127.0.0.1`, and other addresses within the same session.

## Production build

When running Node.js directly, set `NODE_ENV=production` in the process environment or a `.env` file in the working directory before starting. Initial deployment also requires `BOOTSTRAP_ADMIN_PASSWORD`. A minimal `.env` is:

```dotenv
NODE_ENV=production
BOOTSTRAP_ADMIN_PASSWORD='<ADMIN_PASSWORD>'
```

Replace the password placeholder before running the commands below. Neither `npm run build` nor `npm start` automatically selects production runtime mode. The service reads `.env` from its working directory; existing process environment variables take precedence. Direct Node.js startup does not automatically read `.env.production`; Docker Compose loads that file as described below.

```text
npm ci --include=dev
npm run build
npm start
```

The production build is served by Fastify on a single port, providing both static pages and the API. Building requires development dependencies, so keep `--include=dev` even when `NODE_ENV=production` is already set during installation.

## Initial setup

A new database creates only initial settings and the Administrator account. It does not generate machines, resource groups, demo users, or sample reservations. `BOOTSTRAP_DEMO_DATA` has been removed; upgrades do not automatically delete existing data. An empty calendar is expected until a system administrator creates machines and resource groups. Keep acceptance-test data in a separate database.

Read on every startup:
- `NODE_ENV`
- `HOST`
- `PORT`
- `DATABASE_PATH`

`BOOTSTRAP_*` variables are only read during the initial setup of an empty database. This includes administrator profile information, site address, reservation rules, and SMTP. Subsequent changes to environment variables will not overwrite administrative settings stored in the database.

For initial production setup, you must explicitly set `BOOTSTRAP_ADMIN_PASSWORD` to a random, strong password and protect the `.env.production` file. An unset or empty value, the legacy default administrator password, or a value that fails the existing password policy causes the service to exit with a nonzero status without opening an HTTP port. Passwords must contain 8–64 printable ASCII characters with no spaces, include letters and digits, and must not be a common password or the administrator username. The service does not trim or rewrite the supplied password.

Failed password validation may leave an empty database schema and instance secrets, but does not persist an administrator, configuration, or initialization marker. Correct the password and restart using the same data directory; do not delete the database or secrets. Development and test environments retain their existing default initialization behavior.

Previously initialized instances do not need this variable when upgrading, and their administrator passwords are neither revalidated nor overwritten. This fix does not remove the default-password risk from existing instances: operators must check and change those passwords themselves. Change the password after signing in, or use the server-side command under “Administrator password recovery” below if you cannot sign in. Changing `BOOTSTRAP_ADMIN_PASSWORD` does not reset an existing account password.

Values to be replaced in deployment configurations also use a unified placeholder format. For example:

```dotenv
APP_DOMAIN=<ALLOCUBE_DOMAIN>
BOOTSTRAP_ADMIN_PASSWORD='<ADMIN_PASSWORD>'
BOOTSTRAP_SITE_ORIGIN=<BASE_URL>
```

After copying, you must replace the entire `<PLACEHOLDER_NAME>`; do not use placeholders as-is for production startup.

## Docker Compose

For a new deployment, copy `.env.production.example` to `.env.production` and set the domain and strong administrator password before starting. Existing deployments retain their current data volume and configuration file.

```text
docker compose --env-file .env.production up -d --build
```

Keep the application container port private. The reverse proxy must forward `Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto` correctly.

Use the repository's cached build script for repeated production image builds:

```text
sh scripts/build-docker-release.sh RELEASE_ID BUILD_CONTEXT
```

The script keeps dependency layers in named Docker images and stores stable offline archives under `/opt/allocube-build-cache`; each archive also contains the Node base image. Every build first looks for the archive and image matching its dependency inputs. A hit is reused with networking disabled. A genuine miss downloads the missing dependencies once and immediately writes the refreshed cache back to the same directory for later builds. The cache key covers `package.json`, `package-lock.json`, `Dockerfile`, the base image name, and package mirror settings so that valid caches are found reliably without unsafe reuse. Do not remove `allocube-build-cache:*` during Docker image cleanup, and include the offline archive in server disk backups.

Override the writable cache location with `ALLOCUBE_BUILD_CACHE_DIR`; offline archives include a `.tar` and matching `.manifest`. Application-only changes can reuse the dependency cache, while changed dependency inputs or missing caches require an online fill. The cache script defaults to Aliyun Debian mirrors, configurable through `DEBIAN_MIRROR` and `DEBIAN_SECURITY_MIRROR`; direct Docker builds default to Debian's official mirrors. The build image includes Python, make, and a C++ compiler for native modules.

## Health check

```text
GET /health
```

Returns `200` and `{"status":"ok"}` when healthy. Returns `503` if the database is unavailable.

## Data files

The main database defaults to `data/allocube.sqlite`. Private feedback images are located in `data/feedback-images` on the same persistent data volume. The `instance-secrets.json` file, located alongside, stores session keys and the SMTP encryption key. The database, images, WAL, SHM files, instance secrets, backups, and environment files must not be committed to the code repository; `feedback-images` must not be mapped as a public static directory.

## Backup and restore

```text
npm run backup
```

The backup uses SQLite online backup and performs integrity and schema version checks. The command creates a timestamped backup set containing `allocube.sqlite`, the valid `feedback-images` referenced by that database snapshot, and a `manifest.json`. The manifest records the file count, total size, and the SHA-256 hash of each file; if any valid image is missing or its size mismatches, the entire backup fails and no incomplete backup set is published. You should also securely back up:
- The complete database and feedback images backup set.
- `instance-secrets.json`.
- Backup encryption credentials and deployment configuration.

Store instance secrets separately from the backup set. Before restoring, stop Allocube and preserve the failed deployment for investigation. Verify every SHA-256 hash in `manifest.json`, then restore the database, `feedback-images`, and instance secrets together with the same Allocube version. Never combine a database snapshot with images from a different point in time.

## Upgrade and rollback

1. Read the database migration notes for the target version.
2. Generate and verify a database and feedback images backup set. Separately back up the instance secrets.
3. Build and start the new version.
4. Check `/health`, login, "Calendar", feedback and private images, notification badges, write operations, email delivery, and the backup manifest.

The current database schema version is 20. Startup applies supported migrations automatically. Recent changes are:

| Version | Change |
|---|---|
| 17 | Feedback tickets and private images |
| 18 | Translation templates and parameters for in-app notifications |
| 19 | Deduplication records for overdue administrator review emails |
| 20 | Daily usage statistics, report versions, and full recalculation tasks |

The earlier Reservations redesign and production bootstrap-password fix did not add schema changes. After upgrading, check atomic editing-sequence submissions, redirects from old `/reservations` links, and administrator review reminders. Existing instances do not need a bootstrap password variable, but operators must still check for legacy default passwords.

The internal `/api/v1/reservations/mine` endpoint now uses category queries, filters, and cursor pagination, defaulting to upcoming reservations only. Scripts calling the former internal endpoint require adaptation; prefer the official `/api/open/v1` API. This update does not change the official API contract.

Older Allocube versions may not understand a newer database schema. For example, schema version 17 added feedback data and private images. To roll back, restore the pre-upgrade database, matching image backup, instance secrets, and old application image together. Replacing only the application files is not enough.

## Daily statistics worker

After the version 20 migration, HTTP starts before a single background Worker backfills history using its own SQLite connection. No system cron is required. It checks the 06:00 Beijing settlement boundary every minute, catches up after downtime, and retries routine failures after five minutes without blocking HTTP startup.

Snapshots, day completion markers, and rebuild progress reside in SQLite and are included in existing backups. Restarts and restored databases resume unfinished dates without double counting. Full recalculation builds a separate version and switches only after completion; failures retain previous results. Obsolete versions are cleaned up day by day. Allow additional disk space for both versions during rebuilding.

Logs include completed dates, durations, and errors; audits record the full recalculation requester, range, and outcome. Statistics do not change calendar revisions or send reservation notifications. Do not delete statistics tables to recover from errors. Check disk space, permissions, and logs, then request another full recalculation from Usage statistics.

Internal `/api/v1/admin/report` now accepts inclusive `fromDate` and `toDate` values (`YYYY-MM-DD`), replacing ISO timestamp parameters. CSV export and the internal `/api/v1/admin/report.csv` endpoint have been removed. Internal rebuild and status endpoints are added; the official `/api/open/v1` contract is unchanged. Back up before upgrading; rollback requires the complete version 19 backup and matching application.

## Live updates and acceptance checks

The web client continues to use SSE at `/api/v1/events`. Internal `revision` events retain the schedule revision and add a protocol version, independent event ID, data categories, and machine/time scopes. Permission changes need not increment the schedule revision. Delivery uses current permissions and still reaches users whose access was revoked. Events contain refresh identifiers, not reservation descriptions or user profiles. Announcement and feedback delivery, statistics settlement and task polling, and the official `/api/open/v1` contract are unchanged.

Temporary triggers on the main SQLite connection capture before/after changes within transactions and publish only after commit. Rollbacks and official API idempotent replays do not publish duplicate changes. The temporary journal is not part of the persistent schema or backups; no migration is required. After a restart, clients reconnect and query again without relying on event history. Continue using a single application writer process: direct business-table writes through other connections do not enter this connection's temporary journal.

Clients coalesce events and post-operation refreshes within 200 milliseconds, keeping one request in flight and at most one trailing refresh per query. Hidden pages pause ordinary reads and disconnected fallback polling, then synchronize when visible; revoked access is handled immediately. Legacy or unknown events fall back to a coalesced sync of open modules, and old clients still recognize `revision` events. If system settings change while a form has unsaved input, the page requests a reload and review instead of overwriting that input.

Reverse proxies should support long-lived SSE connections without buffering events. After building, run `npm run test:realtime-http` to check multi-user delivery, atomic cross-machine changes, silent rollbacks, and revocation against a separate temporary database. `npm run test:production-http` checks production HTTP and the official API. Browser acceptance should cover unrelated machines and dates making no extra queries, hidden/visible transitions, reconnection, and draft preservation.

## Administrator password recovery

```text
npm run admin:reset-password
```

This command should only be executed locally on the server. After recovery, log in immediately, change the temporary password, and review the audit log.

## Security baseline

- Prioritize HTTPS for external services to avoid transmitting session cookies over plaintext networks.
- Restrict file permissions so that only the runtime user can read the database, instance secrets, and environment files.
- Do not log passwords, `Authorization` headers, confirmation tokens, or request bodies.
- Regularly monitor for 401, 403, 409, 429, 5xx errors, response latency, email delivery failures, and backup results.
- Personal access tokens are valid indefinitely by default; establish a regular review and revocation process.
