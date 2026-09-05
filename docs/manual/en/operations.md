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

```text
npm ci
npm run build
npm start
```

The production build is served by Fastify on a single port, providing both static pages and the API.

## Initial setup

Read on every startup:
- `NODE_ENV`
- `HOST`
- `PORT`
- `DATABASE_PATH`

`BOOTSTRAP_*` variables are only read during the initial setup of an empty database. This includes administrator profile information, site address, reservation rules, and SMTP. Subsequent changes to environment variables will not overwrite administrative settings stored in the database.

For production deployment, you must set `BOOTSTRAP_ADMIN_PASSWORD` to a random, strong password and protect the `.env.production` file.

Values to be replaced in deployment configurations also use a unified placeholder format. For example:

```dotenv
APP_DOMAIN=<ALLOCUBE_DOMAIN>
BOOTSTRAP_ADMIN_PASSWORD='<ADMIN_PASSWORD>'
BOOTSTRAP_SITE_ORIGIN=<BASE_URL>
```

After copying, you must replace the entire `<PLACEHOLDER_NAME>`; do not use placeholders as-is for production startup.

## Docker Compose

```text
docker compose --env-file .env.production up -d --build
```

Keep the application container port private. The reverse proxy must forward `Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto` correctly.

Use the repository's cached build script for repeated production image builds:

```text
sh scripts/build-docker-release.sh RELEASE_ID BUILD_CONTEXT
```

The script keeps dependency layers in named Docker images and stores stable offline archives under `/opt/allocube-build-cache`; each archive also contains the Node base image. Every build first looks for the archive and image matching its dependency inputs. A hit is reused with networking disabled. A genuine miss downloads the missing dependencies once and immediately writes the refreshed cache back to the same directory for later builds. The cache key covers `package.json`, `package-lock.json`, `Dockerfile`, the base image name, and package mirror settings so that valid caches are found reliably without unsafe reuse. Do not remove `allocube-build-cache:*` during Docker image cleanup, and include the offline archive in server disk backups.

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

Older Allocube versions may not understand a newer database schema. For example, schema version 17 added feedback data and private images. To roll back, restore the pre-upgrade database, matching image backup, instance secrets, and old application image together. Replacing only the application files is not enough.

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
