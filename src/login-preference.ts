export type LoginMethod = "USERNAME" | "EMPLOYEE_NUMBER";

export interface LoginPreference {
  method: LoginMethod;
  username?: string;
  employeeNumber?: string;
}

export interface LoginPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const LOGIN_PREFERENCE_KEY = "allocube.login-preference.v1";

const defaultPreference: LoginPreference = { method: "USERNAME" };

function browserStorage(): LoginPreferenceStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function normalizeUsername(value: string) {
  const username = value.trim().normalize("NFKC");
  return Array.from(username).length >= 2 && Array.from(username).length <= 32
    ? username
    : undefined;
}

function normalizeEmployeeNumber(value: string) {
  const employeeNumber = value.trim().toLowerCase();
  return /^(?:\d{8}|wx\d{6,7})$/.test(employeeNumber)
    ? employeeNumber
    : undefined;
}

export function parseLoginPreference(raw: string | null): LoginPreference {
  if (!raw) return { ...defaultPreference };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.method !== "USERNAME" &&
      value.method !== "EMPLOYEE_NUMBER"
    ) {
      return { ...defaultPreference };
    }
    if (
      ("username" in value &&
        (typeof value.username !== "string" ||
          !normalizeUsername(value.username))) ||
      ("employeeNumber" in value &&
        (typeof value.employeeNumber !== "string" ||
          !normalizeEmployeeNumber(value.employeeNumber)))
    ) {
      return { ...defaultPreference };
    }
    const username =
      typeof value.username === "string"
        ? normalizeUsername(value.username)
        : undefined;
    const employeeNumber =
      typeof value.employeeNumber === "string"
        ? normalizeEmployeeNumber(value.employeeNumber)
        : undefined;
    return {
      method: value.method,
      ...(username ? { username } : {}),
      ...(employeeNumber ? { employeeNumber } : {})
    };
  } catch {
    return { ...defaultPreference };
  }
}

export function readLoginPreference(
  storage: LoginPreferenceStorage | null = browserStorage()
): LoginPreference {
  if (!storage) return { ...defaultPreference };
  try {
    return parseLoginPreference(storage.getItem(LOGIN_PREFERENCE_KEY));
  } catch {
    return { ...defaultPreference };
  }
}

function writeLoginPreference(
  preference: LoginPreference,
  storage: LoginPreferenceStorage | null = browserStorage()
) {
  if (!storage) return;
  try {
    storage.setItem(LOGIN_PREFERENCE_KEY, JSON.stringify(preference));
  } catch {
    // Browser storage is an optional convenience. Login must still work without it.
  }
}

export function rememberLoginMethod(
  method: LoginMethod,
  storage: LoginPreferenceStorage | null = browserStorage()
) {
  const current = readLoginPreference(storage);
  writeLoginPreference({ ...current, method }, storage);
}

export function rememberSuccessfulLogin(
  method: LoginMethod,
  identifier: string,
  canonicalUsername?: string,
  storage: LoginPreferenceStorage | null = browserStorage()
) {
  const current = readLoginPreference(storage);
  if (method === "USERNAME") {
    const username = normalizeUsername(canonicalUsername ?? identifier);
    writeLoginPreference(
      {
        ...current,
        method,
        ...(username ? { username } : {})
      },
      storage
    );
    return;
  }
  const employeeNumber = normalizeEmployeeNumber(identifier);
  writeLoginPreference(
    {
      ...current,
      method,
      ...(employeeNumber ? { employeeNumber } : {})
    },
    storage
  );
}

export function rememberUsername(
  username: string,
  selectUsernameMethod: boolean,
  storage: LoginPreferenceStorage | null = browserStorage()
) {
  const current = readLoginPreference(storage);
  const normalized = normalizeUsername(username);
  writeLoginPreference(
    {
      ...current,
      ...(selectUsernameMethod ? { method: "USERNAME" as const } : {}),
      ...(normalized ? { username: normalized } : {})
    },
    storage
  );
}
