# 官方 API

Allocube 官方 API 面向 AI、CLI、脚本和服务端工具，稳定前缀为 `/api/open/v1`。网页内部使用的 `/api/v1` 不属于公开兼容契约。

## OpenAPI

- OpenAPI 3.1：`/api/open/v1/openapi.json`
- API 基础路径：`/api/open/v1`
- 时间：UTC RFC 3339
- ID：UUID
- 字段：`camelCase`

本页下方的端点目录直接从 OpenAPI 文档生成；字段和 Schema 以该文档为准。

本章所有必须替换的值均使用 `<UPPER_SNAKE_CASE>`。尖括号属于占位符标记，不能原样提交；完整规则见[文档占位符约定](/docs#文档占位符约定)。

除非特别写出完整路径，本章和端点参考中的路径都相对于基础路径 `/api/open/v1`。

## 创建个人访问令牌

在“用户信息 → 个人访问令牌”创建令牌，需要提供名称、权限和当前密码。

- `READ_ONLY`：查询资源、排期和本人占用。
- `READ_WRITE`：在只读能力基础上预检并提交本人占用操作。

令牌明文只显示一次。请保存到可信的密钥管理工具或进程环境变量，不要写入浏览器本地存储、日志、聊天记录或代码仓库。

```text
Authorization: Bearer <API_TOKEN>
```

官方 API 不接受网页 Cookie，也不回退到网页会话。

## 快速验证

```bash
export ALLOCUBE_BASE_URL="<BASE_URL>"
export ALLOCUBE_API_TOKEN="<API_TOKEN>"

curl \
  -H "Authorization: Bearer $ALLOCUBE_API_TOKEN" \
  "$ALLOCUBE_BASE_URL/api/open/v1/me"
```

成功响应统一为：

```json
{
  "data": {},
  "meta": {}
}
```

错误统一为：

```json
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "个人访问令牌无效、已到期或已吊销",
    "requestId": "<REQUEST_ID>"
  }
}
```

## 查询流程

典型调用顺序：

1. `GET /me` 确认令牌身份和权限。
2. `GET /machines` 查询有权使用的机器。
3. `GET /machines/{id}/resource-groups` 查询结构化资源分配。
4. `GET /schedule` 查询目标时间窗口。
5. `GET /reservations` 查询本人占用。

列表使用不透明游标。客户端只能把上一页返回的 `meta.nextCursor` 原样传入下一次请求的 `cursor`，不应解析或自行构造游标。

## 两阶段写入

所有创建、修改、取消和提前结束都必须先预检，再提交。

四种业务动作只使用两个 HTTP 端点：调用方在 `prepare` 请求体的 `action` 中选择 `CREATE`、`UPDATE`、`CANCEL` 或 `END`；`commit` 根据确认令牌找到已经绑定的预检动作，因此不需要再次发送 `action`。

### 第一步：预检

```json
{
  "action": "CREATE",
  "segments": [
    {
      "scope": "RESOURCE_GROUP",
      "resourceGroupId": "<RESOURCE_GROUP_ID>",
      "startMode": "SCHEDULED",
      "startAt": "<START_AT_RFC3339>",
      "endAt": "<END_AT_RFC3339>",
      "title": "模型训练",
      "purpose": "回归验证"
    }
  ]
}
```

发送到 `POST /reservation-operations/prepare`。`READY` 响应包含 5 分钟内有效的 `confirmationToken`；`BLOCKED` 只返回冲突和拆分建议，不能继续提交。

### 第二步：提交

```json
{
  "confirmationToken": "<CONFIRMATION_TOKEN>"
}
```

发送到 `POST /reservation-operations/commit`。确认令牌绑定签发它的用户和发起预检时使用的个人访问令牌，不能跨用户或跨令牌使用。

示例中的 `<CONFIRMATION_TOKEN>` 是统一格式的占位符。调用方必须把同一次 `prepare` 成功响应中的真实 `confirmationToken` 原样填入，不能提交占位符或文档示例值。

成功结果保留 24 小时。相同确认令牌重复提交会返回原结果，并在 `meta.replayed` 标记重放，不会重复创建占用。

### 四种操作

- `CREATE`：一次最多 100 个同范围片段。
- `UPDATE`：只能修改本人占用，不能更换资源组或占用范围。
- `CANCEL`：只能取消本人未来占用。
- `END`：只能提前结束本人进行中占用。

端点参考中的 `prepare` 请求体提供四种动作各自的完整 JSON 示例；它们不是四个独立 URL。

机器管理员身份不会扩大官方 API 的修改范围。

## 限流

- 每个令牌每分钟最多 120 个请求。
- 预检和提交合计每分钟最多 30 个请求。

遇到 `429 RATE_LIMITED` 时读取 `Retry-After`，等待后重试。不要立即循环请求。

## 安全与隐私

- API 不返回 CORS 许可头，不面向第三方浏览器页面。
- `/schedule` 只返回当前用户拥有使用权的机器；这些机器上的使用人姓名、工号、标题、用途、备注、原始时间和调整原因完整可见。
- 查看排期详情不会扩大写入权限；官方 API 始终只能修改令牌所有者本人的占用。
- 账号权限、机器成员关系、停用和删除状态在下一次请求立即生效。
- 密码修改或重置不会吊销个人访问令牌；需要单独吊销。

## 兼容策略

`/api/open/v1` 在 v1 生命周期内只接受向后兼容的新增，例如增加端点或可选响应字段；现有字段不会被删除、改名、改为必填，也不会改变既有语义。确需破坏兼容性的调整会使用新的主版本路径，例如 `/api/open/v2`。

客户端应忽略不认识的响应字段，以便兼容 v1 后续新增内容；请求体仍执行严格校验，不要发送 OpenAPI 未定义的字段。
