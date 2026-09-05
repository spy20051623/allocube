# Allocube

Allocube helps internal teams reserve shared computing resources. It groups logical cores, GPUs, memory, and other machine resources into bookable units, with access requests, scheduling, conflict detection, maintenance, notifications, reports, and audit logs built in.

The system only registers planned reservations; it does not control SSH, OS accounts, processes, hardware, nor does it collect actual CPU, GPU, or memory utilization metrics.

## Documentation Index

Explanatory content uses versioned Markdown files in the repository as the source of truth. After production builds, all sections are also publicly displayed in the `/docs` documentation center.

| Content | Repository Markdown | Frontend Documentation Center |
|---|---|---|
| Product Introduction & Capability Boundaries | [Home Page](docs/manual/en/README.md) | `/docs` |
| Registration, Review, Login & Password Recovery | [Getting Started](docs/manual/en/getting-started.md) | `/docs/getting-started` |
| Regular User Operations | [User Guide](docs/manual/en/user-guide.md) | `/docs/user-guide` |
| Machine Administrator Operations | [Machine Administrator Guide](docs/manual/en/machine-admin.md) | `/docs/machine-admin` |
| System Administrator Operations | [System Administrator Guide](docs/manual/en/system-admin.md) | `/docs/system-admin` |
| Initialization, Deployment, Upgrades & Backups | [Deployment & Operations](docs/manual/en/operations.md) | `/docs/operations` |
| API Tokens & Official API | [Official API](docs/manual/en/api.md) | `/docs/api` |
| Common Issues | [Troubleshooting](docs/manual/en/troubleshooting.md) | `/docs/troubleshooting` |

The OpenAPI 3.1 document served at `/api/open/v1/openapi.json` is the source of truth for API fields, constraints, and schemas. The web app's internal `/api/v1` endpoints are not part of the public compatibility contract.

## Local Development

Requires Node.js 22 or a newer supported version, and npm.

```text
npm ci
npm run dev
```

Open `http://localhost:5173`. Vite serves the frontend with hot reload and proxies API requests to the local Fastify server.

## Common Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start development frontend and API |
| `npm run typecheck` | Check frontend & backend TypeScript types |
| `npm test` | Run automated tests |
| `npm run build` | Generate production frontend and server code |
| `npm start` | Run the built service |
| `npm run test:production-http` | Check production HTTP & security contracts |
| `npm run backup` | Create a coordinated backup set for SQLite and private feedback images with verification |
| `npm run admin:reset-password` | Reset the Administrator password on the server side |

New databases do not generate demo resources or reservations. Direct production startup requires `NODE_ENV=production`, and initial setup also requires `BOOTSTRAP_ADMIN_PASSWORD`; `npm start` does not set the runtime mode automatically.

The health check endpoint is `/health`. For detailed environment variables, Docker Compose, backup/restore, and upgrade procedures, see [Deployment & Operations](docs/manual/en/operations.md).

## Technology Stack

- Frontend: React, TypeScript, Vite, TanStack Router.
- Server: Fastify, TypeScript.
- Database: SQLite with `better-sqlite3`; run only one Allocube instance per database.
- Deployment: One Node.js process serves the frontend, internal APIs, and official API. Caddy and Docker Compose can provide the public entry point and runtime environment.

For supplementary conventions related to interface terminology, see [Role-Aware Interface Language](docs/role-aware-language.en.md).
