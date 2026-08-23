const requestIdHeader = {
  description: "本次请求的唯一标识；联系管理员排查问题时请提供此值",
  schema: { type: "string" }
};

const rateLimitHeader = {
  description: "当前令牌在该类接口上的每分钟请求上限",
  schema: { type: "integer", minimum: 1 }
};

const retryAfterHeader = {
  description: "触发限流后建议等待的秒数",
  schema: { type: "integer", minimum: 1 }
};

const successResponseHeaders = {
  "X-Request-Id": requestIdHeader,
  "X-RateLimit-Limit": rateLimitHeader
};

function errorResponse(description: string, options: { retryAfter?: boolean } = {}) {
  return {
    description,
    headers: {
      "X-Request-Id": requestIdHeader,
      ...(options.retryAfter ? { "Retry-After": retryAfterHeader } : {})
    },
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ErrorResponse" }
      }
    }
  };
}

const unauthenticatedResponse = errorResponse(
  "缺少 Bearer 令牌，或令牌无效、已到期、已吊销，或所属账号已停用"
);
const readRateLimitedResponse = errorResponse(
  "令牌超过每分钟 120 次的整体请求限制；按 Retry-After 等待后重试",
  { retryAfter: true }
);
const operationRateLimitedResponse = errorResponse(
  "令牌超过每分钟 120 次的整体请求限制，或预检与提交合计超过每分钟 30 次；按 Retry-After 等待后重试",
  { retryAfter: true }
);
const writeScopeResponse = errorResponse(
  "令牌不是 READ_WRITE，或当前用户不再具备执行该写操作所需的权限"
);
const internalErrorResponse = errorResponse(
  "服务器处理请求时发生未预期错误；可携带响应中的 requestId 联系管理员排查"
);

const bearerSecurity = [{ bearerAuth: [] }];

