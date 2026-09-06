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

- Find machine and resource-group names, addresses, tags, and resource summaries; select a result to scroll to and highlight it.
- Switch between day and week views.
- Switch between group and machine reservation modes.
- Use 6-hour, 12-hour, or 24-hour timeline zoom levels.
- View maintenance periods, disabled resources, and existing reservations.

Anyone with machine access can see full reservation details for that machine in "Calendar", including the user's name and employee ID, title, purpose, notes, original time, and adjustment reasons. This does not grant edit access: regular users can still change only their own reservations.

Search is case-insensitive and supports multiple space-separated keywords. Names also support characters in order, so `atl01` matches `Atlas-01`; this is not typo correction. Only machines with resource groups that can be located in the current calendar appear. Use arrow keys to select a result, Enter to locate it, and Esc to close the results.

Click a machine row to collapse or expand its resource groups. Collapse preferences are saved per user in the current browser and survive reloads, but do not sync across devices.

Times display and accept input in the browser's local timezone by default. The Local/Beijing control beside the server clock switches to Beijing time (UTC+8). Outside UTC+8, the clock also shows a Beijing-time reference. Switching changes display and input conventions without moving stored reservations. Reloading restores local time.

## Live updates

The calendar refreshes for changes affecting the machines and dates covered by its query. Reservations on other machines or dates do not refresh the current calendar. While "Reservations" is open, changes to your own records update its lists and counts. Resource configuration, maintenance, and permission changes refresh the relevant views.

Switching to another browser tab keeps the connection open but pauses ordinary data refreshes. Returning synchronizes the page once. While disconnected, a visible page retries every 30 seconds and synchronizes again after reconnection. Background updates preserve reservation drafts; changed records must be checked again before submission. Revoked access or an invalid account immediately clears restricted content and revalidates the session.

## Creating a reservation

1. In "Calendar", select "Group" or "Machine".
2. Drag across one or more future time slots on the timeline.
3. Optionally fill in the title, purpose, and notes; all may be left blank.
4. Review the preview results and handle any conflicts or split time slots.
5. Submit.

Every slot in one submission must use the same scope: one or more resource groups, or the entire machine. The server checks permissions, time rules, and conflicts together. If any slot fails, none of them are saved.

Each reservation must follow the minimum duration, maximum duration, and booking window set by administrators.

## Editing reservations

Click your active or upcoming reservation in the calendar and choose Edit to add it to the editing sequence in the right drawer. Editing another unfinished reservation appends it to the same sequence without replacing your draft.

- Editing shares the creation interface: time drafts, title, purpose, notes, availability preview, and automatic splitting. The first reservation supplies the initial additional information; subsequent selections preserve your inputs. The information applies to every new time segment in the submission.
- Adjust or remove new drafts and add new time segments. Removing an original from the editing sequence keeps that original reservation; new drafts remain available for further adjustment.
- An editing sequence accepts up to 100 originals and a submission up to 100 new segments. Batch editing can combine whole-machine and resource-group reservations; ordinary creation still requires one scope.
- Originals remain unchanged until submission. One transaction ends active originals, cancels upcoming originals, and creates all new time segments. Originals that started less than 1 minute ago are cancelled instead of leaving a zero-length interval.
- If an original has ended, changed, been cancelled, or lost access, or a new segment conflicts, is unavailable, or fails to save, the entire submission rolls back. Changed sequences must be discarded and selected again.
- Discarding an edit does not release originals. If a network failure makes the result uncertain, check your latest records before submitting again.

## Ending and cancelling

Calendar details provide cancellation for upcoming reservations and early ending for active reservations. Ending a single reservation within its first minute removes that record. Ended and cancelled records cannot be changed.

Maintenance and resource availability changes may cancel, trim, or split affected reservations and notify their owners.

## Finding and locating your reservations

Choose Reservations beside the Calendar page title to see In progress, Not started, then Ended in one continuous list. Ended also includes cancelled records. Active records are ordered by end time ascending, upcoming records by start time ascending; both are shown in full without pagination. Ended/cancelled records are ordered by end or cancellation time descending, with 50 per page. When pagination is needed, the footer shows Page N / M; after a page loads, the list scrolls to the Ended heading.

Filter all sections by machine and resource group, including whole-machine reservations. Date filters are not available. Select a machine before filtering its resource groups; otherwise only All resource groups is available. Changing the machine resets the resource-group selection and returns history to page 1.

The calendar icon has the tooltip Locate in calendar. It first switches to the reservation's starting date, then scrolls to and highlights its resource group. The record is checked again before navigation. Cancelled reservations never offer this action. Records whose resources were deleted or are no longer accessible remain readable but cannot be located.

The finder shows machine, resource group or whole-machine scope, time, and status, without expandable details. Start time is above end time. Long machine and group names are truncated, with full text available on hover. Create, edit, and release reservations in the calendar. The standalone Reservations page and navigation entry have been removed. Legacy `/reservations` links redirect to the calendar and open the finder.

## Feedback and feature requests

Open Feedback from the user menu to submit an issue or feature request with a title, Markdown body, severity or urgency, and optional images. PNG, JPEG, and WebP are supported, with up to 5 images per body or comment, 5 MB per image, and 20 MB combined.

Regular users can view only their own tickets and images; system administrators handle them. Nonterminal tickets can be edited or withdrawn. Fixed, implemented, or rejected tickets cannot be edited or withdrawn by their owner, but still accept comments. Withdrawn tickets are entirely read-only and administrators cannot restore them. Replies and status changes appear as in-app notifications and unread feedback indicators.

## Email preferences

Under Profile → Email notifications, Schedule impact controls email about administrator releases, maintenance, disabling, or deletion that affects your reservations. Overdue reviews controls administrator review summaries. Required messages, such as verification codes, password recovery, and account disabling, are not controlled by these preferences.

An in-app notification does not imply an email. Ordinary creation, changes or releases you perform yourself, routine review results, and feedback updates normally use in-app notifications only. Email also requires enabled SMTP and an available address on the account.

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
