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

直接运行 Node.js 服务时，先在进程环境或工作目录的 `.env` 中设置 `NODE_ENV=production`；首次部署还必须设置 `BOOTSTRAP_ADMIN_PASSWORD`。例如 `.env` 的最小配置：

```dotenv
NODE_ENV=production
BOOTSTRAP_ADMIN_PASSWORD='<ADMIN_PASSWORD>'
```

替换密码占位符后再运行下列命令。`npm run build` 和 `npm start` 不会自动把运行模式设为生产。服务自动读取工作目录的 `.env`，已有进程环境变量优先；直接运行时不会自动读取 `.env.production`，后者由下文 Docker Compose 加载。

```text
npm ci --include=dev
npm run build
npm start
```

生产构建由 Fastify 在一个端口同时提供静态页面和 API。构建需要开发依赖，因此即使安装时已设置 `NODE_ENV=production`，也要使用 `--include=dev`。

## 首次初始化

全新数据库只创建初始化配置和 Administrator 账号，不自动生成机器、资源组、演示用户或示例占用。`BOOTSTRAP_DEMO_DATA` 已移除；升级不会自动删除已有数据。首次看到空日历是正常情况，应由系统管理员创建机器和资源组。验收数据应放在独立测试数据库中。

每次启动读取：

- `NODE_ENV`
- `HOST`
- `PORT`
- `DATABASE_PATH`

`BOOTSTRAP_*` 只在空数据库首次初始化时读取，包括管理员资料、站点地址、占用规则和 SMTP。之后修改环境变量不会覆盖数据库中的管理设置。

生产首次初始化必须为 `BOOTSTRAP_ADMIN_PASSWORD` 显式设置随机强密码，并保护 `.env.production`。未设置、空值、旧默认管理员密码或不符合现有密码规则的值都会导致服务以非零状态退出，不开放 HTTP 端口。密码须为 8–64 位可打印半角字符，不含空格，包含字母和数字，且不能是常见密码或管理员用户名；服务不会自动修剪或改写输入。

密码校验失败后可能留下空数据库结构和实例密钥，但不会写入管理员、持久配置或初始化完成标记。修正密码后使用原数据目录重新启动即可，无需删除数据库或密钥。开发与测试环境保留原有默认初始化行为。

已初始化实例升级后无需补填此变量，也不会重新校验或覆盖已有管理员密码。本次修复不会消除已有实例的默认密码风险，运维人员仍需自行确认并更换；正常情况下登录后修改密码，无法登录时使用下文“管理员密码恢复”的服务器端命令。修改 `BOOTSTRAP_ADMIN_PASSWORD` 不会重置已有账号密码。

部署配置中的待替换值同样使用统一占位符格式。例如：

```dotenv
APP_DOMAIN=<ALLOCUBE_DOMAIN>
BOOTSTRAP_ADMIN_PASSWORD='<ADMIN_PASSWORD>'
BOOTSTRAP_SITE_ORIGIN=<BASE_URL>
```

复制后必须替换整个 `<PLACEHOLDER_NAME>`；不要把占位符原样用于生产启动。

## Docker Compose

首次部署先将 `.env.production.example` 复制为 `.env.production`，填写域名和管理员强密码，再启动。已有部署沿用原数据卷和配置文件。

```text
docker compose --env-file .env.production up -d --build
```

应用容器端口只用于容器内部通信，不应直接映射到公网。反向代理需要正确传递 `Host`、`X-Forwarded-Host` 和 `X-Forwarded-Proto`。

重复构建生产镜像时使用仓库内的缓存构建脚本：

```text
sh scripts/build-docker-release.sh RELEASE_ID BUILD_CONTEXT
```

脚本将依赖层保存为具名 Docker 镜像，并默认在 `/opt/allocube-build-cache` 保留按依赖输入区分、同时包含 Node 基础镜像的离线归档。每次构建先查找对应归档和镜像：命中时断网复用；确实没有时自动联网补齐一次，并立即写回该目录，下一次构建继续复用。依赖输入包括 `package.json`、`package-lock.json`、`Dockerfile`、基础镜像名称和软件源配置，避免错误复用或无故失效。清理 Docker 镜像时不得删除 `allocube-build-cache:*`，离线归档也应纳入服务器磁盘备份。

缓存目录可通过 `ALLOCUBE_BUILD_CACHE_DIR` 修改，目录需可写；离线归档包含 `.tar` 和配套 `.manifest`。仅修改业务代码可复用依赖缓存，依赖输入变化或缓存丢失时需要联网补齐。缓存脚本默认使用阿里云 Debian 镜像，可通过 `DEBIAN_MIRROR`、`DEBIAN_SECURITY_MIRROR` 调整；直接 Docker 构建默认使用 Debian 官方源。镜像内已安装原生模块构建需要的 Python、make 和 C++ 编译器。

## 健康检查

```text
GET /health
```

正常时返回 `200` 和 `{"status":"ok"}`。数据库不可用时返回 `503`。

## 数据文件

主数据库默认为 `data/allocube.sqlite`，私有反馈图片位于同一持久化数据卷的 `data/feedback-images`，旁边的 `instance-secrets.json` 保存会话密钥和 SMTP 加密密钥。数据库、图片、WAL、SHM、实例密钥、备份和环境文件都不得提交到代码仓库；`feedback-images` 不能映射为公开静态目录。

## 备份与恢复

```text
npm run backup
```

备份使用 SQLite 在线备份并执行完整性和结构版本检查。命令会创建一个时间戳备份集，其中包含 `allocube.sqlite`、该数据库快照引用的有效 `feedback-images` 图片和 `manifest.json`。清单记录文件数量、总大小和每个文件的 SHA-256；任一有效图片缺失或大小不符时整次备份失败，不会发布不完整备份集。应同时安全备份：

- 完整的数据库加反馈图片备份集。
- `instance-secrets.json`。
- 备份加密凭据和部署配置。

实例密钥应与备份集分开保管。恢复时先停止应用并保留故障现场，验证 `manifest.json` 中全部 SHA-256 后，再按同一版本程序将数据库、`feedback-images` 和实例密钥作为一个整体恢复。不得将一份数据库与另一时间点的图片目录混用。

## 升级与回滚

1. 阅读目标版本的数据库迁移说明。
2. 生成并校验数据库加反馈图片备份集，另行备份实例密钥。
3. 构建并启动新版本。
4. 检查 `/health`、登录、“资源日历”、反馈创建与图片读取权限、通知红点、图片持久化、写操作、邮件和备份清单。

当前数据库结构版本为 19，启动时会自动执行适用的迁移。近期涉及：

| 版本 | 变化 |
|---|---|
| 17 | 反馈工单及私有图片 |
| 18 | 站内通知的翻译模板与参数 |
| 19 | 管理员超时审核邮件的去重记录 |

本轮“我的占用”重构与生产初始化密码修复不新增数据库结构。升级后应检查日历编辑序列的整批提交、旧 `/reservations` 链接跳转，以及管理员审核提醒。现有实例无需补填初始化密码；此前的默认密码风险仍需自行排查。

网页内部 `/api/v1/reservations/mine` 已改为分类查询、筛选和游标分页，默认只返回未开始占用。曾直接调用旧内部接口的脚本需适配，建议迁移到官方 `/api/open/v1`；本轮未改变官方 API 契约。

数据库升级后，旧程序可能无法读取新结构。特别是结构版本 17 引入反馈数据和私有图片，回滚必须同时恢复升级前数据库、与其配套的图片备份、实例密钥和旧镜像，不能只回滚程序文件。

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
