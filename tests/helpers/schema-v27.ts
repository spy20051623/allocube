import { FINAL_SCHEMA_SQL } from "../../server/schema";
import { TERMINAL_CONFIRMATION_MIGRATION_SQL, TERMINAL_CHALLENGE_MIGRATION_SQL } from "../../server/terminal-schema";
import { MACHINE_ACCESS_EXPIRY_INDEX_SQL } from "../../server/machine-access-schema";

export const SCHEMA_V27_SQL = FINAL_SCHEMA_SQL.replace(TERMINAL_CHALLENGE_MIGRATION_SQL, "").replace(TERMINAL_CONFIRMATION_MIGRATION_SQL, "").replace("    previous_expires_at TEXT,\n", "").replace(MACHINE_ACCESS_EXPIRY_INDEX_SQL, "")
  .replace(/(CREATE TABLE machine_access_memberships \([\s\S]*?)    expires_at TEXT,\n    version INTEGER NOT NULL DEFAULT 1,\n/, "$1")
  .replace(/(CREATE TABLE machine_access_requests \([\s\S]*?)    expires_at TEXT,\n/, "$1");
