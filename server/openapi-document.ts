const errorResponse = {
  description: "请求失败",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ErrorResponse" }
    }
  }
};

const bearerSecurity = [{ bearerAuth: [] }];

export const OPEN_API_DOCUMENT = {
  openapi: "3.1.0",
  info: {
    title: "Allocube 官方 AI API",
    version: "1.0.0",
    description:
      "供 AI、CLI 与服务端自动化查询计算资源并管理本人占用。所有写入都必须先预检，再使用五分钟内有效的确认令牌提交。"
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
                          required: ["user", "token"],
                          properties: {
                            user: { $ref: "#/components/schemas/ApiUser" },
                            token: { $ref: "#/components/schemas/ApiTokenIdentity" }
                          }
                        }
                      }
                    }
                  ]
                }
              }
            }
          },
          "401": errorResponse,
          "429": errorResponse
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
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: {
                      type: "object",
                      required: ["machines"],
                      properties: {
                        machines: {
                          type: "array",
                          items: { $ref: "#/components/schemas/Machine" }
                        }
                      }
                    },
                    meta: { $ref: "#/components/schemas/PaginationMeta" }
                  }
                }
              }
            }
          },
          "401": errorResponse,
          "429": errorResponse
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
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: {
                      type: "object",
                      required: ["resourceGroups"],
                      properties: {
                        resourceGroups: {
                          type: "array",
                          items: { $ref: "#/components/schemas/ResourceGroup" }
                        }
                      }
                    },
                    meta: { $ref: "#/components/schemas/PaginationMeta" }
                  }
                }
              }
            }
          },
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "429": errorResponse
        }
      }
    },
    "/schedule": {
      get: {
        operationId: "getResourceSchedule",
        tags: ["Resources"],
        summary: "查询可访问机器在指定时间范围内的排期",
        description:
          "时间范围必须大于零且不超过八天。machineIds 使用逗号分隔，最多 100 个；省略时查询全部可访问机器。",
        security: bearerSecurity,
        parameters: [
          {
            name: "from",
            in: "query",
            required: true,
            schema: { type: "string", format: "date-time" }
          },
          {
            name: "to",
            in: "query",
            required: true,
            schema: { type: "string", format: "date-time" }
          },
          {
            name: "machineIds",
            in: "query",
            required: false,
            schema: { type: "string", maxLength: 5000 },
            example: "0f69c7c0-6548-4200-978f-4989b787f5f6"
          }
        ],
        responses: {
          "200": {
            description: "排期数据",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: {
                      type: "object",
                      required: ["machines", "resourceGroups", "reservations", "unavailability"],
                      properties: {
                        machines: { type: "array", items: { $ref: "#/components/schemas/Machine" } },
                        resourceGroups: { type: "array", items: { $ref: "#/components/schemas/ResourceGroup" } },
                        reservations: { type: "array", items: { $ref: "#/components/schemas/ScheduleReservation" } },
                        unavailability: { type: "array", items: { $ref: "#/components/schemas/Unavailability" } }
                      }
                    },
                    meta: { $ref: "#/components/schemas/ScheduleMeta" }
                  }
                }
              }
            }
          },
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "429": errorResponse
        }
      }
    },
    "/reservations": {
      get: {
        operationId: "listMyReservations",
        tags: ["Reservations"],
        summary: "分页查询当前用户自己的占用",
        security: bearerSecurity,
        parameters: [
          { name: "from", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "to", in: "query", schema: { type: "string", format: "date-time" } },
          {
            name: "status",
            in: "query",
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
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: {
                      type: "object",
                      required: ["reservations"],
                      properties: {
                        reservations: {
                          type: "array",
                          items: { $ref: "#/components/schemas/Reservation" }
                        }
                      }
                    },
                    meta: { $ref: "#/components/schemas/PaginationMeta" }
                  }
                }
              }
            }
          },
          "400": errorResponse,
          "401": errorResponse,
          "429": errorResponse
        }
      }
    },
    "/reservations/{id}": {
      get: {
        operationId: "getMyReservation",
        tags: ["Reservations"],
        summary: "查询当前用户自己的一条占用",
        security: bearerSecurity,
        parameters: [{ $ref: "#/components/parameters/ReservationId" }],
        responses: {
          "200": {
            description: "占用详情",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: {
                      type: "object",
                      required: ["reservation"],
                      properties: {
                        reservation: { $ref: "#/components/schemas/Reservation" }
                      }
                    },
                    meta: { $ref: "#/components/schemas/Meta" }
                  }
                }
              }
            }
          },
          "400": errorResponse,
          "401": errorResponse,
          "404": errorResponse,
          "429": errorResponse
        }
      }
    },
    "/reservation-operations/prepare": {
      post: {
        operationId: "prepareReservationOperation",
        tags: ["Reservations"],
        summary: "预检占用写操作并获取五分钟确认令牌",
        description:
          "READ_WRITE 令牌必需。BLOCKED 响应不包含 confirmationToken，调用方不得继续提交。",
        security: bearerSecurity,
        requestBody: {
          required: true,
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
                        resourceGroupId: "89f7ab38-93b5-4563-9280-b3c71ec81144",
                        startMode: "SCHEDULED",
                        startAt: "2026-08-24T01:00:00.000Z",
                        endAt: "2026-08-24T03:00:00.000Z",
                        title: "模型训练",
                        purpose: "验证新模型"
                      }
                    ]
                  }
                },
                cancel: {
                  summary: "取消本人未来占用",
                  value: {
                    action: "CANCEL",
                    reservationId: "3fc55c75-893b-4a9c-a4f2-252b26be58a2",
                    reason: "任务取消"
                  }
                }
              }
            }
          }
        },
        responses: {
          "200": {
            description: "READY 或 BLOCKED 的预检结果",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PrepareOperationResponse" }
              }
            }
          },
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
          "429": errorResponse
        }
      }
    },
    "/reservation-operations/commit": {
      post: {
        operationId: "commitReservationOperation",
        tags: ["Reservations"],
        summary: "提交已成功预检的占用写操作",
        description:
          "确认令牌绑定签发它的用户和个人访问令牌。成功提交可在 24 小时内安全重试，不会重复执行。",
        security: bearerSecurity,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["confirmationToken"],
                properties: {
                  confirmationToken: {
                    type: "string",
                    description: "prepare 返回的一次性确认令牌",
                    example: "allocube_confirm_REDACTED"
                  }
                }
              }
            }
          }
        },
        responses: {
          "200": {
            description: "操作结果；meta.replayed 表示是否为安全重放",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SuccessEnvelope" }
              }
            }
          },
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
          "410": errorResponse,
          "429": errorResponse
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
        schema: { type: "string", format: "uuid" }
      },
      ReservationId: {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" }
      }
    },
    schemas: {
      Meta: {
        type: "object",
        required: ["serverTime"],
        properties: { serverTime: { type: "string", format: "date-time" } },
        additionalProperties: true
      },
      PaginationMeta: {
        type: "object",
        required: ["serverTime", "nextCursor"],
        properties: {
          serverTime: { type: "string", format: "date-time" },
          nextCursor: { type: ["string", "null"] }
        },
        additionalProperties: false
      },
      ScheduleMeta: {
        type: "object",
        required: ["serverTime", "scheduleRevision"],
        properties: {
          serverTime: { type: "string", format: "date-time" },
          scheduleRevision: { type: "integer", minimum: 1 }
        },
        additionalProperties: false
      },
      SuccessEnvelope: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: { type: "object" },
          meta: { $ref: "#/components/schemas/Meta" }
        }
      },
      ErrorResponse: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            additionalProperties: false,
            required: ["code", "message", "requestId"],
            properties: {
              code: { type: "string", pattern: "^[A-Z][A-Z0-9_]+$" },
              message: { type: "string" },
              details: {},
              requestId: { type: "string" }
            }
          }
        }
      },
      ApiUser: {
        type: "object",
        additionalProperties: false,
        required: ["id", "username", "displayName", "employeeNumber", "role"],
        properties: {
          id: { type: "string", format: "uuid" },
          username: { type: "string" },
          displayName: { type: "string" },
          employeeNumber: { type: ["string", "null"] },
          role: { type: "string", enum: ["SYSTEM_ADMIN", "USER"] }
        }
      },
      ApiTokenIdentity: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "prefix", "accessLevel", "expiresAt"],
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          prefix: { type: "string" },
          accessLevel: { type: "string", enum: ["READ_ONLY", "READ_WRITE"] },
          expiresAt: { type: ["string", "null"], format: "date-time" }
        }
      },
      Machine: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "address", "hardwareNotes", "connectionGuide", "resourceSummary", "tags", "status", "isManager"],
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          address: { type: "string" },
          hardwareNotes: { type: "string" },
          connectionGuide: { type: "string" },
          resourceSummary: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["ACTIVE", "DISABLED"] },
          isManager: { type: "boolean" }
        }
      },
      ResourceAllocation: {
        type: "object",
        required: ["poolId", "poolName", "kind", "sharingMode", "unit"],
        properties: {
          poolId: { type: "string", format: "uuid" },
          poolName: { type: "string" },
          kind: { type: "string", enum: ["INDEX_RANGE", "ITEM_LIST", "CAPACITY"] },
          sharingMode: { type: "string", enum: ["EXCLUSIVE", "SHARED"] },
          unit: { type: "string" },
          ranges: { type: "array", items: { type: "object" } },
          items: { type: "array", items: { type: "object" } },
          quantity: { type: "number" }
        }
      },
      ResourceGroup: {
        type: "object",
        required: ["id", "machineId", "name", "allocations", "resourceSummary", "description", "tags", "sortOrder", "status"],
        properties: {
          id: { type: "string", format: "uuid" },
          machineId: { type: "string", format: "uuid" },
          name: { type: "string" },
          allocations: { type: "array", items: { $ref: "#/components/schemas/ResourceAllocation" } },
          resourceSummary: { type: "string" },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          sortOrder: { type: "integer" },
          status: { type: "string", enum: ["ACTIVE", "DISABLED"] },
          version: { type: "integer" }
        }
      },
      ScheduleReservation: {
        type: "object",
        required: ["id", "scope", "machineId", "resourceGroupId", "applicantName", "applicantEmployeeNumber", "startAt", "endAt", "status", "mine"],
        properties: {
          id: { type: "string", format: "uuid" },
          scope: { type: "string", enum: ["RESOURCE_GROUP", "MACHINE"] },
          machineId: { type: "string", format: "uuid" },
          resourceGroupId: { type: "string", format: "uuid" },
          applicantName: { type: "string" },
          applicantEmployeeNumber: { type: ["string", "null"] },
          startAt: { type: "string", format: "date-time" },
          endAt: { type: "string", format: "date-time" },
          status: { type: "string" },
          mine: { type: "boolean" },
          title: { type: "string" },
          purpose: { type: "string" },
          note: { type: "string" },
          initialStartAt: { type: "string", format: "date-time" },
          initialEndAt: { type: "string", format: "date-time" },
          adjustmentType: { type: ["string", "null"] },
          adjustmentReason: { type: "string" }
        }
      },
      Unavailability: {
        type: "object",
        required: ["id", "machineId", "resourceGroupId", "kind", "startAt", "endAt", "reason", "status"],
        properties: {
          id: { type: "string", format: "uuid" },
          machineId: { type: "string", format: "uuid" },
          resourceGroupId: { type: ["string", "null"], format: "uuid" },
          kind: { type: "string", enum: ["PLANNED", "LONG_TERM"] },
          startAt: { type: "string", format: "date-time" },
          endAt: { type: "string", format: "date-time" },
          reason: { type: "string" },
          status: { type: "string", enum: ["ACTIVE", "CANCELLED"] }
        }
      },
      Reservation: {
        type: "object",
        required: ["id", "batchId", "scope", "machineId", "machineName", "resourceGroupId", "resourceGroupName", "startAt", "endAt", "title", "purpose", "note", "status", "createdAt", "updatedAt"],
        properties: {
          id: { type: "string", format: "uuid" },
          batchId: { type: "string", format: "uuid" },
          scope: { type: "string", enum: ["RESOURCE_GROUP", "MACHINE"] },
          machineId: { type: "string", format: "uuid" },
          machineName: { type: "string" },
          resourceGroupId: { type: "string", format: "uuid" },
          resourceGroupName: { type: "string" },
          startAt: { type: "string", format: "date-time" },
          endAt: { type: "string", format: "date-time" },
          initialStartAt: { type: "string", format: "date-time" },
          initialEndAt: { type: "string", format: "date-time" },
          title: { type: "string" },
          purpose: { type: "string" },
          note: { type: "string" },
          status: { type: "string" },
          adjustmentType: { type: ["string", "null"] },
          adjustmentReason: { type: "string" },
          cancellationReason: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" }
        }
      },
      ReservationSegment: {
        type: "object",
        additionalProperties: false,
        required: ["scope", "resourceGroupId", "startAt", "endAt"],
        properties: {
          scope: { type: "string", enum: ["RESOURCE_GROUP", "MACHINE"] },
          machineId: { type: "string", format: "uuid" },
          resourceGroupId: { type: "string", format: "uuid" },
          startMode: { type: "string", enum: ["IMMEDIATE", "SCHEDULED"], default: "SCHEDULED" },
          startAt: { type: "string", format: "date-time", description: "必须精确到分钟" },
          endAt: { type: "string", format: "date-time", description: "必须精确到分钟" },
          title: { type: "string", maxLength: 120, default: "" },
          purpose: { type: "string", maxLength: 500, default: "" },
          note: { type: "string", maxLength: 1000, default: "" }
        }
      },
      PrepareOperationRequest: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["action", "segments"],
            properties: {
              action: { const: "CREATE" },
              segments: { type: "array", minItems: 1, maxItems: 100, items: { $ref: "#/components/schemas/ReservationSegment" } }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["action", "reservationId", "segment"],
            properties: {
              action: { const: "UPDATE" },
              reservationId: { type: "string", format: "uuid" },
              segment: { $ref: "#/components/schemas/ReservationSegment" }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["action", "reservationId"],
            properties: {
              action: { type: "string", enum: ["CANCEL", "END"] },
              reservationId: { type: "string", format: "uuid" },
              reason: { type: "string", maxLength: 500, default: "" }
            }
          }
        ],
        discriminator: { propertyName: "action" }
      },
      PrepareOperationResponse: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: {
            type: "object",
            required: ["action", "status", "preview"],
            properties: {
              operationId: { type: "string", format: "uuid" },
              action: { type: "string", enum: ["CREATE", "UPDATE", "CANCEL", "END"] },
              status: { type: "string", enum: ["READY", "BLOCKED"] },
              preview: {},
              confirmationToken: { type: "string" },
              expiresAt: { type: "string", format: "date-time" }
            }
          },
          meta: { $ref: "#/components/schemas/Meta" }
        }
      }
    }
  }
} as const;
