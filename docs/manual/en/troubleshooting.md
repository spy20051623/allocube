# Troubleshooting

## Request origin not trusted

Browser write requests must be same-origin. Common causes include:

- Page and API use different protocols, domains, or ports.
- Switching between `localhost` and `127.0.0.1`.
- Reverse proxy does not correctly pass `Host`, `X-Forwarded-Host`, or `X-Forwarded-Proto`.

Do not disable Origin or CSRF validation; fix the access address and proxy configuration instead.

## Logged out immediately after login

Check:

- Whether the system time is correct.
- Whether the login session has already expired.
- Whether the account is disabled.
- Whether the browser allows cookies for the current site.
- Whether protocol headers are correctly passed to the application after HTTPS termination.

## Cannot see machines or resource groups

- Confirm the machine status and your access under "Resources".
- Check whether your machine access request is still pending.
- Confirm the machine or resource group is not disabled or deleted.
- Machine administrators can only manage authorized machines.

## No locate action in Reservations

Reservations opens from the calendar title. The Ended section includes cancelled records, but cancelled records cannot be located. Deleted machines or groups and lost machine access also disable location. Select a machine before filtering resource groups; switching machines clears the group filter.

## Editing sequence changed or submission result uncertain

An administrator adjustment, cancellation, or an original reservation ending invalidates the sequence. Draft inputs remain available, but discard the edit and select current originals after reviewing them. Changes to originals, permission failures, and other validation failures apply none of the batch; availability conflicts in new slots are adjusted automatically. If the request has a network failure, inspect the latest records before deciding whether it committed; do not treat an uncertain result as a definite failure and immediately retry.

## Conflict when submitting a reservation

Resources can change between preview and submission. The calendar automatically adjusts draft availability, and submission rechecks and adjusts within the write transaction. Notifications report the remaining or saved count. If no slots remain, nothing is created and originals in the editing sequence stay unchanged; add other time slots. A network error means checks are temporarily unavailable, not that drafts should be deleted or originals have changed.

## Reservation changed due to maintenance

Maintenance or disabling may cancel, truncate, or split reservations. View notifications and the adjustment reason in reservation details. Canceling maintenance does not automatically restore adjusted reservations; they must be recreated.

## Not receiving emails

System administrators should check:

- Whether SMTP is enabled and its status is available.
- Whether server, port, security mode, account, and sender match the service provider's requirements.
- Test email results and recent errors in the persisted outbox.
- Whether the site address is correct.
- Whether the user's email is verified and its domain is in the allowlist.

In-app notifications still work when email is disabled. Not every notification sends an email: routine events and feedback updates normally stay in-app. Administrator review summaries cover requests pending for more than 15 minutes, checked every 30 minutes, and do not repeat for the same request version and administrator. Also check the user’s Schedule impact/Overdue reviews preferences.

## Password reset link invalid

The link can be used once and expires after 30 minutes. Request a new one, or contact a system administrator if the account has no email address. Resetting the password invalidates old web sessions but does not revoke API tokens.

## API request failure

First read the `error.code`, `error.message`, and `error.requestId` from the response, then handle based on HTTP status:

| Status | Common Causes | Handling |
|---|---|---|
| `400` | Parameters, timing, request body, or reservation fragment violate constraints, or request contains unknown fields | Correct the request per the current OpenAPI spec; do not retry unchanged |
| `401` | `Authorization` header missing `Bearer`, token is incomplete, invalid, expired, revoked, or account is disabled | Correct authentication info or create a new token; web cookies cannot be used for official APIs |
| `403` | `INSUFFICIENT_SCOPE` means a read-only token attempted a write; `FORBIDDEN` means the user lacks machine access or does not own the reservation | Use a token with write access, then verify machine access and reservation ownership |
| `404` | The target was not found or is hidden because the current user cannot access it | Check IDs and access; do not use this response to infer another user's resources or reservations |
| `409` | Permissions, resource configuration, or reservation status changed after preflight, or the operation is already invalid | Discard the old confirmation token, refresh data, and re-run preflight |
| `410` | Confirmation token has exceeded the 5-minute validity period | Re-run preflight and submit using a new token |
| `429` | Exceeded overall request limits, or separate limits for preflight and submission | Read `Retry-After` and wait; reduce polling and concurrency frequency |

When “Prevent system administrators from submitting reservations” is enabled, CREATE and UPDATE preflight requests by system administrators return `403 FORBIDDEN`. If the restriction is enabled after preflight, commit returns `409 OPERATION_REJECTED`. Both responses explain that a personal account is required and include `error.details.rejectionCode: "ADMIN_BOOKING_DISABLED"`. A rejected confirmation token stays rejected with the same reason on retries; use a personal account's token and prepare a new operation. Cancellation, early release, and idempotent replays of successful operations remain available.

See the live OpenAPI reference in [Official API](/docs/api) for each endpoint's status codes and error cases.

## Initial production startup fails on the administrator password

Check whether the log reports a missing or invalid `BOOTSTRAP_ADMIN_PASSWORD`, and confirm `NODE_ENV=production`. Direct startup reads `.env` from the working directory; Docker Compose uses `.env.production`. Correct the configuration and restart with the same database directory, keeping any empty schema and instance secrets. Existing accounts require an in-app password change or the server-side recovery command.

## Missing statistics dates or failed recalculation

Today is excluded. Before 06:00 Beijing time, statistics normally extend through two days ago; afterward, through yesterday. Dates without stored results contribute zero, without missing-day counts or date lists. After initial backfill or recovery completes, refresh to read the newly stored results; Refresh does not recalculate data.

Only system administrators can start a full recalculation at the top right of the page. Previous statistics remain available after failure. Check server logs, disk space, and database permissions before retrying. Closing the page does not cancel a task, and restarting the service resumes unfinished work. If submission encounters a network error, check task status before trying again.

## Health check failure

`/health` returning `503` typically indicates the database is unavailable. Check the database path, file permissions, disk space, and whether the SQLite file is located on a local persistent disk. Before recovery, preserve the failure state and verify backups.

## Data updated while editing outside the calendar

Another page, device, or operation changed the data between loading and submitting the form. Untouched forms synchronize automatically; edited drafts stay intact. Confirm overwrite on submission or cancel to continue editing, without automatically reloading the draft. Refresh the browser manually to view the latest content. Overwrite does not bypass deletion, completed approvals, permissions, unique names, or resource capacity rules. An uncertain outcome may mean the server already saved the change; the page will not replay it. Refresh manually to check.
