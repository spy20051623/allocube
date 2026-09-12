import { TERMINAL_HELP_SCHEMA_SQL } from "../../server/terminal-help-schema";
import { SSH_KEY_SCHEMA_SQL, SSH_KEY_ACTIVATION_SCHEMA_SQL } from "../../server/ssh-key-schema";
import { FINAL_SCHEMA_SQL } from "../../server/schema";
import { TERMINAL_SCHEMA_SQL } from "../../server/terminal-schema";
export { FINAL_SCHEMA_VERSION } from "../../server/schema";

// Older migration fixtures derive their schemas from this pre-announcement baseline.
export const SCHEMA_V21_SQL = FINAL_SCHEMA_SQL.replace(TERMINAL_HELP_SCHEMA_SQL, "").replace(SSH_KEY_ACTIVATION_SCHEMA_SQL, "").replace(SSH_KEY_SCHEMA_SQL, "").replace(TERMINAL_SCHEMA_SQL, "")
  .replace("'REGISTER', 'EMAIL_CHANGE', 'EMAIL_OLD', 'TERMINAL', 'SSH_KEY'", "'REGISTER', 'EMAIL_CHANGE'")
  .replace("    announcement TEXT NOT NULL DEFAULT '',\n", "");
