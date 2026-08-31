# Role-Based Interface Language

The interface should show only what users need for the task at hand. Precise technical terms still belong in database, concurrency, and audit contexts, but should not leak into everyday product copy.

## Role Information Boundaries

| Role or Scenario | Should Display | For Internal Use Only |
|---|---|---|
| Registration & Login | Username, name, employee ID, password requirements, and optional email & verification code if email is enabled | UUID, verification code challenge ID, identifier reservation rules |
| Registration Under Review | Review status, requested changes, current profile, and available actions | `applicationRevision`, session and token cleanup |
| Regular User | Current employee ID, profile review status, accessible machines, own reservations | Previous employee IDs, resource groups on inaccessible machines, connection details, admin notes, reservation batches and transactions |
| Machine Administrator | Authorized machines, resource configurations, resource groups, admin notes, members, access requests, and maintenance impact | Admin notes for other machines, unrelated profiles, and user IDs |
| System Administrator | Registration profiles, employee IDs, permissions, recent submission times, and action consequences | Concurrency version numbers and raw status enums within pages |
| Auditing & Logs | UUID, internal actions, original states, versions, and error context | No restrictions, but appears only in audit details, logs, or exports |

The timeline displays the reservation owner's name and current employee ID, not their permanent user ID. The permanent ID appears only as "Account ID" under "Profile" for troubleshooting.

## Recommended Terminology

| Internal Model or Legacy Term | Interface Term |
|---|---|
| reservation / 预约 / 资源申请 | reservation |
| reservation segment | a reservation, reservation period |
| batch / atomic commit | this submission |
| employee number | employee ID |
| initial employee number | employee ID |
| application revision | recent submission time; version number is not displayed |
| resource group version | Configuration Version N |
| utilization | resource utilization |
| resource pool | resource configuration, resource item |
| allocation | resource composition, allocated quantity |
| reserved minutes | reservation duration |

Use "request" for work that requires review, such as machine access or profile updates. Refer to account creation simply as "registration". Reports must state: Statistics are based on system-recorded reservation periods and do not represent actual hardware usage.

## Documentation Writing Conventions

- Page, menu, and module names use the exact interface text in quotation marks, e.g., "Profile", "Calendar", and "API tokens".
- Call machine membership "machine access". Reserve "permission" for roles, token access, and general authorization checks.
- Call scheduled resource time a "reservation"; do not use "预约" or "resource application".
- Call the public integration surface the "official API"; do not use "official AI API" or unexplained abbreviations such as `PAT`.
- Paths, HTTP methods, fields, enums, error codes, environment variables, and commands use inline code format, e.g., `POST`, `confirmationToken`, and `READ_WRITE`.
- Write technical quantities with numerals and natural English units, e.g., "5 minutes", "8 days", and "120 requests".
- Write replaceable example values as `<UPPER_SNAKE_CASE>`. Reuse a placeholder name only when it has the same meaning, and list it in "Documentation Placeholder Convention".
- Use this note for reports: "Statistics are based on system-recorded reservation periods and do not represent actual hardware utilization."

## Headings and Hints

- Page titles and module titles are responsible for naming only and do not repeatedly explain the page or module purpose.
- Page headers and module headers do not provide a subtitle slot; new pages should reuse the unified title component.
- Business pages do not stack multiple heading layers like English headers, Chinese titles, and Chinese descriptions.
- Information that can be directly understood from the title, field, or current content is not given additional hints.
- Necessary rules, permission scopes, and action consequences should be placed close to the corresponding fields, data, buttons, or confirmation steps.
- Status results, review reasons, error feedback, notification body text, and record metadata belong to the business body text and are not treated as subtitles.
- When removing title explanations, the title bar height, spacing, alignment, and empty states must be adjusted simultaneously; text nodes cannot simply be deleted.

## Prohibited Direct Display

The following content must not appear on ordinary business pages:

- Permanent user IDs and UUIDs (except "Account ID" under "Profile" and audit details)
- Raw enums like `PENDING`, `ACTIVE`, `DISABLED`
- Review versions, concurrency tokens, transactions, and atomic rescheduling details
- Reservation segments, batches, batch rollbacks, and configuration version numbers such as `vN`

Status text is centrally maintained in `src/ui-copy.ts`. When adding a new status, the Chinese mapping and tests must be added first; unknown statuses display "Status Unknown" or "Other System Operation" and must not fall back to displaying the raw enum.

## API Response Trimming

- `/api/v1/auth/me` does not return the registration approval version.
- `/api/v1/admin/users` retains `applicationRevision` as a frontend-hidden concurrency token while also returning `lastSubmittedAt` for page display.
- `/api/v1/users/directory` returns only the name, username, current employee ID, and account status of active users; it omits email, disable reasons, last login, user IDs, pending profile updates, and review details.
- `/api/v1/timeline` does not return the reserving user's ID or resource group configuration versions; it returns the name, current employee ID, whether it's the user themselves, and full reservation details to users with corresponding machine access.
- `/api/v1/machines/catalog` returns machine name, login IP, resource total summary, tags, administrator list, and the current user's permission status; device-type resources only show quantity, not device serial numbers, connection notes, resource groups, or management notes.
- `managementNotes` can only appear in management-side responses that have passed machine management permission checks; they do not enter ordinary machine catalogs, timelines, reports, exports, notifications, or audit body text.
- User rankings in machine statistics do not return user IDs, only name, current employee ID, and aggregated values.
- Reports and timelines read the current employee ID, so existing reservations show the new ID after a profile update is approved.

## Code Review Checklist

1. Does the new text describe a task the user can complete or the consequence of an operation?
2. Are regular users seeing information only administrators or developers need?
3. Have raw statuses been mapped through the centralized system?
4. Does the copy use "request" for review workflows and "registration" for account creation?
5. Is the API returning stable IDs, versions, or sensitive details not needed by the current role?
6. Does the title redundantly explain its own meaning? Are necessary hints already placed near their actual point of relevance?
