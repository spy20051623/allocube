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

## Statistics and export

Usage statistics can be filtered by time and machine and exported as CSV. Statistics are based on system-recorded reservation periods and do not represent actual hardware utilization.

## Audit logs

Audit logs preserve key management and reservation operations. Official API operations will display the corresponding personal access token and the source of the preflight operation; passwords, token plaintexts, and SMTP ciphertexts are not included in audit content.
