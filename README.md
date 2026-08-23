# Allocube

Allocube 是面向内部团队的计算资源占用系统。它把机器上的逻辑核、GPU、内存等资源整理为可占用的资源组，提供机器使用权申请、排期、冲突检查、维护、通知、统计和审计能力。

系统只登记计划占用，不控制 SSH、操作系统账号、进程或硬件，也不采集真实 CPU、GPU、内存利用率。

## 文档索引

说明性内容以仓库内的版本化 Markdown 为事实来源。生产构建后，所有章节也会公开展示在 `/docs` 文档中心。

| 内容 | 仓库 Markdown | 前端文档中心 |
|---|---|---|
| 产品介绍与能力边界 | [文档首页](docs/manual/README.md) | `/docs` |
| 注册、审核、登录与密码找回 | [开始使用](docs/manual/getting-started.md) | `/docs/getting-started` |
| 普通用户操作 | [普通用户指南](docs/manual/user-guide.md) | `/docs/user-guide` |
| 机器管理员操作 | [机器管理员指南](docs/manual/machine-admin.md) | `/docs/machine-admin` |
| 系统管理员操作 | [系统管理员指南](docs/manual/system-admin.md) | `/docs/system-admin` |
| 初始化、部署、升级和备份 | [部署与运维](docs/manual/operations.md) | `/docs/operations` |
| 个人访问令牌与官方 API | [官方 API](docs/manual/api.md) | `/docs/api` |
| 常见异常 | [故障排查](docs/manual/troubleshooting.md) | `/docs/troubleshooting` |

API 字段、约束和 Schema 的唯一事实来源是运行中服务公开的 OpenAPI 3.1 文档：`/api/open/v1/openapi.json`。网页内部使用的 `/api/v1` 不属于公开兼容契约。

## 本地开发

需要 Node.js 22 或更新的受支持版本以及 npm。

```text
npm ci
npm run dev
```

打开 `http://localhost:5173`。开发模式由 Vite 提供页面和热更新，并把 API 请求代理到本地 Fastify 服务。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | 启动开发页面和 API |
| `npm run typecheck` | 检查前后端 TypeScript 类型 |
| `npm test` | 运行自动测试 |
| `npm run build` | 生成生产页面和服务端代码 |
| `npm start` | 运行已构建的服务 |
| `npm run test:production-http` | 检查生产 HTTP 与安全契约 |
| `npm run backup` | 创建 SQLite 与私有反馈图片的配套校验备份集 |
| `npm run admin:reset-password` | 在服务器端恢复 Administrator 密码 |

健康检查地址为 `/health`。详细的环境变量、Docker Compose、备份恢复和升级步骤见[部署与运维](docs/manual/operations.md)。

## 技术组成

- 前端：React、TypeScript、Vite、TanStack Router。
- 服务端：Fastify、TypeScript。
- 数据库：SQLite、`better-sqlite3`，只支持单个应用实例。
- 部署：单个 Node.js 应用同时提供静态页面、内部接口和官方 API；可由 Caddy 和 Docker Compose 管理入口与运行环境。

与界面术语相关的补充约定见[角色化界面语言](docs/role-aware-language.md)。
