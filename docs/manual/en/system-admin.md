# System administrator guide

The system administrator is responsible for accounts, machines, global rules, email, statistics, and auditing.

## User management

The system administrator can:

-   Approve, return, or reject registrations.
-   Review profile update requests for names and employee IDs.
-   Disable, re-enable, or permanently delete users.
-   Generate one-time password reset links for enabled users.
-   View account status, machine relationships, and recent login information.

Disabling a user revokes their sessions, personal access tokens, and pending API operations within the same transaction. Review the impact preview before permanent deletion; essential history such as reservations and audit logs will be preserved and displayed with de-identified names.

## Machines and resources

The system administrator can create, modify, disable, re-enable, and permanently delete machines, and configure machine administrators.

Resource items and resource groups support ordering, versioning, and historical snapshots. Review the impact preview before disabling or deleting; historical reservations will not lose necessary snapshot information due to resource deletion.

## Machine access and machine administrators

-   Machine access determines whether a user can view and reserve machine resources.
-   The machine administrator role is attached to a user's machine access.
-   Only system administrators can grant or revoke the machine administrator role.
-   When a user leaves or loses machine access, they cannot retain the administrator role for that machine.

## Disabling resources and scheduling maintenance

Use maintenance for a known time window and disable a resource when it should remain unavailable until further notice. Both actions preview and update affected reservations:

-   Maintenance has a defined time window.
-   A disabled resource remains unavailable until an administrator re-enables it.
-   Permanent deletion is used when an object is confirmed to be no longer needed and cannot be recovered.

## Settings

"Admin → Settings" includes:

-   Minimum and maximum reservation duration, plus the booking window in days.
-   Site address, used for view and password reset links in emails.
-   Whether registration allows leaving the email field blank, and the allowed email domains for registration.
-   SMTP server, port, security mode, account, password, and sender.

Modifying global rules does not automatically rewrite existing reservations. The site address must be a complete HTTP or HTTPS origin, and must not contain business paths, query parameters, or fragments.

ICP and public-security filing numbers can also be configured in System settings. Valid values appear in the footer of authentication pages with links to their lookup pages; empty values are hidden.

Settings synchronize changes from other pages or devices when there is no unsaved input. Drafts are retained while editing. If settings have changed when you submit, confirmation is required to overwrite the corresponding settings; cancelling returns to the draft. Refresh the browser manually to see the latest settings; refreshing discards unsaved input. Saves with an uncertain network outcome are not replayed automatically. Refresh manually to check the result.


Outside the calendar, machine details, resource configuration, announcements, and feedback use the same conflict handling: untouched forms synchronize, edited forms retain drafts, and stale submissions require overwrite confirmation. Confirmation applies the submitted data while preserving authorization, field, capacity, and workflow checks. Deleted objects, processed applications, and read-only feedback cannot be forced through. Approvals, enable/disable actions, and maintenance also require confirmation when their version or affected reservations have changed.

## System announcements

Announcements display important messages to everyone who can log in. Under "Admin → Announcements", you can create, edit, preview, publish, and unpublish them. The default list shows published announcements; enable "Show archived" to view and republish older ones.

Announcement titles have a maximum of 120 characters, and the body has a maximum of 10,000 characters. The body supports common Markdown, including paragraphs, lists, blockquotes, tables, code, and links; raw HTML and images will not be rendered.

Links must use the standard Markdown syntax:

```markdown
[View external documentation](https://example.org/help)
[View calendar](allocube:/calendar)
```

-   `https://` or `http://` indicates an external link, which opens in a new window.
-   `allocube:` indicates an internal navigation link. What follows must be an absolute path to a known Allocube page, such as `allocube:/calendar`, `allocube:/profile`, or `allocube:/docs/api`.
-   `javascript:`, unknown internal paths, and other protocols will not generate clickable links.

Published announcements appear in publication order. Editing or republishing one creates a new version and updates its publication time, so users who saw the old version will see the new one. A browser remembers each dismissed version for that user, but this state does not sync across devices. Unpublishing an announcement hides it immediately without deleting it or its audit history.