export const OPEN_API_DOCUMENT = {
  openapi: "3.1.0",
  info: {
    title: "Allocube 官方 API",
    version: "1.0.0",
    description:
      "供 AI、CLI 与服务端自动化查询计算资源并管理本人占用。所有写入都必须先预检，再使用 5 分钟内有效的确认令牌提交。示例中形如 <UPPER_SNAKE_CASE> 的字符串是必须替换的占位符，尖括号不能原样提交。"
  },
  "x-placeholder-convention": {
    syntax: "<UPPER_SNAKE_CASE>",
    description:
      "占位符必须整体替换为当前环境或前序响应中的真实值；OpenAPI 路径中的 {id} 仍遵循标准路径模板语法。"
  },
  servers: [{ url: "/api/open/v1" }],
  tags: [
    { name: "Identity", description: "调用身份" },
    { name: "Resources", description: "机器、资源组和排期" },
    { name: "Reservations", description: "本人占用与两阶段写入" }
  ],
  paths: {
    "/me": {
      get: {
        operationId: "getCurrentApiIdentity",
        tags: ["Identity"],
        summary: "确认当前令牌代表的用户和权限",
        security: bearerSecurity,
        responses: {
          "200": {
            description: "当前身份",
            headers: successResponseHeaders,
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/SuccessEnvelope" },
                    {
                      type: "object",
                      properties: {
                        data: {
                          type: "object",
                          description: "当前调用身份",
                          required: ["user", "token"],
                          properties: {
                            user: { $ref: "#/components/schemas/ApiUser", description: "令牌所属用户" },
                            token: { $ref: "#/components/schemas/ApiTokenIdentity", description: "当前令牌摘要" }
                          }
                        }
                      }
                    }
                  ]
                }
              }
            }
          },
          "401": unauthenticatedResponse,
          "429": readRateLimitedResponse,
          "500": internalErrorResponse
        }
      }
    },
    "/machines": {
      get: {
        operationId: "listAccessibleMachines",
        tags: ["Resources"],
        summary: "分页列出当前用户有权使用的机器",
        security: bearerSecurity,
        parameters: [
          { $ref: "#/components/parameters/Limit" },
          { $ref: "#/components/parameters/Cursor" }
        ],
        responses: {
          "200": {
            description: "机器列表",
            headers: successResponseHeaders,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: {
                      type: "object",
                      description: "当前页机器数据",
                      required: ["machines"],
                      properties: {
                        machines: {
                          type: "array",
                          description: "当前用户有权使用的机器",
                          items: { $ref: "#/components/schemas/Machine" }
                        }
                      }
                    },
                    meta: { $ref: "#/components/schemas/PaginationMeta", description: "分页元数据" }
                  }
                }
              }
            }
          },
          "400": errorResponse("分页大小、游标格式或未知查询参数不符合约束，或游标已经失效"),
          "401": unauthenticatedResponse,
          "429": readRateLimitedResponse,
          "500": internalErrorResponse
        }
      }
    },
    "/machines/{id}/resource-groups": {
      get: {
        operationId: "listMachineResourceGroups",
        tags: ["Resources"],
        summary: "分页列出一台可访问机器的资源组",
        security: bearerSecurity,
        parameters: [
          { $ref: "#/components/parameters/MachineId" },
          { $ref: "#/components/parameters/Limit" },
          { $ref: "#/components/parameters/Cursor" }
        ],
        responses: {
          "200": {
            description: "资源组列表",
            headers: successResponseHeaders,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: {
                      type: "object",
                      description: "当前页资源组数据",
                      required: ["resourceGroups"],
                      properties: {
                        resourceGroups: {
                          type: "array",
                          description: "目标机器下当前页可访问的资源组",
                          items: { $ref: "#/components/schemas/ResourceGroup" }
                        }
                      }
                    },
                    meta: { $ref: "#/components/schemas/PaginationMeta", description: "分页元数据" }
                  }
                }
              }
            }
          },
          "400": errorResponse("机器 ID、分页大小或游标格式不正确，或游标已经失效"),
          "401": unauthenticatedResponse,
          "403": errorResponse("当前用户没有目标机器的有效使用权"),
          "429": readRateLimitedResponse,
          "500": internalErrorResponse
        }
      }
    },
    "/schedule": {
      get: {
        operationId: "getResourceSchedule",
        tags: ["Resources"],
        summary: "查询可访问机器在指定时间范围内的排期",
        description:
          "时间范围必须大于零且不超过 8 天。machineIds 使用英文逗号分隔，最多 100 个；省略时查询全部可访问机器。返回的占用详情对拥有对应机器使用权的用户完整可见。",
        security: bearerSecurity,
        parameters: [
          {
            name: "from",
            in: "query",
            required: true,
            description: "查询窗口的开始时间（RFC 3339）；返回与该窗口有交集的占用和不可用时段",
            schema: { type: "string", format: "date-time" }
          },
          {
            name: "to",
            in: "query",
            required: true,
            description: "查询窗口的结束时间（RFC 3339），必须晚于 from，且时间跨度不能超过 8 天",
            schema: { type: "string", format: "date-time" }
          },
          {
            name: "machineIds",
            in: "query",
            required: false,
            description: "以英文逗号分隔的机器 UUID，最多 100 个；省略时查询当前用户可访问的全部机器",
            schema: { type: "string", maxLength: 5000 },
            example: "<MACHINE_IDS>"
          }
        ],
        responses: {
          "200": {
            description: "排期数据",
            headers: successResponseHeaders,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: {
                      type: "object",
                      description: "指定窗口内的机器、资源组、占用和不可用时段",
                      required: ["machines", "resourceGroups", "reservations", "unavailability"],
                      properties: {
                        machines: { type: "array", description: "本次排期查询涉及的机器", items: { $ref: "#/components/schemas/Machine" } },
                        resourceGroups: { type: "array", description: "本次排期查询涉及的资源组", items: { $ref: "#/components/schemas/ResourceGroup" } },
                        reservations: { type: "array", description: "与查询窗口有交集的已确认占用", items: { $ref: "#/components/schemas/ScheduleReservation" } },
                        unavailability: { type: "array", description: "与查询窗口有交集的不可用时段", items: { $ref: "#/components/schemas/Unavailability" } }
                      }
                    },
                    meta: { $ref: "#/components/schemas/ScheduleMeta", description: "排期元数据" }
                  }
                }
              }
            }
          },
          "400": errorResponse("时间格式或范围不正确、机器 ID 列表无效，或查询机器超过 100 台、时间超过 8 天"),
          "401": unauthenticatedResponse,
          "403": errorResponse("machineIds 中包含当前用户无权使用的机器"),
          "429": readRateLimitedResponse,
          "500": internalErrorResponse
        }
      }
    },
    "/reservations": {
      get: {
        operationId: "listMyReservations",
        tags: ["Reservations"],
        summary: "分页查询本人占用",
        security: bearerSecurity,
        parameters: [
          {
            name: "from",
            in: "query",
            description: "筛选结束时间晚于此时间的本人占用（RFC 3339）",
            schema: { type: "string", format: "date-time" }
          },
          {
            name: "to",
            in: "query",
            description: "筛选开始时间早于此时间的本人占用（RFC 3339）；同时传入 from 时必须晚于 from",
            schema: { type: "string", format: "date-time" }
          },
          {
            name: "status",
            in: "query",
            description: "仅返回指定状态的本人占用",
            schema: {
              type: "string",
              enum: ["CONFIRMED", "CANCELLED", "CANCELLED_UNAVAILABILITY"]
            }
          },
          { $ref: "#/components/parameters/Limit" },
          { $ref: "#/components/parameters/Cursor" }
        ],
        responses: {
          "200": {
            description: "本人占用列表",
            headers: successResponseHeaders,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: {
                      type: "object",
                      description: "当前页本人占用数据",
                      required: ["reservations"],
                      properties: {
                        reservations: {
                          type: "array",
                          description: "符合筛选条件的本人占用",
                          items: { $ref: "#/components/schemas/Reservation" }
                        }
                      }
                    },
                    meta: { $ref: "#/components/schemas/PaginationMeta", description: "分页元数据" }
                  }
                }
              }
            }
          },
          "400": errorResponse("时间、状态、分页大小或游标格式不正确，游标失效，或 to 不晚于 from"),
          "401": unauthenticatedResponse,
          "429": readRateLimitedResponse,
          "500": internalErrorResponse
        }
      }
    },
    "/reservations/{id}": {
      get: {
        operationId: "getMyReservation",
        tags: ["Reservations"],
        summary: "查询本人单条占用",
        security: bearerSecurity,
        parameters: [{ $ref: "#/components/parameters/ReservationId" }],
        responses: {
          "200": {
            description: "占用详情",
            headers: successResponseHeaders,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: {
                      type: "object",
                      description: "本人单条占用数据",
                      required: ["reservation"],
                      properties: {
                        reservation: { $ref: "#/components/schemas/Reservation", description: "目标占用详情" }
                      }
                    },
                    meta: { $ref: "#/components/schemas/Meta", description: "响应元数据" }
                  }
                }
              }
            }
          },
          "400": errorResponse("占用 ID 不是有效 UUID"),
          "401": unauthenticatedResponse,
          "404": errorResponse("占用不存在，或该占用不属于当前用户"),
          "429": readRateLimitedResponse,
          "500": internalErrorResponse
        }
      }
    },
    "/reservation-operations/prepare": {
      post: {
        operationId: "prepareReservationOperation",
        tags: ["Reservations"],
        summary: "预检 CREATE、UPDATE、CANCEL 或 END 并获取确认令牌",
        description:
          "四种业务动作共用此预检端点。READ_WRITE 令牌必需；BLOCKED 响应不包含 confirmationToken，调用方不得继续提交。",
        security: bearerSecurity,
        requestBody: {
          required: true,
          description: "根据 action 选择对应请求结构；未知字段会被拒绝。CREATE 一次可预检 1 至 100 个占用片段。",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PrepareOperationRequest" },
              examples: {
                create: {
                  summary: "创建一个未来资源组占用",
                  value: {
                    action: "CREATE",
                    segments: [
                      {
                        scope: "RESOURCE_GROUP",
                        resourceGroupId: "<RESOURCE_GROUP_ID>",
                        startMode: "SCHEDULED",
                        startAt: "<START_AT_RFC3339>",
                        endAt: "<END_AT_RFC3339>",
                        title: "模型训练",
                        purpose: "验证新模型"
                      }
                    ]
                  }
                },
                update: {
                  summary: "修改本人占用的时间和说明",
                  value: {
                    action: "UPDATE",
                    reservationId: "<RESERVATION_ID>",
                    segment: {
                      scope: "RESOURCE_GROUP",
                      resourceGroupId: "<RESOURCE_GROUP_ID>",
                      startMode: "SCHEDULED",
                      startAt: "<START_AT_RFC3339>",
                      endAt: "<END_AT_RFC3339>",
                      title: "调整后的模型训练",
                      purpose: "验证新模型"
                    }
                  }
                },
                cancel: {
                  summary: "取消本人未来占用",
                  value: {
                    action: "CANCEL",
                    reservationId: "<RESERVATION_ID>",
                    reason: "任务取消"
                  }
                },
                end: {
                  summary: "提前结束本人进行中的占用",
                  value: {
                    action: "END",
                    reservationId: "<RESERVATION_ID>",
                    reason: "任务提前完成"
                  }
                }
              }
            }
          }
        },
        responses: {
          "200": {
            description: "READY 或 BLOCKED 的预检结果",
            headers: successResponseHeaders,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PrepareOperationResponse" }
              }
            }
          },
          "400": errorResponse("请求体、时间、占用片段或未知字段不符合约束"),
          "401": unauthenticatedResponse,
          "403": writeScopeResponse,
          "404": errorResponse("目标占用、机器或资源组不存在，或不属于当前用户的可操作范围"),
          "409": errorResponse("占用状态或资源配置不允许当前操作；刷新数据后重新预检"),
          "429": operationRateLimitedResponse,
          "500": internalErrorResponse
        }
      }
    },
    "/reservation-operations/commit": {
      post: {
        operationId: "commitReservationOperation",
        tags: ["Reservations"],
        summary: "提交已成功预检的占用写操作",
        description:
          "此端点通用于 CREATE、UPDATE、CANCEL 和 END。确认令牌已经绑定 prepare 中的动作，提交时不需要再次传 action。令牌同时绑定签发它的用户和个人访问令牌；成功提交可在 24 小时内安全重试，不会重复执行。",
        security: bearerSecurity,
        requestBody: {
          required: true,
          description: "提交 prepare 返回的确认令牌。令牌有效期为 5 分钟，并绑定用户、个人访问令牌和预检内容。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["confirmationToken"],
                properties: {
                  confirmationToken: {
                    type: "string",
                    description:
                      "prepare 返回的一次性确认令牌；必须原样传入该次预检响应中的真实值",
                    example: "<CONFIRMATION_TOKEN>"
                  }
                }
              },
              examples: {
                commit: {
                  summary: "提交预检返回的确认令牌",
                  value: {
                    confirmationToken: "<CONFIRMATION_TOKEN>"
                  }
                }
              }
            }
          }
        },
        responses: {
          "200": {
            description: "操作结果；meta.replayed 表示是否为安全重放",
            headers: successResponseHeaders,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CommitOperationResponse" },
                examples: {
                  create: {
                    summary: "CREATE 提交成功",
                    value: {
                      data: {
                        batchId: "<BATCH_ID>",
                        reservations: [{
                          id: "<RESERVATION_ID>",
                          scope: "RESOURCE_GROUP",
                          machineId: "<MACHINE_ID>",
                          resourceGroupId: "<RESOURCE_GROUP_ID>",
                          startMode: "SCHEDULED",
                          startAt: "<START_AT_RFC3339>",
                          endAt: "<END_AT_RFC3339>",
                          title: "模型训练",
                          purpose: "回归验证",
                          note: ""
                        }],
                        revision: 42,
                        serverNow: "2026-08-23T10:00:00.000Z"
                      },
                      meta: {
                        serverTime: "2026-08-23T10:00:00.000Z",
                        replayed: false
                      }
                    }
                  },
                  update: {
                    summary: "UPDATE 提交成功",
                    value: {
                      data: {
                        id: "<RESERVATION_ID>",
                        revision: 43
                      },
                      meta: {
                        serverTime: "2026-08-23T10:01:00.000Z",
                        replayed: false
                      }
                    }
                  },
                  cancel: {
                    summary: "CANCEL 提交成功",
                    value: {
                      data: {
                        id: "<RESERVATION_ID>",
                        cancelled: true,
                        revision: 44
                      },
                      meta: {
                        serverTime: "2026-08-23T10:02:00.000Z",
                        replayed: false
                      }
                    }
                  },
                  end: {
                    summary: "END 提交成功",
                    value: {
                      data: {
                        id: "<RESERVATION_ID>",
                        ended: true,
                        removed: false,
                        revision: 45
                      },
                      meta: {
                        serverTime: "2026-08-23T10:03:00.000Z",
                        replayed: false
                      }
                    }
                  }
                }
              }
            }
          },
          "400": errorResponse("confirmationToken 缺失、格式不正确或请求包含未知字段"),
          "401": unauthenticatedResponse,
          "403": writeScopeResponse,
          "404": errorResponse("确认令牌不存在，或它属于其他用户或其他 API 令牌"),
          "409": errorResponse("预检后权限、资源或占用状态发生变化，或该预检操作已失效；必须重新预检"),
          "410": errorResponse("确认令牌已超过 5 分钟有效期；必须重新预检"),
          "429": operationRateLimitedResponse,
          "500": internalErrorResponse
        }
      }
    }
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "Allocube personal access token"
      }
    },
    parameters: {
      Limit: {
        name: "limit",
        in: "query",
        required: false,
        description: "每页最多返回的记录数",
        schema: { type: "integer", minimum: 1, maximum: 200, default: 50 }
      },
      Cursor: {
        name: "cursor",
        in: "query",
        required: false,
        schema: { type: "string", maxLength: 2000 },
        description: "上一页 meta.nextCursor 返回的不透明游标"
      },
      MachineId: {
        name: "id",
        in: "path",
        required: true,
        description: "要查询资源组的机器 UUID",
        schema: { type: "string", format: "uuid" }
      },
      ReservationId: {
        name: "id",
        in: "path",
        required: true,
        description: "要查询的本人占用 UUID",
        schema: { type: "string", format: "uuid" }
      }
    },
    schemas: {
      Meta: {
        type: "object",
        description: "所有成功响应都包含的通用元数据",
        required: ["serverTime"],
        properties: {
          serverTime: {
            type: "string",
            format: "date-time",
            description: "服务器生成响应时的时间（RFC 3339）"
          }
        },
        additionalProperties: true
      },
      PaginationMeta: {
        type: "object",
        description: "游标分页响应的元数据",
        required: ["serverTime", "nextCursor"],
        properties: {
          serverTime: {
            type: "string",
            format: "date-time",
            description: "服务器生成响应时的时间（RFC 3339）"
          },
          nextCursor: {
            type: ["string", "null"],
            description: "下一页的不透明游标；为 null 表示没有下一页"
          }
        },
        additionalProperties: false
      },
      ScheduleMeta: {
        type: "object",
        description: "排期响应的元数据",
        required: ["serverTime", "scheduleRevision"],
        properties: {
          serverTime: {
            type: "string",
            format: "date-time",
            description: "服务器生成响应时的时间（RFC 3339）"
          },
          scheduleRevision: {
            type: "integer",
            minimum: 1,
            description: "全局排期修订号；变化表示排期数据可能已经更新"
          }
        },
        additionalProperties: false
      },
      SuccessEnvelope: {
        type: "object",
        description: "通用成功响应外层结构",
        required: ["data", "meta"],
        properties: {
          data: { type: "object", description: "接口返回的业务数据" },
          meta: {
            $ref: "#/components/schemas/Meta",
            description: "响应元数据"
          }
        }
      },
      ErrorResponse: {
        type: "object",
        description: "所有 API 错误使用的统一响应结构",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            description: "错误详情",
            additionalProperties: false,
            required: ["code", "message", "requestId"],
            properties: {
              code: {
                type: "string",
                enum: [
                  "INVALID_REQUEST",
                  "UNAUTHENTICATED",
                  "INSUFFICIENT_SCOPE",
                  "FORBIDDEN",
                  "NOT_FOUND",
                  "CONFLICT",
                  "RATE_LIMITED",
                  "OPERATION_EXPIRED",
                  "OPERATION_REJECTED",
                  "INTERNAL_ERROR"
                ],
                description: "稳定的机器可读错误码，可用于程序分支判断"
              },
              message: {
                type: "string",
                description: "面向调用者的错误说明，不建议程序依赖具体文案"
              },
              details: {
                description: "可选的结构化上下文；校验错误、冲突和限流会提供不同字段"
              },
              requestId: {
                type: "string",
                description: "本次请求的唯一标识，与 X-Request-Id 响应头一致"
              }
            }
          }
        }
      },
      ApiUser: {
        type: "object",
        description: "个人访问令牌所属的当前用户",
        additionalProperties: false,
        required: ["id", "username", "displayName", "employeeNumber", "role"],
        properties: {
          id: { type: "string", format: "uuid", description: "用户 UUID" },
          username: { type: "string", description: "登录用户名" },
          displayName: { type: "string", description: "页面和记录中展示的姓名" },
          employeeNumber: { type: ["string", "null"], description: "当前有效工号；未设置时为 null" },
          role: { type: "string", enum: ["SYSTEM_ADMIN", "USER"], description: "用户角色" }
        }
      },
      ApiTokenIdentity: {
        type: "object",
        description: "当前请求所用个人访问令牌的安全摘要，不包含令牌明文",
        additionalProperties: false,
        required: ["id", "name", "prefix", "accessLevel", "expiresAt"],
        properties: {
          id: { type: "string", format: "uuid", description: "令牌记录 UUID" },
          name: { type: "string", description: "用户为令牌设置的名称" },
          prefix: { type: "string", description: "用于辨认令牌的非敏感前缀" },
          accessLevel: { type: "string", enum: ["READ_ONLY", "READ_WRITE"], description: "令牌权限；写操作必须为 READ_WRITE" },
          expiresAt: { type: ["string", "null"], format: "date-time", description: "令牌到期时间（RFC 3339）；null 表示永不过期" }
        }
      },
      Machine: {
        type: "object",
        description: "当前用户有权使用的机器",
        additionalProperties: false,
        required: ["id", "name", "address", "hardwareNotes", "connectionGuide", "resourceSummary", "tags", "status", "isManager"],
        properties: {
          id: { type: "string", format: "uuid", description: "机器 UUID" },
          name: { type: "string", description: "机器名称" },
          address: { type: "string", description: "机器地址或管理员填写的访问位置" },
          hardwareNotes: { type: "string", description: "硬件配置说明" },
          connectionGuide: { type: "string", description: "连接和使用说明" },
          resourceSummary: { type: "string", description: "机器下资源组的简要汇总" },
          tags: { type: "array", description: "机器标签", items: { type: "string", description: "单个标签" } },
          status: { type: "string", enum: ["ACTIVE", "DISABLED"], description: "机器是否可用于新的占用" },
          isManager: { type: "boolean", description: "当前用户是否可以管理该机器" }
        }
      },
      ResourceRange: {
        type: "object",
        description: "编号范围资源的一段连续编号",
        additionalProperties: false,
        required: ["start", "end"],
        properties: {
          start: { type: "integer", description: "起始编号，包含该编号" },
          end: { type: "integer", description: "结束编号，包含该编号" },
          label: { type: "string", description: "管理员为该编号范围设置的可选备注" }
        }
      },
      ResourceItem: {
        type: "object",
        description: "设备列表资源中的一个具体设备",
        additionalProperties: false,
        required: ["id", "key", "label"],
        properties: {
          id: { type: "string", format: "uuid", description: "设备 UUID" },
          key: { type: "string", description: "设备在资源池中的稳定标识" },
          label: { type: "string", description: "设备展示名称" }
        }
      },
      ResourceAllocation: {
        type: "object",
        description: "资源组从一个资源池中分配到的编号、设备或容量",
        required: ["poolId", "poolName", "kind", "sharingMode", "unit"],
        properties: {
          poolId: { type: "string", format: "uuid", description: "资源池 UUID" },
          poolName: { type: "string", description: "资源池名称快照" },
          kind: { type: "string", enum: ["INDEX_RANGE", "ITEM_LIST", "CAPACITY"], description: "资源池的分配类型" },
          sharingMode: { type: "string", enum: ["EXCLUSIVE", "SHARED"], description: "资源是否允许多个资源组共享使用" },
          unit: { type: "string", description: "资源数量的显示单位" },
          ranges: { type: "array", description: "INDEX_RANGE 类型分配到的编号范围", items: { $ref: "#/components/schemas/ResourceRange" } },
          items: { type: "array", description: "ITEM_LIST 类型分配到的设备", items: { $ref: "#/components/schemas/ResourceItem" } },
          quantity: { type: "number", description: "CAPACITY 类型分配到的容量，最多三位小数" }
        }
      },
      ResourceGroup: {
        type: "object",
        description: "机器下可以被占用的资源集合",
        required: ["id", "machineId", "name", "allocations", "resourceSummary", "description", "tags", "sortOrder", "status"],
        properties: {
          id: { type: "string", format: "uuid", description: "资源组 UUID" },
          machineId: { type: "string", format: "uuid", description: "所属机器 UUID" },
          name: { type: "string", description: "资源组名称" },
          allocations: { type: "array", description: "资源组拥有的资源分配明细", items: { $ref: "#/components/schemas/ResourceAllocation" } },
          resourceSummary: { type: "string", description: "资源分配的人类可读摘要" },
          description: { type: "string", description: "管理员填写的资源组说明" },
          tags: { type: "array", description: "资源组标签", items: { type: "string", description: "单个标签" } },
          sortOrder: { type: "integer", description: "同一机器内的展示顺序，数值越小越靠前" },
          status: { type: "string", enum: ["ACTIVE", "DISABLED"], description: "资源组是否可用于新的占用" },
          version: { type: "integer", description: "资源组配置版本；排期接口可能不返回此字段" }
        }
      },
      ScheduleReservation: {
        type: "object",
        description: "排期窗口中与当前用户可访问机器相关的已确认占用",
        required: ["id", "scope", "machineId", "resourceGroupId", "applicantName", "applicantEmployeeNumber", "startAt", "endAt", "status", "mine", "title", "purpose", "note", "initialStartAt", "initialEndAt", "adjustmentType", "adjustmentReason"],
        properties: {
          id: { type: "string", format: "uuid", description: "占用 UUID" },
          scope: { type: "string", enum: ["RESOURCE_GROUP", "MACHINE"], description: "占用范围：单个资源组或整机" },
          machineId: { type: "string", format: "uuid", description: "所属机器 UUID" },
          resourceGroupId: { type: "string", format: "uuid", description: "占用的资源组 UUID；整机占用时为代表资源组" },
          applicantName: { type: "string", description: "申请人展示姓名" },
          applicantEmployeeNumber: { type: ["string", "null"], description: "申请人当前有效工号；未设置时为 null" },
          startAt: { type: "string", format: "date-time", description: "当前生效的开始时间（RFC 3339）" },
          endAt: { type: "string", format: "date-time", description: "当前生效的结束时间（RFC 3339）" },
          status: { type: "string", enum: ["CONFIRMED"], description: "排期接口仅返回当前有效的已确认占用" },
          mine: { type: "boolean", description: "该占用是否属于当前令牌用户" },
          title: { type: "string", description: "占用标题" },
          purpose: { type: "string", description: "占用用途" },
          note: { type: "string", description: "占用补充说明" },
          initialStartAt: { type: "string", format: "date-time", description: "首次创建时的开始时间" },
          initialEndAt: { type: "string", format: "date-time", description: "首次创建时的结束时间" },
          adjustmentType: { type: ["string", "null"], description: "时间被调整的原因类型；未调整时为 null" },
          adjustmentReason: { type: "string", description: "时间调整原因说明" }
        }
      },
      Unavailability: {
        type: "object",
        description: "机器或资源组的不可用时段",
        required: ["id", "machineId", "resourceGroupId", "kind", "startAt", "endAt", "reason", "status"],
        properties: {
          id: { type: "string", format: "uuid", description: "不可用记录 UUID" },
          machineId: { type: "string", format: "uuid", description: "所属机器 UUID" },
          resourceGroupId: { type: ["string", "null"], format: "uuid", description: "受影响的资源组 UUID；null 表示整机不可用" },
          kind: { type: "string", enum: ["PLANNED", "LONG_TERM"], description: "计划维护或长期停用" },
          startAt: { type: "string", format: "date-time", description: "不可用开始时间（RFC 3339）" },
          endAt: { type: "string", format: "date-time", description: "不可用结束时间（RFC 3339）" },
          reason: { type: "string", description: "不可用原因" },
          status: { type: "string", enum: ["ACTIVE", "CANCELLED"], description: "不可用记录状态" }
        }
      },
      Reservation: {
        type: "object",
        description: "当前用户自己的完整占用记录",
        required: ["id", "batchId", "scope", "machineId", "machineName", "resourceGroupId", "resourceGroupName", "startAt", "endAt", "title", "purpose", "note", "status", "createdAt", "updatedAt"],
        properties: {
          id: { type: "string", format: "uuid", description: "占用 UUID" },
          batchId: { type: "string", format: "uuid", description: "同一次 CREATE 操作产生的占用批次 UUID" },
          scope: { type: "string", enum: ["RESOURCE_GROUP", "MACHINE"], description: "占用范围：单个资源组或整机" },
          machineId: { type: "string", format: "uuid", description: "所属机器 UUID" },
          machineName: { type: "string", description: "机器名称" },
          resourceGroupId: { type: "string", format: "uuid", description: "资源组 UUID" },
          resourceGroupName: { type: "string", description: "资源组名称；整机占用时为“整机”" },
          startAt: { type: "string", format: "date-time", description: "当前生效的开始时间（RFC 3339）" },
          endAt: { type: "string", format: "date-time", description: "当前生效的结束时间（RFC 3339）" },
          initialStartAt: { type: "string", format: "date-time", description: "首次创建时的开始时间" },
          initialEndAt: { type: "string", format: "date-time", description: "首次创建时的结束时间" },
          title: { type: "string", description: "占用标题" },
          purpose: { type: "string", description: "占用用途" },
          note: { type: "string", description: "占用补充说明" },
          status: { type: "string", enum: ["CONFIRMED", "CANCELLED", "CANCELLED_UNAVAILABILITY"], description: "占用当前状态" },
          adjustmentType: { type: ["string", "null"], description: "时间调整原因类型；未调整时为 null" },
          adjustmentReason: { type: "string", description: "时间调整原因说明" },
          cancellationReason: { type: "string", description: "取消原因；未取消时为空字符串" },
          createdAt: { type: "string", format: "date-time", description: "占用创建时间" },
          updatedAt: { type: "string", format: "date-time", description: "占用最后更新时间" }
        }
      },
      ReservationSegment: {
        type: "object",
        description: "用于创建或修改占用的目标资源与时间片段",
        additionalProperties: false,
        required: ["scope", "resourceGroupId", "startAt", "endAt"],
        properties: {
          scope: { type: "string", enum: ["RESOURCE_GROUP", "MACHINE"], description: "RESOURCE_GROUP 仅占用目标资源组；MACHINE 占用目标机器全部资源组" },
          machineId: { type: "string", format: "uuid", description: "整机占用对应的机器 UUID；服务端会根据 resourceGroupId 校验并标准化" },
          resourceGroupId: { type: "string", format: "uuid", description: "目标资源组 UUID；整机占用也需要传入该机器下的一个资源组" },
          startMode: { type: "string", enum: ["IMMEDIATE", "SCHEDULED"], default: "SCHEDULED", description: "立即开始或按 startAt 计划开始" },
          startAt: { type: "string", format: "date-time", description: "开始时间（RFC 3339），必须精确到分钟；IMMEDIATE 会按服务器当前分钟标准化" },
          endAt: { type: "string", format: "date-time", description: "结束时间（RFC 3339），必须精确到分钟并晚于开始时间" },
          title: { type: "string", maxLength: 120, default: "", description: "占用标题" },
          purpose: { type: "string", maxLength: 500, default: "", description: "占用用途" },
          note: { type: "string", maxLength: 1000, default: "", description: "补充说明" }
        }
      },
      PrepareOperationRequest: {
        description: "占用写操作的预检请求；action 决定其余字段",
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["action", "segments"],
            properties: {
              action: { const: "CREATE", description: "创建一批新占用" },
              segments: { type: "array", minItems: 1, maxItems: 100, description: "要一次性校验的占用片段；所有片段必须使用同一种 scope", items: { $ref: "#/components/schemas/ReservationSegment" } }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["action", "reservationId", "segment"],
            properties: {
              action: { const: "UPDATE", description: "修改本人现有占用" },
              reservationId: { type: "string", format: "uuid", description: "要修改的本人占用 UUID" },
              segment: { $ref: "#/components/schemas/ReservationSegment", description: "修改后的完整占用片段" }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["action", "reservationId"],
            properties: {
              action: { type: "string", enum: ["CANCEL", "END"], description: "CANCEL 取消尚未开始的占用；END 提前结束进行中的占用" },
              reservationId: { type: "string", format: "uuid", description: "要取消或提前结束的本人占用 UUID" },
              reason: { type: "string", maxLength: 500, default: "", description: "操作原因" }
            }
          }
        ],
        discriminator: { propertyName: "action" }
      },
      ReservationConflict: {
        type: "object",
        description: "导致目标时段不可用的冲突",
        additionalProperties: false,
        required: ["type", "startAt", "endAt", "label"],
        properties: {
          type: { type: "string", description: "冲突类型，例如已有占用或资源不可用" },
          startAt: { type: "string", format: "date-time", description: "冲突开始时间" },
          endAt: { type: "string", format: "date-time", description: "冲突结束时间" },
          label: { type: "string", description: "适合直接展示的冲突说明" }
        }
      },
      ReservationAvailability: {
        type: "object",
        description: "单个占用片段的可用性预检结果",
        additionalProperties: false,
        required: ["input", "available", "conflicts", "splitSegments"],
        properties: {
          input: { $ref: "#/components/schemas/ReservationSegment", description: "服务端标准化后的输入片段" },
          available: { type: "boolean", description: "目标片段当前是否可以提交" },
          conflicts: { type: "array", description: "阻止提交的冲突；可用时为空数组", items: { $ref: "#/components/schemas/ReservationConflict" } },
          splitSegments: { type: "array", description: "避开冲突后可用的建议片段", items: { $ref: "#/components/schemas/ReservationSegment" } }
        }
      },
      ReservationOperationSummary: {
        type: "object",
        description: "预检操作涉及的原占用摘要",
        additionalProperties: false,
        required: ["id", "scope", "machineId", "resourceGroupId", "startAt", "endAt", "title", "purpose", "note", "status"],
        properties: {
          id: { type: "string", format: "uuid", description: "占用 UUID" },
          scope: { type: "string", enum: ["RESOURCE_GROUP", "MACHINE"], description: "占用范围" },
          machineId: { type: "string", format: "uuid", description: "机器 UUID" },
          resourceGroupId: { type: "string", format: "uuid", description: "资源组 UUID" },
          startAt: { type: "string", format: "date-time", description: "当前开始时间" },
          endAt: { type: "string", format: "date-time", description: "当前结束时间" },
          title: { type: "string", description: "占用标题" },
          purpose: { type: "string", description: "占用用途" },
          note: { type: "string", description: "补充说明" },
          status: { type: "string", description: "占用当前状态" }
        }
      },
      CreateOperationPreview: {
        type: "object",
        description: "CREATE 操作的预检详情",
        required: ["items", "serverNow"],
        properties: {
          items: { type: "array", description: "每个输入片段对应的可用性结果", items: { $ref: "#/components/schemas/ReservationAvailability" } },
          serverNow: { type: "string", format: "date-time", description: "执行预检时的服务器时间" }
        }
      },
      UpdateOperationPreview: {
        type: "object",
        description: "UPDATE 操作的预检详情",
        required: ["reservation", "segment", "item", "serverNow"],
        properties: {
          reservation: { $ref: "#/components/schemas/ReservationOperationSummary", description: "修改前的占用摘要" },
          segment: { $ref: "#/components/schemas/ReservationSegment", description: "服务端标准化后的新片段" },
          item: { $ref: "#/components/schemas/ReservationAvailability", description: "新片段的可用性结果" },
          serverNow: { type: "string", format: "date-time", description: "执行预检时的服务器时间" }
        }
      },
      ExistingReservationPreview: {
        type: "object",
        description: "CANCEL 或 END 操作的预检详情",
        required: ["reservation", "serverNow"],
        properties: {
          reservation: { $ref: "#/components/schemas/ReservationOperationSummary", description: "即将操作的占用摘要" },
          serverNow: { type: "string", format: "date-time", description: "执行预检时的服务器时间" }
        }
      },
      PrepareOperationResponse: {
        type: "object",
        description: "占用写操作的预检响应",
        required: ["data", "meta"],
        properties: {
          data: {
            type: "object",
            description: "预检业务结果",
            required: ["action", "status", "preview"],
            properties: {
              operationId: { type: "string", format: "uuid", description: "READY 时生成的预检操作 UUID；BLOCKED 时省略" },
              action: { type: "string", enum: ["CREATE", "UPDATE", "CANCEL", "END"], description: "本次预检的业务动作" },
              status: { type: "string", enum: ["READY", "BLOCKED"], description: "READY 可以继续提交；BLOCKED 必须调整请求后重新预检" },
              preview: {
                description: "按 action 返回的预检详情",
                oneOf: [
                  { $ref: "#/components/schemas/CreateOperationPreview" },
                  { $ref: "#/components/schemas/UpdateOperationPreview" },
                  { $ref: "#/components/schemas/ExistingReservationPreview" }
                ]
              },
              confirmationToken: { type: "string", description: "READY 时返回的一次性确认令牌；BLOCKED 时省略" },
              expiresAt: { type: "string", format: "date-time", description: "确认令牌到期时间；签发后 5 分钟" }
            }
          },
          meta: { $ref: "#/components/schemas/Meta", description: "响应元数据" }
        }
      },
      CommittedReservation: {
        allOf: [
          { $ref: "#/components/schemas/ReservationSegment" },
          {
            type: "object",
            description: "CREATE 成功创建的占用标识和标准化片段",
            required: ["id", "machineId"],
            properties: {
              id: { type: "string", format: "uuid", description: "新占用 UUID" },
              machineId: { type: "string", format: "uuid", description: "服务端根据资源组确定的机器 UUID" }
            }
          }
        ]
      },
      CreateCommitResult: {
        type: "object",
        description: "CREATE 提交结果",
        required: ["batchId", "reservations", "revision", "serverNow"],
        properties: {
          batchId: { type: "string", format: "uuid", description: "本批新占用的批次 UUID" },
          reservations: { type: "array", description: "本次创建的占用", items: { $ref: "#/components/schemas/CommittedReservation" } },
          revision: { type: "integer", description: "提交后的全局排期修订号" },
          serverNow: { type: "string", format: "date-time", description: "提交完成时的服务器时间" }
        }
      },
      UpdateCommitResult: {
        type: "object",
        description: "UPDATE 提交结果",
        required: ["id", "revision"],
        properties: {
          id: { type: "string", format: "uuid", description: "已修改的占用 UUID" },
          revision: { type: "integer", description: "提交后的全局排期修订号" }
        }
      },
      CancelCommitResult: {
        type: "object",
        description: "CANCEL 提交结果",
        required: ["id", "cancelled", "revision"],
        properties: {
          id: { type: "string", format: "uuid", description: "已取消的占用 UUID" },
          cancelled: { const: true, description: "固定为 true，表示取消成功" },
          revision: { type: "integer", description: "提交后的全局排期修订号" }
        }
      },
      EndCommitResult: {
        type: "object",
        description: "END 提交结果",
        required: ["id", "ended", "removed", "revision"],
        properties: {
          id: { type: "string", format: "uuid", description: "已提前结束的占用 UUID" },
          ended: { const: true, description: "固定为 true，表示提前结束成功" },
          removed: { type: "boolean", description: "占用尚未真正开始而被直接移除时为 true" },
          revision: { type: "integer", description: "提交后的全局排期修订号" }
        }
      },
      CommitOperationResponse: {
        type: "object",
        description: "提交预检操作后的统一响应；data 结构取决于 prepare 中的 action",
        required: ["data", "meta"],
        properties: {
          data: {
            description: "CREATE、UPDATE、CANCEL 或 END 的提交结果",
            oneOf: [
              { $ref: "#/components/schemas/CreateCommitResult" },
              { $ref: "#/components/schemas/UpdateCommitResult" },
              { $ref: "#/components/schemas/CancelCommitResult" },
              { $ref: "#/components/schemas/EndCommitResult" }
            ]
          },
          meta: {
            type: "object",
            description: "提交响应元数据",
            required: ["serverTime", "replayed"],
            properties: {
              serverTime: { type: "string", format: "date-time", description: "服务器生成响应时的时间" },
              replayed: { type: "boolean", description: "是否返回同一确认令牌先前已成功提交的结果" }
            }
          }
        }
      }
    }
  }
} as const;
