# Machine administrator guide

Machine administrators are authorized per machine and can only manage the machines they are responsible for. System administrators can assign or remove machine administrators.

## Access expiration

Access expires at 24:00 Beijing time on the selected date (00:00 on the following day), regardless of browser timezone or calendar display mode. Only the date is displayed and selected.

Both pending requests and members show an expiration column. Click a regular member's or pending request's expiration to change the deadline or select permanent access. Saving a request deadline does not approve it; use the existing approve button. Invitations default to 30 days and also support permanent access.

Extension requests use the same pending list, with an extension label and original and requested dates. Finite extensions must end after the original deadline and take effect only on approval, without shortening the current grant. Expiration of the original grant does not end the request; the requested deadline controls automatic rejection. Rejection or withdrawal preserves the original grant. Leaving or removing a member also closes their pending extension request.

Shortening access automatically cancels confirmed reservations starting at or after the deadline and truncates overlapping reservations, including ongoing ones. The save result reports both counts. Extending access does not restore reservations already changed.

Pending requests are automatically rejected at their deadline and the applicant is notified. They remain in review history and cannot be edited or approved afterward. Expired members retain their records and can reapply; if a pending request exists, restore access through that request's approval.

Machine administrators always have permanent access, which cannot be edited. Promotion automatically removes a regular member's expiration; demotion retains permanent access until an administrator changes it. Existing member access remains permanent after the upgrade.

## Permission boundaries

Machine administrators can open "Admin", but only see machines they can access. They can edit only the machines they administer.

Machine administrators cannot:
- Create or permanently delete machines.
- Review system account registrations or disable/delete users.
- Assign other machine administrators.
- Modify system settings or view system audit logs.

## Machine information

Select a machine under "Admin → Resources" to view its overview, resources, and access list. Machine administrators can edit connection instructions, hardware notes, and tags, but not the machine name. System administrators retain machine-wide controls.

## Resource settings

The resource model supports:
- **Number Ranges**: e.g., logical cores `0–127`.
- **Discrete Devices**: e.g., GPU 0, GPU 1.
- **Divisible Capacity**: e.g., 512 GiB memory.

Resource groups can combine several allocations. On save, Allocube checks ranges, duplicate devices, capacity limits, and conflicts between groups. Every saved configuration creates a revision; existing reservations keep the resource snapshot captured when they were created.

Review the impact shown on the page before making a destructive change. Renaming a resource is not a substitute for disabling it or scheduling maintenance.

Untouched machine and resource editors synchronize other administrators' changes. Edited forms retain drafts and ask for overwrite confirmation only when a stale version is submitted; cancelling keeps the input. Resource configuration overwrites retain remotely added pools and groups absent from the draft and recheck the complete allocation, capacity, and naming constraints. If a maintenance or disable preview is stale, confirmation applies the operation to the latest affected reservations. When the network outcome is uncertain, refresh manually to check rather than submitting again.

## Users and permissions

Machine administrators can:
- View machine members and pending machine access requests.
- Approve or reject requests for this machine.
- Invite users to become regular members.
- Remove regular members.

Only system administrators can grant or revoke machine administrator status. Before removing a member, the page will explain the impact on their reservations.

Machine-access review emails use overdue summaries rather than immediate mail for every request. Pending requests older than 15 minutes are checked every 30 minutes, with one reminder per request version per administrator. Bind an email address and enable Overdue reviews under Profile → Email notifications.

## Scheduling maintenance

Maintenance can be applied to the entire machine or specified resource groups, with start time, end time, and reason set. Before submission, affected reservations are previewed; based on the overlap, the system may:
- Cancel reservations that fall entirely within the maintenance window.
- Trim the start or end of a reservation.
- Split a reservation that spans the maintenance window into two segments.

Canceling maintenance does not automatically restore previously canceled or adjusted reservations.

## Releasing reservations

Machine administrators can cancel future reservations on the machines they manage or end ongoing reservations early. A clear reason should be provided when performing this action; the reservation owner will be notified, and the operation will be recorded in the audit log.

The official API can only change reservations owned by the token's user, even when that user is a machine administrator.

## Statistics

Machine administrators can view registered reservation statistics for machines they have access to. Statistics are based on system-registered reservation periods and do not represent actual hardware utilization.

The calendar shows the Beijing expiration date only for finite access. Gray hatching marks time beyond the deadline. Dragging across it keeps only authorized time; manual entry reports an error for times beyond the deadline. Permanent access has no expiration label.
