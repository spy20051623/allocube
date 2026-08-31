# Official API

The Allocube Official API is designed for AI tools, CLIs, scripts, and server-side integrations. Its stable base path is `/api/open/v1`. The web app's internal `/api/v1` endpoints are not part of the public compatibility contract.

## OpenAPI

- OpenAPI 3.1: `/api/open/v1/openapi.json`
- API Base Path: `/api/open/v1`
- Time: UTC RFC 3339
- ID: UUID
- Fields: `camelCase`

The endpoint reference on this page is generated directly from OpenAPI, which is the source of truth for fields and schemas.

All values that must be replaced in this chapter use `<UPPER_SNAKE_CASE>`. The angle brackets are placeholder markers and must not be submitted as-is; see the [documentation placeholder convention](/docs#documentation-placeholder-convention) for complete rules.

Unless a full path is explicitly written, all paths in this chapter and the endpoint reference are relative to the base path `/api/open/v1`.

## Creating a personal access token

Create a token under "Profile → API tokens". Enter a name, choose its access level, and confirm with your current password.

- `READ_ONLY`: Query resources, schedules, and your own reservations.
- `READ_WRITE`: Includes read access and lets you preflight and commit your own reservation changes.

The token is shown only once. Store it in a trusted secrets manager or process environment variable. Never put it in browser storage, logs, chat messages, or source control.

```text
Authorization: Bearer <API_TOKEN>
```

The Official API does not accept web cookies and does not fall back to web sessions.

## Quick verification

```bash
export ALLOCUBE_BASE_URL="<BASE_URL>"
export ALLOCUBE_API_TOKEN="<API_TOKEN>"

curl \
  -H "Authorization: Bearer $ALLOCUBE_API_TOKEN" \
  "$ALLOCUBE_BASE_URL/api/open/v1/me"
```

Every successful response uses this shape:

```json
{
  "data": {},
  "meta": {}
}
```

Every error uses this shape:

```json
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "The personal access token is invalid, expired, or revoked",
    "requestId": "<REQUEST_ID>"
  }
}
```

## Query flow

Typical call sequence:

1. `GET /me` to check the token identity and permissions.
2. `GET /machines` to list accessible machines.
3. `GET /machines/{id}/resource-groups` to get structured resource allocations.
4. `GET /schedule` to inspect a time window.
5. `GET /reservations` to list your reservations.

Lists use opaque cursors. Pass the previous page's `meta.nextCursor` unchanged as the next request's `cursor`. Do not parse or construct cursor values.

## Two-phase write

Creating, updating, canceling, or ending a reservation requires a preflight followed by a commit.

All four actions use two endpoints. Set `action` to `CREATE`, `UPDATE`, `CANCEL`, or `END` in the `prepare` body. The confirmation token binds that action, so `commit` does not need an `action` field.

### Step 1: preflight

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
      "title": "Model Training",
      "purpose": "Regression Validation"
    }
  ]
}
```

Send this to `POST /reservation-operations/prepare`. A `READY` response includes a `confirmationToken` valid for 5 minutes. A `BLOCKED` response contains conflicts and split suggestions but cannot be committed.

### Step 2: commit

```json
{
  "confirmationToken": "<CONFIRMATION_TOKEN>"
}
```

Send to `POST /reservation-operations/commit`. The confirmation token is bound to the user who issued it and the personal access token used to initiate the pre-check. It cannot be used across users or across tokens.

Replace `<CONFIRMATION_TOKEN>` with the exact `confirmationToken` returned by the same successful `prepare` call. Never submit the placeholder or a value copied from the documentation.

Successful results are retained for 24 hours. Submitting the same confirmation token repeatedly returns the original result and marks it as a replay in `meta.replayed`. It will not create duplicate reservations.

### Four operations

- `CREATE`: Up to 100 segments of the same scope per operation.
- `UPDATE`: Can only modify your own reservations; cannot change the resource group or reservation scope.
- `CANCEL`: Can only cancel your own future reservations.
- `END`: Can only end your own ongoing reservations early.

The `prepare` request body in the endpoint reference provides complete JSON examples for each of the four actions; they are not four separate URLs.

Machine administrators still cannot use the Official API to change another user's reservations.

## Rate limiting

- Each token: maximum 120 requests per minute.
- Pre-check and commit combined: maximum 30 requests per minute.

For `429 RATE_LIMITED`, wait for the number of seconds in `Retry-After` before retrying. Do not retry in a tight loop.

## Security and privacy

- The API does not return CORS permission headers and is not intended for third-party browser pages.
- `/schedule` only returns machines the current user has access to; the user's name, employee ID, title, purpose, notes, original times, and adjustment reasons for reservations on these machines are fully visible.
- Viewing schedule details does not grant write access; the API can only change reservations owned by the token's user.
- Account permissions, machine membership, disabled, and deleted statuses take effect immediately on the next request.
- Password changes or resets do not revoke personal access tokens; revocation must be done separately.

## Compatibility policy

`/api/open/v1` will only accept backward-compatible additions during its v1 lifecycle, such as adding endpoints or optional response fields; existing fields will not be removed, renamed, made required, nor will their existing semantics be changed. Adjustments that truly require breaking compatibility will use a new major version path, e.g., `/api/open/v2`.

Clients should ignore unrecognized response fields to remain compatible with subsequent additions within v1; request bodies still undergo strict validation—do not send fields not defined in the OpenAPI specification.
