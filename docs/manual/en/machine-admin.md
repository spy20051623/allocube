# Machine administrator guide

Machine administrators are authorized per machine and can only manage the machines they are responsible for. System administrators can assign or remove machine administrators.

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

## Users and permissions

Machine administrators can:
- View machine members and pending machine access requests.
- Approve or reject requests for this machine.
- Invite users to become regular members.
- Remove regular members.

Only system administrators can grant or revoke machine administrator status. Before removing a member, the page will explain the impact on their reservations.

## Scheduling maintenance

Maintenance can be applied to the entire machine or specified resource groups, with start time, end time, and reason set. Before submission, affected reservations are previewed; based on the overlap, the system may:
- Cancel reservations that fall entirely within the maintenance window.
- Trim the start or end of a reservation.
- Split a reservation that spans the maintenance window into two segments.

Remaining segments shorter than the system's minimum reservation duration will be discarded. Canceling maintenance does not automatically restore previously canceled or adjusted reservations.

## Releasing reservations

Machine administrators can cancel future reservations on the machines they manage or end ongoing reservations early. A clear reason should be provided when performing this action; the reservation owner will be notified, and the operation will be recorded in the audit log.

The official API can only change reservations owned by the token's user, even when that user is a machine administrator.

## Statistics

Machine administrators can view registered reservation statistics for machines they have access to. Statistics are based on system-registered reservation periods and do not represent actual hardware utilization.
