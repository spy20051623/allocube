import { db } from "./db.js";
export {
  decryptSmtpPassword,
  encryptSmtpPassword
} from "./smtp-crypto.js";
import { decryptSmtpPassword } from "./smtp-crypto.js";

export type SmtpSecurity = "IMPLICIT_TLS" | "STARTTLS";

export type SmtpSettingsRow = {
  enabled: number;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password_encrypted: string | null;
  from_name: string;
  from_address: string;
  version: number;
  last_test_status: "SUCCESS" | "FAILED" | null;
  last_test_error: string;
  last_tested_at: string | null;
  updated_at: string;
};

export type RuntimeSmtpSettings = {
  version: number;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
  fromName: string;
  fromAddress: string;
};

export function getSmtpSettingsRow() {
  return db
    .prepare(
      `SELECT enabled, host, port, security, username, password_encrypted,
              from_name, from_address, version, last_test_status,
              last_test_error, last_tested_at, updated_at
       FROM smtp_settings WHERE id = 1`
    )
    .get() as SmtpSettingsRow;
}

function smtpConnectionSettings(
  row: SmtpSettingsRow
): RuntimeSmtpSettings | null {
  if (
    !row.host ||
    !row.username ||
    !row.from_address ||
    !row.password_encrypted
  ) {
    return null;
  }
  try {
    return {
      version: row.version,
      host: row.host,
      port: row.port,
      security: row.security,
      username: row.username,
      password: decryptSmtpPassword(row.password_encrypted),
      fromName: row.from_name,
      fromAddress: row.from_address
    };
  } catch {
    return null;
  }
}

export function getSavedSmtpSettings(): RuntimeSmtpSettings | null {
  return smtpConnectionSettings(getSmtpSettingsRow());
}

export function getRuntimeSmtpSettings(): RuntimeSmtpSettings | null {
  const row = getSmtpSettingsRow();
  return row.enabled ? smtpConnectionSettings(row) : null;
}

export function isMailServiceAvailable() {
  return getRuntimeSmtpSettings() !== null;
}
