const requestIdHeader = {
  description: "Unique identifier for this request; include it when contacting an administrator for help",
  schema: { type: "string" }
};

const rateLimitHeader = {
  description: "Per-minute request limit for this token and endpoint group",
  schema: { type: "integer", minimum: 1 }
};

const retryAfterHeader = {
  description: "Recommended seconds to wait after triggering rate limiting",
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
  "Missing Bearer token, or the token is invalid, expired, revoked, or the associated account is disabled"
);
const readRateLimitedResponse = errorResponse(
  "Token exceeds the overall request limit of 120 per minute; wait as indicated by Retry-After and retry",
  { retryAfter: true }
);
const operationRateLimitedResponse = errorResponse(
  "Token exceeds the overall request limit of 120 per minute, or the combined preflight and submission requests exceed 30 per minute; wait as indicated by Retry-After and retry",
  { retryAfter: true }
);
const writeScopeResponse = errorResponse(
  "Token is not READ_WRITE, or the current user no longer has the required permissions to perform this write operation"
);
const internalErrorResponse = errorResponse(
  "An unexpected error occurred while the server was processing the request; you may contact the administrator with the requestId from the response for investigation"
);

const bearerSecurity = [{ bearerAuth: [] }];

export const OPEN_API_DOCUMENT = {
  openapi: "3.1.0",
  info: {
    title: "Allocube Official API",
    version: "1.0.0",
    description:
      "Use this API from AI tools, CLIs, scripts, and server automation to read computing resources and manage your reservations. Every write requires a preflight followed by a commit using a confirmation token that remains valid for 5 minutes. Values such as <UPPER_SNAKE_CASE> are placeholders; replace the entire value, including angle brackets, before sending a request."
  },
  "x-placeholder-convention": {
    syntax: "<UPPER_SNAKE_CASE>",
    description:
      "Placeholders must be replaced entirely with actual values from the current environment or previous responses; {id} in OpenAPI paths still follows standard path template syntax."
  },
  servers: [{ url: "/api/open/v1" }],
  tags: [
    { name: "Identity", description: "Calling identity" },
    { name: "Resources", description: "Machine, resource group, and schedule" },
    { name: "Reservations", description: "Your reservations and two-phase operations" }
  ],
  paths: {
    "/me": {
      get: {
        operationId: "getCurrentApiIdentity",
        tags: ["Identity"],
        summary: "Get the current token identity and permissions",
        security: bearerSecurity,
        responses: {
          "200": {
            description: "Current identity",
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
                          description: "Current calling identity",
                          required: ["user", "token"],
                          properties: {
                            user: { $ref: "#/components/schemas/ApiUser", description: "User to whom the token belongs" },
                            token: { $ref: "#/components/schemas/ApiTokenIdentity", description: "Current token digest" }
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
        summary: "List machines available to the current user",
        security: bearerSecurity,
        parameters: [
          { $ref: "#/components/parameters/Limit" },
          { $ref: "#/components/parameters/Cursor" }
        ],
        responses: {
          "200": {
            description: "Machine list",
            headers: successResponseHeaders,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: {
                      type: "object",
                      description: "Machines on this page",
                      required: ["machines"],
                      properties: {
                        machines: {
                          type: "array",
                          description: "Machines the current user is authorized to use",
                          items: { $ref: "#/components/schemas/Machine" }
                        }
                      }
                    },
                    meta: { $ref: "#/components/schemas/PaginationMeta", description: "Pagination metadata" }
                  }
                }
              }
            }
          },
          "400": errorResponse("Page size, cursor format, or unknown query parameter violates constraints, or the cursor has expired"),
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
        summary: "List resource groups for a machine",
        security: bearerSecurity,
        parameters: [
          { $ref: "#/components/parameters/MachineId" },
          { $ref: "#/components/parameters/Limit" },
          { $ref: "#/components/parameters/Cursor" }
        ],
        responses: {
          "200": {
            description: "Resource group list",
            headers: successResponseHeaders,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: {
                      type: "object",
                      description: "Resource groups on this page",
                      required: ["resourceGroups"],
                      properties: {
                        resourceGroups: {
                          type: "array",
                          description: "Resource groups on this page for the selected machine",
                          items: { $ref: "#/components/schemas/ResourceGroup" }
                        }
                      }
                    },
                    meta: { $ref: "#/components/schemas/PaginationMeta", description: "Pagination metadata" }
                  }
                }
              }
            }
          },
          "400": errorResponse("Machine ID, page size, or cursor format is incorrect, or the cursor has expired"),
          "401": unauthenticatedResponse,
          "403": errorResponse("The current user does not have valid machine access for the target machine"),
          "429": readRateLimitedResponse,
          "500": internalErrorResponse
        }
      }
    },
    "/schedule": {
      get: {
        operationId: "getResourceSchedule",
        tags: ["Resources"],
        summary: "Get schedules for accessible machines within a time range",
        description:
          "The time range must be longer than zero and no more than 8 days. Separate up to 100 machineIds with commas; omit machineIds to include every accessible machine. Users with machine access can see full reservation details.",
        security: bearerSecurity,
        parameters: [
          {
            name: "from",
            in: "query",
            required: true,
            description: "Start of the time window (RFC 3339). Results include reservations and unavailable periods that overlap the window.",
            schema: { type: "string", format: "date-time" }
          },
          {
            name: "to",
            in: "query",
            required: true,
            description: "End of the time window (RFC 3339). Must be later than from, with a maximum span of 8 days.",
            schema: { type: "string", format: "date-time" }
          },
          {
            name: "machineIds",
            in: "query",
            required: false,
            description: "Up to 100 machine UUIDs separated by commas. Omit to include every machine available to the current user.",
            schema: { type: "string", maxLength: 5000 },
            example: "<MACHINE_IDS>"
          }
        ],
        responses: {
          "200": {
            description: "Scheduling data",
            headers: successResponseHeaders,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: {
                      type: "object",
                      description: "Machines, resource groups, reservations, and unavailable periods within the specified window",
                      required: ["machines", "resourceGroups", "reservations", "unavailability"],
                      properties: {
                        machines: { type: "array", description: "Machines involved in this schedule query", items: { $ref: "#/components/schemas/Machine" } },
                        resourceGroups: { type: "array", description: "Resource groups involved in this schedule query", items: { $ref: "#/components/schemas/ResourceGroup" } },
                        reservations: { type: "array", description: "Confirmed reservations intersecting with the query window", items: { $ref: "#/components/schemas/ScheduleReservation" } },
                        unavailability: { type: "array", description: "Unavailable periods intersecting with the query window", items: { $ref: "#/components/schemas/Unavailability" } }
                      }
                    },
                    meta: { $ref: "#/components/schemas/ScheduleMeta", description: "Scheduling metadata" }
                  }
                }
              }
            }
          },
          "400": errorResponse("Incorrect time format or range, invalid machine ID list, query exceeds 100 machines or 8 days"),
          "401": unauthenticatedResponse,
          "403": errorResponse("machineIds contains machines that the current user is not authorized to use"),
          "429": readRateLimitedResponse,
          "500": internalErrorResponse
        }
      }
    },
    "/reservations": {
      get: {
        operationId: "listMyReservations",
        tags: ["Reservations"],
        summary: "List your reservations",
        security: bearerSecurity,
        parameters: [
          {
            name: "from",
            in: "query",
            description: "Return reservations that end after this time (RFC 3339)",
            schema: { type: "string", format: "date-time" }
          },
          {
            name: "to",
            in: "query",
            description: "Return reservations that start before this time (RFC 3339). When used with from, it must also be later than from.",
            schema: { type: "string", format: "date-time" }
          },
          {
            name: "status",
            in: "query",
            description: "Only return reservations with this status",
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
            description: "Your reservations",
            headers: successResponseHeaders,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: {
                      type: "object",
                      description: "Reservations on this page",
                      required: ["reservations"],
                      properties: {
                        reservations: {
                          type: "array",
                          description: "Own reservations matching the filter criteria",
                          items: { $ref: "#/components/schemas/Reservation" }
                        }
                      }
                    },
                    meta: { $ref: "#/components/schemas/PaginationMeta", description: "Pagination metadata" }
                  }
                }
              }
            }
          },
          "400": errorResponse("Incorrect format for time, status, page size, or cursor; cursor is invalid, or 'to' is not later than 'from'"),
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
        summary: "Get one of your reservations",
        security: bearerSecurity,
        parameters: [{ $ref: "#/components/parameters/ReservationId" }],
        responses: {
          "200": {
            description: "Reservation details",
            headers: successResponseHeaders,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: {
                      type: "object",
                      description: "The requested reservation",
                      required: ["reservation"],
                      properties: {
                        reservation: { $ref: "#/components/schemas/Reservation", description: "Target reservation details" }
                      }
                    },
                    meta: { $ref: "#/components/schemas/Meta", description: "Response metadata" }
                  }
                }
              }
            }
          },
          "400": errorResponse("Reservation ID is not a valid UUID"),
          "401": unauthenticatedResponse,
          "404": errorResponse("Reservation not found or not owned by the current user"),
          "429": readRateLimitedResponse,
          "500": internalErrorResponse
        }
      }
    },
    "/reservation-operations/prepare": {
      post: {
        operationId: "prepareReservationOperation",
        tags: ["Reservations"],
        summary: "Preflight a CREATE, UPDATE, CANCEL, or END operation",
        description:
          "All four actions use this endpoint. A READ_WRITE token is required. A BLOCKED response does not include confirmationToken and cannot be committed.",
        security: bearerSecurity,
        requestBody: {
          required: true,
          description: "Choose the request shape that matches action. Unknown fields are rejected. CREATE can preflight 1 to 100 reservation segments at once.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PrepareOperationRequest" },
              examples: {
                create: {
                  summary: "Create a future resource group reservation",
                  value: {
                    action: "CREATE",
                    segments: [
                      {
                        scope: "RESOURCE_GROUP",
                        resourceGroupId: "<RESOURCE_GROUP_ID>",
                        startMode: "SCHEDULED",
                        startAt: "<START_AT_RFC3339>",
                        endAt: "<END_AT_RFC3339>",
                        title: "Model training",
                        purpose: "Validate the new model"
                      }
                    ]
                  }
                },
                update: {
                  summary: "Update one of your reservations",
                  value: {
                    action: "UPDATE",
                    reservationId: "<RESERVATION_ID>",
                    segment: {
                      scope: "RESOURCE_GROUP",
                      resourceGroupId: "<RESOURCE_GROUP_ID>",
                      startMode: "SCHEDULED",
                      startAt: "<START_AT_RFC3339>",
                      endAt: "<END_AT_RFC3339>",
                      title: "Adjusted model training",
                      purpose: "Validate the new model"
                    }
                  }
                },
                cancel: {
                  summary: "Cancel my own future reservations",
                  value: {
                    action: "CANCEL",
                    reservationId: "<RESERVATION_ID>",
                    reason: "Task cancelled"
                  }
                },
                end: {
                  summary: "End one of your ongoing reservations early",
                  value: {
                    action: "END",
                    reservationId: "<RESERVATION_ID>",
                    reason: "Task completed early"
                  }
                }
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Preflight result: READY or BLOCKED",
            headers: successResponseHeaders,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PrepareOperationResponse" }
              }
            }
          },
          "400": errorResponse("Request body, time, reservation fragment, or unknown field does not meet constraints"),
          "401": unauthenticatedResponse,
          "403": writeScopeResponse,
          "404": errorResponse("Target reservation, machine, or resource group not found or unavailable to the current user"),
          "409": errorResponse("Reservation status or resource configuration no longer allows this operation; refresh the data and run the preflight again"),
          "429": operationRateLimitedResponse,
          "500": internalErrorResponse
        }
      }
    },
    "/reservation-operations/commit": {
      post: {
        operationId: "commitReservationOperation",
        tags: ["Reservations"],
        summary: "Commit a successful reservation preflight",
        description:
          "This endpoint is common for CREATE, UPDATE, CANCEL, and END. Ensure the token is already bound to the action in 'prepare'; the action does not need to be passed again on submission. The token is bound to both the user who issued it and the personal access token; successful submissions can be safely retried within 24 hours without duplicate execution.",
        security: bearerSecurity,
        requestBody: {
          required: true,
          description: "Confirmation token returned by prepare. It is valid for 5 minutes and bound to the user, personal access token, and preflight request.",
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
                      "One-time confirmation token returned by prepare. Send the exact value from that response.",
                    example: "<CONFIRMATION_TOKEN>"
                  }
                }
              },
              examples: {
                commit: {
                  summary: "Confirmation token returned by prepare",
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
            description: "Operation result; meta.replayed indicates whether it is a safe replay",
            headers: successResponseHeaders,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CommitOperationResponse" },
                examples: {
                  create: {
                    summary: "CREATE completed",
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
                          title: "Model training",
                          purpose: "Regression validation",
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
                    summary: "UPDATE completed",
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
                    summary: "CANCEL completed",
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
                    summary: "END completed",
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
          "400": errorResponse("confirmationToken is missing, malformed, or the request contains unknown fields"),
          "401": unauthenticatedResponse,
          "403": writeScopeResponse,
          "404": errorResponse("Confirmation token not found or bound to a different user or API token"),
          "409": errorResponse("Permissions, resources, or reservation status changed after the preflight, or the operation is no longer valid; run the preflight again"),
          "410": errorResponse("Confirmation token expired after 5 minutes; run the preflight again"),
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
        description: "Maximum number of records to return per page",
        schema: { type: "integer", minimum: 1, maximum: 200, default: 50 }
      },
      Cursor: {
        name: "cursor",
        in: "query",
        required: false,
        schema: { type: "string", maxLength: 2000 },
        description: "The opaque cursor returned by meta.nextCursor on the previous page"
      },
      MachineId: {
        name: "id",
        in: "path",
        required: true,
        description: "Machine UUID of the resource group to query",
        schema: { type: "string", format: "uuid" }
      },
      ReservationId: {
        name: "id",
        in: "path",
        required: true,
        description: "UUID of one of your reservations",
        schema: { type: "string", format: "uuid" }
      }
    },
    schemas: {
      Meta: {
        type: "object",
        description: "Common metadata included in all successful responses",
        required: ["serverTime"],
        properties: {
          serverTime: {
            type: "string",
            format: "date-time",
            description: "Time when the server generated the response (RFC 3339)"
          }
        },
        additionalProperties: true
      },
      PaginationMeta: {
        type: "object",
        description: "Metadata for cursor-based pagination response",
        required: ["serverTime", "nextCursor"],
        properties: {
          serverTime: {
            type: "string",
            format: "date-time",
            description: "Time when the server generated the response (RFC 3339)"
          },
          nextCursor: {
            type: ["string", "null"],
            description: "Opaque cursor for the next page; null indicates no next page"
          }
        },
        additionalProperties: false
      },
      ScheduleMeta: {
        type: "object",
        description: "Metadata for the scheduling response",
        required: ["serverTime", "scheduleRevision"],
        properties: {
          serverTime: {
            type: "string",
            format: "date-time",
            description: "Time when the server generated the response (RFC 3339)"
          },
          scheduleRevision: {
            type: "integer",
            minimum: 1,
            description: "Global scheduling revision number; a change indicates scheduling data may have been updated"
          }
        },
        additionalProperties: false
      },
      SuccessEnvelope: {
        type: "object",
        description: "Outer structure for generic success response",
        required: ["data", "meta"],
        properties: {
          data: { type: "object", description: "Data returned by the endpoint" },
          meta: {
            $ref: "#/components/schemas/Meta",
            description: "Response metadata"
          }
        }
      },
      ErrorResponse: {
        type: "object",
        description: "Unified response structure used for all API errors",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            description: "Error details",
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
                description: "Stable machine-readable error code, usable for programmatic branching logic"
              },
              message: {
                type: "string",
                description: "Error description for the caller; it is not recommended for programs to rely on specific wording"
              },
              details: {
                description: "Optional structured context; validation errors, conflicts, and rate limiting will provide different fields"
              },
              requestId: {
                type: "string",
                description: "Unique identifier for this request, consistent with the X-Request-Id response header"
              }
            }
          }
        }
      },
      ApiUser: {
        type: "object",
        description: "Current user to whom the personal access token belongs",
        additionalProperties: false,
        required: ["id", "username", "displayName", "employeeNumber", "role"],
        properties: {
          id: { type: "string", format: "uuid", description: "User UUID" },
          username: { type: "string", description: "Login username" },
          displayName: { type: "string", description: "Name displayed on pages and records" },
          employeeNumber: { type: ["string", "null"], description: "Current valid employee ID; null if not set" },
          role: { type: "string", enum: ["SYSTEM_ADMIN", "USER"], description: "User role" }
        }
      },
      ApiTokenIdentity: {
        type: "object",
        description: "Security digest of the personal access token used in the current request, does not contain the plaintext token",
        additionalProperties: false,
        required: ["id", "name", "prefix", "accessLevel", "expiresAt"],
        properties: {
          id: { type: "string", format: "uuid", description: "Token record UUID" },
          name: { type: "string", description: "Name set by the user for the token" },
          prefix: { type: "string", description: "Non-sensitive prefix for identifying the token" },
          accessLevel: { type: "string", enum: ["READ_ONLY", "READ_WRITE"], description: "Token permissions; write operations must be READ_WRITE" },
          expiresAt: { type: ["string", "null"], format: "date-time", description: "Token expiration time (RFC 3339); null means never expires" }
        }
      },
      Machine: {
        type: "object",
        description: "Machines the current user is authorized to use",
        additionalProperties: false,
        required: ["id", "name", "address", "hardwareNotes", "connectionGuide", "resourceSummary", "tags", "status", "isManager"],
        properties: {
          id: { type: "string", format: "uuid", description: "Machine UUID" },
          name: { type: "string", description: "Machine name" },
          address: { type: "string", description: "Machine address or access location filled in by the administrator" },
          hardwareNotes: { type: "string", description: "Hardware configuration description" },
          connectionGuide: { type: "string", description: "Connection and usage instructions" },
          resourceSummary: { type: "string", description: "Brief summary of resource groups under a machine" },
          tags: { type: "array", description: "Machine tag", items: { type: "string", description: "A single tag" } },
          status: { type: "string", enum: ["ACTIVE", "DISABLED"], description: "Whether the machine is available for new reservations" },
          isManager: { type: "boolean", description: "Whether the current user can manage this machine" }
        }
      },
      ResourceRange: {
        type: "object",
        description: "A continuous range of numbers from a numbered resource",
        additionalProperties: false,
        required: ["start", "end"],
        properties: {
          start: { type: "integer", description: "Start ID, inclusive" },
          end: { type: "integer", description: "End ID, inclusive" },
          label: { type: "string", description: "Optional remark set by the administrator for this number range" }
        }
      },
      ResourceItem: {
        type: "object",
        description: "A specific device within the device list resource",
        additionalProperties: false,
        required: ["id", "key", "label"],
        properties: {
          id: { type: "string", format: "uuid", description: "Device UUID" },
          key: { type: "string", description: "The stable identifier of a device within the resource pool" },
          label: { type: "string", description: "Device display name" }
        }
      },
      ResourceAllocation: {
        type: "object",
        description: "Number, device, or capacity allocated to a resource group from a resource pool",
        required: ["poolId", "poolName", "kind", "sharingMode", "unit"],
        properties: {
          poolId: { type: "string", format: "uuid", description: "Resource pool UUID" },
          poolName: { type: "string", description: "Resource pool name snapshot" },
          kind: { type: "string", enum: ["INDEX_RANGE", "ITEM_LIST", "CAPACITY"], description: "Allocation type of the resource pool" },
          sharingMode: { type: "string", enum: ["EXCLUSIVE", "SHARED"], description: "Whether the resource allows sharing among multiple resource groups" },
          unit: { type: "string", description: "Display unit for resource quantity" },
          ranges: { type: "array", description: "Number range allocated for INDEX_RANGE type", items: { $ref: "#/components/schemas/ResourceRange" } },
          items: { type: "array", description: "Equipment allocated for ITEM_LIST type", items: { $ref: "#/components/schemas/ResourceItem" } },
          quantity: { type: "number", description: "Capacity allocated for CAPACITY type, up to three decimal places" }
        }
      },
      ResourceGroup: {
        type: "object",
        description: "Collection of resources under a machine that can be reserved",
        required: ["id", "machineId", "name", "allocations", "resourceSummary", "description", "tags", "sortOrder", "status"],
        properties: {
          id: { type: "string", format: "uuid", description: "Resource group UUID" },
          machineId: { type: "string", format: "uuid", description: "Owning machine UUID" },
          name: { type: "string", description: "Resource group name" },
          allocations: { type: "array", description: "Resource allocation details owned by the resource group", items: { $ref: "#/components/schemas/ResourceAllocation" } },
          resourceSummary: { type: "string", description: "Human-readable summary of resource allocation" },
          description: { type: "string", description: "Resource group description filled in by the administrator" },
          tags: { type: "array", description: "Resource group tags", items: { type: "string", description: "A single tag" } },
          sortOrder: { type: "integer", description: "Display order within the same machine; smaller values appear earlier" },
          status: { type: "string", enum: ["ACTIVE", "DISABLED"], description: "Whether the resource group accepts new reservations" },
          version: { type: "integer", description: "Resource group configuration version; the schedule endpoint may omit this field" }
        }
      },
      ScheduleReservation: {
        type: "object",
        description: "Confirmed reservations within the scheduling window related to machines accessible by the current user",
        required: ["id", "scope", "machineId", "resourceGroupId", "applicantName", "applicantEmployeeNumber", "startAt", "endAt", "status", "mine", "title", "purpose", "note", "initialStartAt", "initialEndAt", "adjustmentType", "adjustmentReason"],
        properties: {
          id: { type: "string", format: "uuid", description: "Reservation UUID" },
          scope: { type: "string", enum: ["RESOURCE_GROUP", "MACHINE"], description: "Reservation scope: one resource group or the entire machine" },
          machineId: { type: "string", format: "uuid", description: "Owning machine UUID" },
          resourceGroupId: { type: "string", format: "uuid", description: "Resource group UUID for the reservation; represents the resource group for whole-machine reservations" },
          applicantName: { type: "string", description: "Applicant's display name" },
          applicantEmployeeNumber: { type: ["string", "null"], description: "Applicant's current valid employee ID; null if not set" },
          startAt: { type: "string", format: "date-time", description: "Currently effective start time (RFC 3339)" },
          endAt: { type: "string", format: "date-time", description: "Currently effective end time (RFC 3339)" },
          status: { type: "string", enum: ["CONFIRMED"], description: "The schedule endpoint only returns active confirmed reservations" },
          mine: { type: "boolean", description: "Whether this reservation belongs to the current user" },
          title: { type: "string", description: "Reservation title" },
          purpose: { type: "string", description: "Reservation purpose" },
          note: { type: "string", description: "Reservation supplementary notes" },
          initialStartAt: { type: "string", format: "date-time", description: "Start time at initial creation" },
          initialEndAt: { type: "string", format: "date-time", description: "End time at initial creation" },
          adjustmentType: { type: ["string", "null"], description: "The reason type for the time adjustment; null if not adjusted" },
          adjustmentReason: { type: "string", description: "Description of the time adjustment reason" }
        }
      },
      Unavailability: {
        type: "object",
        description: "Unavailable time slots for a machine or resource group",
        required: ["id", "machineId", "resourceGroupId", "kind", "startAt", "endAt", "reason", "status"],
        properties: {
          id: { type: "string", format: "uuid", description: "Unavailability record UUID" },
          machineId: { type: "string", format: "uuid", description: "Owning machine UUID" },
          resourceGroupId: { type: ["string", "null"], format: "uuid", description: "Affected resource group UUID; null indicates the entire machine is unavailable" },
          kind: { type: "string", enum: ["PLANNED", "LONG_TERM"], description: "Planned maintenance or long-term deactivation" },
          startAt: { type: "string", format: "date-time", description: "Unavailability start time (RFC 3339)" },
          endAt: { type: "string", format: "date-time", description: "Unavailability end time (RFC 3339)" },
          reason: { type: "string", description: "Reason for unavailability" },
          status: { type: "string", enum: ["ACTIVE", "CANCELLED"], description: "Unavailability record status" }
        }
      },
      Reservation: {
        type: "object",
        description: "Complete reservation records owned by the current user",
        required: ["id", "batchId", "scope", "machineId", "machineName", "resourceGroupId", "resourceGroupName", "startAt", "endAt", "title", "purpose", "note", "status", "createdAt", "updatedAt"],
        properties: {
          id: { type: "string", format: "uuid", description: "Reservation UUID" },
          batchId: { type: "string", format: "uuid", description: "Reservation batch UUID generated by the same CREATE operation" },
          scope: { type: "string", enum: ["RESOURCE_GROUP", "MACHINE"], description: "Reservation scope: one resource group or the entire machine" },
          machineId: { type: "string", format: "uuid", description: "Owning machine UUID" },
          machineName: { type: "string", description: "Machine name" },
          resourceGroupId: { type: "string", format: "uuid", description: "Resource group UUID" },
          resourceGroupName: { type: "string", description: "Resource group name, or 'Entire machine' for a machine-wide reservation" },
          startAt: { type: "string", format: "date-time", description: "Currently effective start time (RFC 3339)" },
          endAt: { type: "string", format: "date-time", description: "Currently effective end time (RFC 3339)" },
          initialStartAt: { type: "string", format: "date-time", description: "Start time at initial creation" },
          initialEndAt: { type: "string", format: "date-time", description: "End time at initial creation" },
          title: { type: "string", description: "Reservation title" },
          purpose: { type: "string", description: "Reservation purpose" },
          note: { type: "string", description: "Reservation supplementary notes" },
          status: { type: "string", enum: ["CONFIRMED", "CANCELLED", "CANCELLED_UNAVAILABILITY"], description: "Current status of the reservation" },
          adjustmentType: { type: ["string", "null"], description: "The reason type for the time adjustment; null if not adjusted" },
          adjustmentReason: { type: "string", description: "Description of the time adjustment reason" },
          cancellationReason: { type: "string", description: "Cancellation reason; empty string when not cancelled" },
          createdAt: { type: "string", format: "date-time", description: "Reservation creation time" },
          updatedAt: { type: "string", format: "date-time", description: "Reservation last update time" }
        }
      },
      ReservationSegment: {
        type: "object",
        description: "Target resources and time slots for creating or updating a reservation",
        additionalProperties: false,
        required: ["scope", "resourceGroupId", "startAt", "endAt"],
        properties: {
          scope: { type: "string", enum: ["RESOURCE_GROUP", "MACHINE"], description: "RESOURCE_GROUP occupies only the target resource group; MACHINE occupies all resource groups of the target machine" },
          machineId: { type: "string", format: "uuid", description: "Machine UUID for a machine-wide reservation. The server validates and normalizes it from resourceGroupId." },
          resourceGroupId: { type: "string", format: "uuid", description: "Target resource group UUID; a whole-machine reservation also requires passing a resource group under that machine" },
          startMode: { type: "string", enum: ["IMMEDIATE", "SCHEDULED"], default: "SCHEDULED", description: "Start immediately or schedule to start at startAt" },
          startAt: { type: "string", format: "date-time", description: "Start time (RFC 3339) using whole-minute precision. IMMEDIATE is normalized to the server's current minute." },
          endAt: { type: "string", format: "date-time", description: "End time (RFC 3339) using whole-minute precision and later than startAt" },
          title: { type: "string", maxLength: 120, default: "", description: "Reservation title" },
          purpose: { type: "string", maxLength: 500, default: "", description: "Reservation purpose" },
          note: { type: "string", maxLength: 1000, default: "", description: "Additional notes" }
        }
      },
      PrepareOperationRequest: {
        description: "Preflight request for reservation write operations; action determines the remaining fields",
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["action", "segments"],
            properties: {
              action: { const: "CREATE", description: "Create a batch of new reservations" },
              segments: { type: "array", minItems: 1, maxItems: 100, description: "Reservation segments to validate in one batch; all segments must use the same scope", items: { $ref: "#/components/schemas/ReservationSegment" } }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["action", "reservationId", "segment"],
            properties: {
              action: { const: "UPDATE", description: "Update one of your existing reservations" },
              reservationId: { type: "string", format: "uuid", description: "UUID of the reservation to update" },
              segment: { $ref: "#/components/schemas/ReservationSegment", description: "The complete updated reservation segment" }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["action", "reservationId"],
            properties: {
              action: { type: "string", enum: ["CANCEL", "END"], description: "CANCEL cancels a future reservation; END ends an ongoing reservation early" },
              reservationId: { type: "string", format: "uuid", description: "UUID of the reservation to cancel or end early" },
              reason: { type: "string", maxLength: 500, default: "", description: "Reason for this operation" }
            }
          }
        ],
        discriminator: { propertyName: "action" }
      },
      ReservationConflict: {
        type: "object",
        description: "Conflicts causing the target time slot to be unavailable",
        additionalProperties: false,
        required: ["type", "startAt", "endAt", "label"],
        properties: {
          type: { type: "string", description: "Conflict type, e.g., existing reservation or resource unavailability" },
          startAt: { type: "string", format: "date-time", description: "Conflict start time" },
          endAt: { type: "string", format: "date-time", description: "Conflict end time" },
          label: { type: "string", description: "Conflict description suitable for direct display" }
        }
      },
      ReservationAvailability: {
        type: "object",
        description: "Availability result for one reservation segment",
        additionalProperties: false,
        required: ["input", "available", "conflicts", "splitSegments"],
        properties: {
          input: { $ref: "#/components/schemas/ReservationSegment", description: "Input segment normalized by the server" },
          available: { type: "boolean", description: "Whether the target fragment can currently be submitted" },
          conflicts: { type: "array", description: "Conflicts blocking submission; empty array when available", items: { $ref: "#/components/schemas/ReservationConflict" } },
          splitSegments: { type: "array", description: "Suggested available segments that avoid conflicts", items: { $ref: "#/components/schemas/ReservationSegment" } }
        }
      },
      ReservationOperationSummary: {
        type: "object",
        description: "Summary of the original reservation involved in the preflight operation",
        additionalProperties: false,
        required: ["id", "scope", "machineId", "resourceGroupId", "startAt", "endAt", "title", "purpose", "note", "status"],
        properties: {
          id: { type: "string", format: "uuid", description: "Reservation UUID" },
          scope: { type: "string", enum: ["RESOURCE_GROUP", "MACHINE"], description: "Reservation scope" },
          machineId: { type: "string", format: "uuid", description: "Machine UUID" },
          resourceGroupId: { type: "string", format: "uuid", description: "Resource group UUID" },
          startAt: { type: "string", format: "date-time", description: "Current start time" },
          endAt: { type: "string", format: "date-time", description: "Current end time" },
          title: { type: "string", description: "Reservation title" },
          purpose: { type: "string", description: "Reservation purpose" },
          note: { type: "string", description: "Additional notes" },
          status: { type: "string", description: "Current status of the reservation" }
        }
      },
      CreateOperationPreview: {
        type: "object",
        description: "Preflight details for CREATE",
        required: ["items", "serverNow"],
        properties: {
          items: { type: "array", description: "Availability result for each input fragment", items: { $ref: "#/components/schemas/ReservationAvailability" } },
          serverNow: { type: "string", format: "date-time", description: "Server time when preflight was executed" }
        }
      },
      UpdateOperationPreview: {
        type: "object",
        description: "Preflight details for UPDATE",
        required: ["reservation", "segment", "item", "serverNow"],
        properties: {
          reservation: { $ref: "#/components/schemas/ReservationOperationSummary", description: "Reservation before the update" },
          segment: { $ref: "#/components/schemas/ReservationSegment", description: "New fragment standardized by the server" },
          item: { $ref: "#/components/schemas/ReservationAvailability", description: "Availability result for the new segment" },
          serverNow: { type: "string", format: "date-time", description: "Server time when preflight was executed" }
        }
      },
      ExistingReservationPreview: {
        type: "object",
        description: "Preflight details for CANCEL or END",
        required: ["reservation", "serverNow"],
        properties: {
          reservation: { $ref: "#/components/schemas/ReservationOperationSummary", description: "Summary of the reservation affected by this operation" },
          serverNow: { type: "string", format: "date-time", description: "Server time when preflight was executed" }
        }
      },
      PrepareOperationResponse: {
        type: "object",
        description: "Preflight response for reservation write operations",
        required: ["data", "meta"],
        properties: {
          data: {
            type: "object",
            description: "Preflight business result",
            required: ["action", "status", "preview"],
            properties: {
              operationId: { type: "string", format: "uuid", description: "Preflight UUID generated when READY; omitted when BLOCKED" },
              action: { type: "string", enum: ["CREATE", "UPDATE", "CANCEL", "END"], description: "Action checked by this preflight" },
              status: { type: "string", enum: ["READY", "BLOCKED"], description: "READY can be committed. BLOCKED requires a revised request and a new preflight." },
              preview: {
                description: "Action-specific preflight details",
                oneOf: [
                  { $ref: "#/components/schemas/CreateOperationPreview" },
                  { $ref: "#/components/schemas/UpdateOperationPreview" },
                  { $ref: "#/components/schemas/ExistingReservationPreview" }
                ]
              },
              confirmationToken: { type: "string", description: "One-time confirmation token returned when READY; omitted when BLOCKED" },
              expiresAt: { type: "string", format: "date-time", description: "Confirmation token expiration time, 5 minutes after issuance" }
            }
          },
          meta: { $ref: "#/components/schemas/Meta", description: "Response metadata" }
        }
      },
      CommittedReservation: {
        allOf: [
          { $ref: "#/components/schemas/ReservationSegment" },
          {
            type: "object",
            description: "Reservation ID and normalized segment created by CREATE",
            required: ["id", "machineId"],
            properties: {
              id: { type: "string", format: "uuid", description: "New reservation UUID" },
              machineId: { type: "string", format: "uuid", description: "Machine UUID determined by the server based on the resource group" }
            }
          }
        ]
      },
      CreateCommitResult: {
        type: "object",
        description: "CREATE submission result",
        required: ["batchId", "reservations", "revision", "serverNow"],
        properties: {
          batchId: { type: "string", format: "uuid", description: "Batch UUID for this batch of new reservations" },
          reservations: { type: "array", description: "Reservations created by this request", items: { $ref: "#/components/schemas/CommittedReservation" } },
          revision: { type: "integer", description: "Global schedule revision number after submission" },
          serverNow: { type: "string", format: "date-time", description: "Server time at submission completion" }
        }
      },
      UpdateCommitResult: {
        type: "object",
        description: "UPDATE submission result",
        required: ["id", "revision"],
        properties: {
          id: { type: "string", format: "uuid", description: "UUID of the modified reservation" },
          revision: { type: "integer", description: "Global schedule revision number after submission" }
        }
      },
      CancelCommitResult: {
        type: "object",
        description: "CANCEL submission result",
        required: ["id", "cancelled", "revision"],
        properties: {
          id: { type: "string", format: "uuid", description: "Cancelled reservation UUID" },
          cancelled: { const: true, description: "Fixed as true, indicating successful cancellation" },
          revision: { type: "integer", description: "Global schedule revision number after submission" }
        }
      },
      EndCommitResult: {
        type: "object",
        description: "END submission result",
        required: ["id", "ended", "removed", "revision"],
        properties: {
          id: { type: "string", format: "uuid", description: "UUID of the reservation that ended early" },
          ended: { const: true, description: "Fixed as true, indicating successful early termination" },
          removed: { type: "boolean", description: "True when the reservation is removed directly before it actually starts" },
          revision: { type: "integer", description: "Global schedule revision number after submission" }
        }
      },
      CommitOperationResponse: {
        type: "object",
        description: "Commit response; the data shape depends on the action prepared earlier",
        required: ["data", "meta"],
        properties: {
          data: {
            description: "Submission result for CREATE, UPDATE, CANCEL, or END",
            oneOf: [
              { $ref: "#/components/schemas/CreateCommitResult" },
              { $ref: "#/components/schemas/UpdateCommitResult" },
              { $ref: "#/components/schemas/CancelCommitResult" },
              { $ref: "#/components/schemas/EndCommitResult" }
            ]
          },
          meta: {
            type: "object",
            description: "Submission response metadata",
            required: ["serverTime", "replayed"],
            properties: {
              serverTime: { type: "string", format: "date-time", description: "Time when the server generated the response" },
              replayed: { type: "boolean", description: "Whether to return results previously submitted successfully with the same confirmation token" }
            }
          }
        }
      }
    }
  }
} as const;
