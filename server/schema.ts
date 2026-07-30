export const FINAL_SCHEMA_VERSION = 13;

export const FINAL_SCHEMA_SQL = `
  CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    username_normalized TEXT NOT NULL UNIQUE,
    email TEXT COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('SYSTEM_ADMIN', 'USER')),
    status TEXT NOT NULL CHECK(status IN ('PENDING_APPROVAL', 'CHANGES_REQUESTED', 'ACTIVE', 'DISABLED')),
    version INTEGER NOT NULL DEFAULT 1,
    disabled_at TEXT,
    disabled_by TEXT REFERENCES users(id),
    disable_reason TEXT NOT NULL DEFAULT '',
    password_change_recommended INTEGER NOT NULL DEFAULT 0,
    username_changed_at TEXT,
    last_login_at TEXT,
    last_login_ip TEXT NOT NULL DEFAULT '',
    auto_logout_minutes INTEGER NOT NULL DEFAULT 60
      CHECK(auto_logout_minutes IN (0, 15, 60, 240, 1440)),
    application_revision INTEGER NOT NULL DEFAULT 1,
    approved_at TEXT,
    approved_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  CREATE INDEX sessions_user_idx ON sessions(user_id);
  CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

  CREATE TABLE auth_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK(kind = 'PASSWORD_RESET'),
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE email_verification_challenges (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    purpose TEXT NOT NULL CHECK(purpose IN ('REGISTER', 'EMAIL_CHANGE')),
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    last_sent_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX email_challenge_lookup_idx
    ON email_verification_challenges(email, purpose, created_at DESC);

  CREATE TABLE username_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    username_normalized TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX username_history_user_idx ON username_history(user_id, created_at DESC);

  CREATE TABLE email_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX email_history_user_idx ON email_history(user_id, created_at DESC);

  CREATE TABLE employee_numbers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    employee_number TEXT NOT NULL COLLATE NOCASE UNIQUE,
    status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'INACTIVE')),
    assigned_by TEXT REFERENCES users(id),
    assigned_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX employee_numbers_user_idx ON employee_numbers(user_id, status);
  CREATE UNIQUE INDEX employee_numbers_single_active_user_idx
    ON employee_numbers(user_id) WHERE status = 'ACTIVE';

  CREATE TABLE pending_registration_employee_numbers (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    employee_number TEXT NOT NULL COLLATE NOCASE UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE registration_revisions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL,
    email TEXT,
    employee_number TEXT NOT NULL,
    submitted_at TEXT NOT NULL,
    UNIQUE(user_id, revision)
  );

  CREATE TABLE registration_tombstones (
    user_id TEXT PRIMARY KEY,
    reason_code TEXT NOT NULL DEFAULT '',
    actor_user_id TEXT,
    registered_at TEXT NOT NULL,
    terminated_at TEXT NOT NULL
  );

  CREATE TABLE deleted_user_tombstones (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    deleted_at TEXT NOT NULL,
    deleted_by TEXT REFERENCES users(id),
    cleanup_counts_json TEXT NOT NULL
  );

  CREATE TABLE profile_change_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    current_display_name TEXT NOT NULL,
    current_employee_number TEXT NOT NULL COLLATE NOCASE,
    requested_display_name TEXT NOT NULL,
    requested_employee_number TEXT NOT NULL COLLATE NOCASE,
    status TEXT NOT NULL DEFAULT 'PENDING'
      CHECK(status IN ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELLED')),
    version INTEGER NOT NULL DEFAULT 1,
    reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    review_reason TEXT NOT NULL DEFAULT '',
    reviewed_at TEXT,
    requested_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX profile_change_pending_user_idx
    ON profile_change_requests(user_id) WHERE status = 'PENDING';
  CREATE UNIQUE INDEX profile_change_pending_employee_idx
    ON profile_change_requests(requested_employee_number) WHERE status = 'PENDING';
  CREATE INDEX profile_change_review_idx
    ON profile_change_requests(status, requested_at DESC);

  CREATE TABLE machines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    address TEXT NOT NULL DEFAULT '',
    hardware_notes TEXT NOT NULL DEFAULT '',
    connection_guide TEXT NOT NULL DEFAULT '',
    management_notes TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'DISABLED')),
    disabled_at TEXT,
    disabled_by TEXT REFERENCES users(id),
    disable_reason TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE deleted_machine_tombstones (
    machine_id TEXT PRIMARY KEY REFERENCES machines(id),
    deleted_at TEXT NOT NULL,
    deleted_by TEXT REFERENCES users(id),
    cleanup_counts_json TEXT NOT NULL
  );

  CREATE TABLE machine_admins (
    machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY(machine_id, user_id)
  );
  CREATE INDEX machine_admins_user_idx ON machine_admins(user_id);

  CREATE TABLE machine_access_memberships (
    id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK(source IN ('APPLICATION', 'ADMIN_INVITE', 'SEED')),
    granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(machine_id, user_id)
  );
  CREATE INDEX machine_access_memberships_user_idx
    ON machine_access_memberships(user_id, machine_id);

  CREATE TABLE machine_access_requests (
    id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'PENDING'
      CHECK(status IN ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
    version INTEGER NOT NULL DEFAULT 1,
    reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    review_reason TEXT NOT NULL DEFAULT '',
    reviewed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX machine_access_requests_pending_idx
    ON machine_access_requests(machine_id, user_id) WHERE status = 'PENDING';
  CREATE INDEX machine_access_requests_machine_idx
    ON machine_access_requests(machine_id, status, created_at DESC);
  CREATE INDEX machine_access_requests_user_idx
    ON machine_access_requests(user_id, status, created_at DESC);

  CREATE TABLE resource_pools (
    id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    kind TEXT NOT NULL CHECK(kind IN ('INDEX_RANGE', 'ITEM_LIST', 'CAPACITY')),
    sharing_mode TEXT NOT NULL DEFAULT 'EXCLUSIVE'
      CHECK(sharing_mode IN ('EXCLUSIVE', 'SHARED')),
    unit TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    range_start INTEGER,
    range_end INTEGER,
    capacity_milli INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(machine_id, name),
    CHECK(
      (kind = 'INDEX_RANGE' AND range_start IS NOT NULL AND range_end >= range_start AND capacity_milli IS NULL)
      OR (kind = 'ITEM_LIST' AND range_start IS NULL AND range_end IS NULL AND capacity_milli IS NULL)
      OR (kind = 'CAPACITY' AND range_start IS NULL AND range_end IS NULL AND capacity_milli > 0)
    )
  );

  CREATE TABLE deleted_resource_pool_tombstones (
    resource_pool_id TEXT PRIMARY KEY REFERENCES resource_pools(id),
    machine_id TEXT NOT NULL REFERENCES machines(id),
    deleted_at TEXT NOT NULL,
    deleted_by TEXT REFERENCES users(id)
  );
  CREATE INDEX resource_pools_machine_idx
    ON resource_pools(machine_id, sort_order);

  CREATE TABLE resource_pool_items (
    id TEXT PRIMARY KEY,
    pool_id TEXT NOT NULL REFERENCES resource_pools(id) ON DELETE CASCADE,
    item_key TEXT NOT NULL COLLATE NOCASE,
    label TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(pool_id, item_key)
  );
  CREATE INDEX resource_pool_items_pool_idx
    ON resource_pool_items(pool_id, sort_order);

  CREATE TABLE resource_pool_revisions (
    id TEXT PRIMARY KEY,
    resource_pool_id TEXT NOT NULL REFERENCES resource_pools(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    configuration_json TEXT NOT NULL,
    changed_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    UNIQUE(resource_pool_id, version)
  );

  CREATE TABLE resource_groups (
    id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'DISABLED')),
    disabled_at TEXT,
    disabled_by TEXT REFERENCES users(id),
    disable_reason TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(machine_id, name)
  );

  CREATE TABLE deleted_resource_group_tombstones (
    resource_group_id TEXT PRIMARY KEY REFERENCES resource_groups(id),
    machine_id TEXT NOT NULL REFERENCES machines(id),
    deleted_at TEXT NOT NULL,
    deleted_by TEXT REFERENCES users(id),
    cleanup_counts_json TEXT NOT NULL
  );
  CREATE INDEX resource_groups_machine_idx
    ON resource_groups(machine_id, sort_order);

  CREATE TABLE resource_group_allocations (
    id TEXT PRIMARY KEY,
    resource_group_id TEXT NOT NULL REFERENCES resource_groups(id) ON DELETE CASCADE,
    resource_pool_id TEXT NOT NULL REFERENCES resource_pools(id),
    kind TEXT NOT NULL CHECK(kind IN ('INDEX_RANGE', 'ITEM_LIST', 'CAPACITY')),
    quantity_milli INTEGER,
    UNIQUE(resource_group_id, resource_pool_id)
  );
  CREATE INDEX resource_group_allocations_pool_idx
    ON resource_group_allocations(resource_pool_id);

  CREATE TABLE resource_group_allocation_ranges (
    id TEXT PRIMARY KEY,
    allocation_id TEXT NOT NULL REFERENCES resource_group_allocations(id) ON DELETE CASCADE,
    range_start INTEGER NOT NULL,
    range_end INTEGER NOT NULL CHECK(range_end >= range_start),
    label TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX resource_group_ranges_allocation_idx
    ON resource_group_allocation_ranges(allocation_id, range_start);

  CREATE TABLE resource_group_allocation_items (
    allocation_id TEXT NOT NULL REFERENCES resource_group_allocations(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES resource_pool_items(id),
    PRIMARY KEY(allocation_id, item_id)
  );
  CREATE INDEX resource_group_items_item_idx
    ON resource_group_allocation_items(item_id);

  CREATE TABLE resource_group_revisions (
    id TEXT PRIMARY KEY,
    resource_group_id TEXT NOT NULL REFERENCES resource_groups(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    configuration_json TEXT NOT NULL,
    changed_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    UNIQUE(resource_group_id, version)
  );

  CREATE TABLE reservation_batches (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );

  CREATE TABLE resource_unavailability (
    id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    resource_group_id TEXT REFERENCES resource_groups(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('PLANNED', 'LONG_TERM')),
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'CANCELLED')),
    created_by TEXT NOT NULL REFERENCES users(id),
    cancelled_by TEXT REFERENCES users(id),
    cancelled_at TEXT,
    created_at TEXT NOT NULL,
    CHECK(end_at > start_at)
  );
  CREATE INDEX resource_unavailability_machine_time_idx
    ON resource_unavailability(machine_id, start_at, end_at, status);
  CREATE INDEX resource_unavailability_group_time_idx
    ON resource_unavailability(resource_group_id, start_at, end_at, status);

  CREATE TABLE reservations (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES reservation_batches(id),
    scope TEXT NOT NULL DEFAULT 'RESOURCE_GROUP'
      CHECK(scope IN ('RESOURCE_GROUP', 'MACHINE')),
    resource_group_id TEXT NOT NULL REFERENCES resource_groups(id) ON DELETE CASCADE,
    machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    initial_start_at TEXT NOT NULL,
    initial_end_at TEXT NOT NULL,
    parent_reservation_id TEXT REFERENCES reservations(id) ON DELETE SET NULL,
    adjusted_by_unavailability_id TEXT REFERENCES resource_unavailability(id) ON DELETE SET NULL,
    adjustment_type TEXT,
    adjustment_reason TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    purpose TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'CONFIRMED'
      CHECK(status IN ('CONFIRMED', 'CANCELLED', 'CANCELLED_UNAVAILABILITY')),
    snapshot_group_name TEXT NOT NULL,
    snapshot_resource_config_json TEXT NOT NULL,
    snapshot_group_version INTEGER NOT NULL,
    cancelled_at TEXT,
    cancelled_by TEXT REFERENCES users(id),
    cancellation_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX reservations_group_time_idx
    ON reservations(resource_group_id, start_at, end_at, status);
  CREATE INDEX reservations_machine_time_idx
    ON reservations(machine_id, start_at, end_at, status);
  CREATE INDEX reservations_user_idx ON reservations(user_id, start_at);

  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    link TEXT NOT NULL DEFAULT '',
    read_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);

  CREATE TABLE user_email_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    reservation_updates INTEGER NOT NULL DEFAULT 1
      CHECK(reservation_updates IN (0, 1)),
    machine_access_updates INTEGER NOT NULL DEFAULT 1
      CHECK(machine_access_updates IN (0, 1)),
    approval_updates INTEGER NOT NULL DEFAULT 1
      CHECK(approval_updates IN (0, 1)),
    administration_updates INTEGER NOT NULL DEFAULT 1
      CHECK(administration_updates IN (0, 1)),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE email_outbox (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    to_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    html TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING'
      CHECK(status IN ('PENDING', 'SENT', 'FAILED', 'CANCELLED', 'EXPIRED')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT NOT NULL DEFAULT '',
    expires_at TEXT,
    sent_at TEXT,
    cancelled_at TEXT,
    cancellation_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX email_outbox_pending_idx ON email_outbox(status, next_attempt_at);

  CREATE TABLE smtp_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    host TEXT NOT NULL DEFAULT '',
    port INTEGER NOT NULL DEFAULT 465 CHECK(port BETWEEN 1 AND 65535),
    security TEXT NOT NULL DEFAULT 'IMPLICIT_TLS'
      CHECK(security IN ('IMPLICIT_TLS', 'STARTTLS')),
    username TEXT NOT NULL DEFAULT '',
    password_encrypted TEXT,
    from_name TEXT NOT NULL DEFAULT 'Allocube',
    from_address TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    last_test_status TEXT CHECK(last_test_status IN ('SUCCESS', 'FAILED')),
    last_test_error TEXT NOT NULL DEFAULT '',
    last_tested_at TEXT,
    last_tested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE audit_logs (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX audit_created_idx ON audit_logs(created_at DESC);

  CREATE TABLE app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;