## Handling feedback

Under Admin → Feedback, view issues and feature requests across the system, filter by type, status, or level, reply, change severity or urgency, and update status with a processing note. Issues use Confirmed/Fixed, while requests use Adopted/Implemented; both can be rejected. Processing activity and audit records are retained. Withdrawn tickets are entirely read-only and cannot be reopened. Being a machine administrator does not grant system-wide feedback management access.

## Email sending

Once SMTP is enabled, registration verification codes, password resets, and event notifications enter a persistent outbox. Failed tasks are retried, and the management page displays the queue, recent errors, and test results.

New registrations, profile changes, and machine-access requests no longer generate an immediate administrator email for every submission. Allocube checks on startup and then at 30-minute boundaries. Requests still pending after more than 15 minutes are combined into one summary per administrator; each administrator is reminded only once per request version. System administrators receive relevant system-wide reviews, and machine administrators receive access reviews for their machines. Recipients need an available email address and Overdue reviews enabled.

Verification, password recovery, and account-blocking messages remain required email. Reservation-impact mail follows the user's Schedule impact preference. Ordinary feedback updates and routine business notifications stay in-app.

The SMTP password is encrypted and saved using the instance secret key; the page and API will not echo the plaintext. If `instance-secrets.json` is replaced or lost, the SMTP password must be re-entered.

## Usage statistics

Usage statistics settle the previous calendar day at 06:00 Beijing time each day. The page reads stored results rather than recalculating live reservations. These figures describe recorded reservation periods, not actual hardware utilization.

Date filters always use Beijing time and include both the start and end dates. The default is the latest seven days due for settlement. Before 06:00 the latest due date is two days ago, and after 06:00 it is yesterday. Today is excluded, regardless of the calendar timezone setting. Changes to dates or the machine filter take effect only after selecting Refresh, which reads saved results.

Reservations spanning midnight contribute their overlapping duration to each day. Multi-day reservation counts deduplicate reservation IDs. Whole-machine reservations contribute to each relevant resource group but count only once toward a user's duration. Utilization uses aggregate durations rather than averaging daily percentages.

The first upgrade backfills all existing history in the background, newest dates first. Queries aggregate stored results within the selected range. Dates without results contribute zero and do not produce pending-date notices; an entirely empty range displays zero. Backfill uses current records and cannot reconstruct deleted or changed historical configurations.

System administrators can select **Recalculate all** at the top right of the page. After confirmation, it recalculates every machine and historical date regardless of filters. Closing the page does not cancel the task. Previous results remain readable until the entire new version is ready; a failed task preserves the previous results. Progress is displayed, and repeated submissions reuse the current task. Ordinary users and machine administrators cannot trigger this operation.

Routine reservation changes do not revise settled figures. A system administrator must request a full recalculation to update history. Queries still enforce current machine permissions and anonymize deleted users and resources.

## Audit logs

Only system administrators can access audit logs. Filter by operation date, actor, action, and source, then select **Query** to apply the filters. **Reset** clears the filters and runs a new query. Dates use the current timezone mode and include both boundary dates; they refer to when the operation occurred.

Records appear newest first, with 50 records per page and access to all retained history. Pagination keeps the same record boundary, including when returning to the first page. Run a new query to include newly recorded operations. The page does not poll automatically. Failed requests retain the displayed records and offer Retry.

Select a record to open read-only details with complete identifiers, recorded changes, reasons, and related identifiers. Reservation objects show the machine, resource group or whole-machine scope, and intervals present in the historical payload when available. Names come from current profiles; missing historical values are never filled using current business values. Batch operations remain separate records.

The **Personal API** source is identified by an existing token or API operation identifier. Details show the available token name and operation identifier. Other sources are labeled **Other**, without assuming that old records originated from the website. Passwords, plaintext tokens, SMTP ciphertext, and management-note contents are not exposed by the audit page. Deleted users and resources remain anonymized, and related details may be hidden. Missing or unreadable historical content does not prevent other records from loading.
