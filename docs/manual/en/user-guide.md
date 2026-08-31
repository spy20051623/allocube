# User guide

Regular users can apply for machine access, view resource scheduling, and manage their own reservations.

## Applying for machine access

1. Open "Resources".
2. Locate the target machine and view its resource summary, maintenance status, and administrator information.
3. Select "Request access" and add a reason if helpful.
4. Wait for a machine or system administrator to review the request.

Once approved, the machine appears in "Calendar" and under "Admin → Resources". If you leave a machine, you lose access and the system releases your current and upcoming reservations as described in the confirmation message.

## Browsing the schedule

"Calendar" lets you:

- Filter by machine name, resource group name, or tags.
- Switch between day and week views.
- Switch between group and machine reservation modes.
- Use 6-hour, 12-hour, or 24-hour timeline zoom levels.
- View maintenance periods, disabled resources, and existing reservations.

Anyone with machine access can see full reservation details for that machine in "Calendar", including the user's name and employee ID, title, purpose, notes, original time, and adjustment reasons. This does not grant edit access: regular users can still change only their own reservations.

## Creating a reservation

1. In "Calendar", select "Group" or "Machine".
2. Drag across one or more future time slots on the timeline.
3. Fill in the title, purpose, and notes.
4. Review the preview results and handle any conflicts or split time slots.
5. Submit.

Every slot in one submission must use the same scope: one or more resource groups, or the entire machine. The server checks permissions, time rules, and conflicts together. If any slot fails, none of them are saved.

Each reservation must follow the minimum duration, maximum duration, and booking window set by administrators.

## Editing a reservation

Open your own reservation from "My Reservations" or the calendar details:

- You can change the time, title, purpose, and notes of a future reservation.
- You cannot change its resource group or scope. Cancel it and create a new reservation instead.
- You cannot change the start time of an ongoing reservation.
- Ended or canceled reservations cannot be edited.

The editing process first creates a draft on the page; the server record is not changed until final submission. If the new time slot conflicts, the original reservation remains unchanged.

## Cancelling or ending early

- Your own future reservations can be cancelled.
- Your own ongoing reservations can be ended early.
- Ended reservations cannot be cancelled.

When a machine administrator schedules maintenance, disables a resource, or releases a reservation, the system may cancel, trim, or split related time slots and will notify users of the outcome.

## My reservations

"Reservations" includes upcoming, ongoing, ended, and canceled records. Open a record for details, or return to the calendar to edit it when allowed.

## API tokens

API tokens are managed under "Profile → API tokens". They are for the official API, not web login. Creating one requires your current password; you can choose read-only or read-write access and an expiration period.

- The plaintext token is displayed only once and should not be written to web pages, local storage, logs, or code repositories.
- Password changes and resets do not revoke tokens.
- Tokens become invalid immediately if the account is disabled, deleted, or the token is actively revoked.
- Tokens no longer in use should be revoked promptly.

For full integration methods, see the [Official API](/docs/api).

## System announcements

System administrators can publish site-wide announcements. When you open Allocube, unread announcements appear one at a time.

- After closing an announcement, that version will not be shown again in the current browser; if an administrator edits or re-enables it, the new version will be shown again.
- The read status is only saved locally in the browser and is not synced to other browsers, other devices, or incognito windows.
- After clearing site data, announcements may be shown again.
- Once an administrator unpublishes an announcement, it is no longer shown.

Announcements can contain links to external web pages and internal site pages. Before opening a link, please verify that the link text and destination match your expectations.

After closing the pop-up, open "Announcements" from the user menu to view published announcements. Regular users cannot see unpublished announcements or manage them.
