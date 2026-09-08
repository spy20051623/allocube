import { FINAL_SCHEMA_SQL } from "../../server/schema";
export { FINAL_SCHEMA_VERSION } from "../../server/schema";

// Older migration fixtures derive their schemas from this pre-announcement baseline.
export const SCHEMA_V21_SQL = FINAL_SCHEMA_SQL.replace("    announcement TEXT NOT NULL DEFAULT '',\n", "");
