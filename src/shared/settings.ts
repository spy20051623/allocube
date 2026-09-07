

export type SmtpSettingsPayload = {
  enabled: boolean;
  host: string;
  port: number;
  security: "IMPLICIT_TLS" | "STARTTLS";
  username: string;
  fromName: string;
  fromAddress: string;
  hasPassword: boolean;
  passwordStatus: "NOT_SET" | "READY" | "UNREADABLE";
  testable: boolean;
  operational: boolean;
  version: number;
  updatedAt: string;
  lastTest: {
    status: "SUCCESS" | "FAILED";
    error: string;
    testedAt: string | null;
  } | null;
  queue: {
    pending: number;
    failed: number;
    lastError: string;
  };
};

export type RegistrationConfigPayload = {
  emailEnabled: boolean;
  allowRegistrationWithoutEmail: boolean;
  allowedEmailDomains: string[];
  revision: number;
};

export type AdminSettingsPayload = {
  minBookingMinutes: number;
  maxBookingMinutes: number;
  advanceDays: number;
  timezone: string;
  allowedEmailDomains: string[];
  allowRegistrationWithoutEmail: boolean;
  siteOrigin: string;
  icpFilingNumber: string;
  publicSecurityFilingNumber: string;
  version: number;
};

export type PublicSiteConfigPayload = {
  icpFilingNumber: string;
  publicSecurityFilingNumber: string;
};
