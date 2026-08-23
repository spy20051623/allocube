# 部署与运维

Allocube 使用单个 Node.js 进程提供页面和 API，并使用 SQLite 保存数据。SQLite 部署只支持单应用实例。

## 运行要求

- Node.js 22 或更新的受支持版本。
- 本地持久磁盘；不要把 SQLite 文件放在 NFS、SMB 等网络文件系统。
- 生产环境建议由 Caddy 或其他反向代理提供域名和 TLS。

## 本地开发

```text
npm ci
npm run dev
```

开发页面默认运行在 `http://localhost:5173`，Fastify API 默认运行在 `127.0.0.1:8787` 并由 Vite 代理。不要混用 `localhost`、`127.0.0.1` 和其他地址访问同一会话。

## 生产构建

```text
npm ci
npm run build
npm start
```

生产构建由 Fastify 在一个端口同时提供静态页面和 API。

## 首次初始化

每次启动读取：

- `NODE_ENV`
- `HOST`
- `PORT`
- `DATABASE_PATH`

`BOOTSTRAP_*` 只在空数据库首次初始化时读取，包括管理员资料、站点地址、占用规则、演示数据和 SMTP。之后修改环境变量不会覆盖数据库中的管理设置。

生产部署必须为 `BOOTSTRAP_ADMIN_PASSWORD` 设置随机强密码，并保护 `.env.production`。

部署配置中的待替换值同样使用统一占位符格式。例如：

```dotenv
APP_DOMAIN=<ALLOCUBE_DOMAIN>
BOOTSTRAP_ADMIN_PASSWORD='<ADMIN_PASSWORD>'
BOOTSTRAP_SITE_ORIGIN=<BASE_URL>
```

复制后必须替换整个 `<PLACEHOLDER_NAME>`；不要把占位符原样用于生产启动。

## Docker Compose

```text
docker compose --env-file .env.production up -d --build
```

应用容器端口只用于容器内部通信，不应直接映射到公网。反向代理需要正确传递 `Host`、`X-Forwarded-Host` 和 `X-Forwarded-Proto`。

## 健康检查

```text
GET /health
```

正常时返回 `200` 和 `{"status":"ok"}`。数据库不可用时返回 `503`。

## 数据文件

主数据库默认为 `data/allocube.sqlite`，旁边的 `instance-secrets.json` 保存会话密钥和 SMTP 加密密钥。数据库、WAL、SHM、实例密钥、备份和环境文件都不得提交到代码仓库。

## 备份与恢复

```text
npm run backup
```

备份使用 SQLite 在线备份并执行完整性和结构版本检查。应同时安全备份：

- 数据库备份。
- `instance-secrets.json`。
- 备份加密凭据和部署配置。

实例密钥应与数据库备份分开保管。恢复时先停止应用，保留故障现场，再按同一版本程序恢复数据库和实例密钥。

## 升级与回滚

1. 阅读目标版本的数据库迁移说明。
2. 备份数据库和实例密钥。
3. 构建并启动新版本。
4. 检查 `/health`、登录、“资源日历”、写操作、邮件和备份。

数据库升级后，旧程序可能无法读取新结构。回滚必须同时恢复升级前数据库备份和旧镜像，不能只回滚程序文件。

## 管理员密码恢复

```text
npm run admin:reset-password
```

此命令应只在服务器本地执行。恢复完成后立即登录、修改临时密码并检查审计记录。

## 安全基线

- 对外服务优先使用 HTTPS，避免会话 Cookie 经明文网络传输。
- 限制数据库、实例密钥和环境文件只允许运行用户读取。
- 不在日志中记录密码、`Authorization`、确认令牌或请求正文。
- 定期检查 401、403、409、429、5xx、响应耗时、邮件失败和备份结果。
- 个人访问令牌默认可长期有效，应建立定期盘点和吊销流程。
