export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 64;

export const EMPLOYEE_NUMBER_MESSAGE = "请输入合法工号";

const employeeNumberPattern = /^(?:\d{8}|wx\d{6,7})$/;
const printableAsciiPattern = /^[\x21-\x7e]+$/;
const asciiLetterPattern = /[A-Za-z]/;
const asciiDigitPattern = /\d/;

const commonPasswords = new Set([
  "password1",
  "password123",
  "qwerty123",
  "admin123",
  "administrator1",
  "welcome1",
  "abc12345",
  "letmein1",
  "changeme1",
  "iloveyou1"
]);

export type PasswordCheckKey =
  | "format"
  | "letter"
  | "digit"
  | "safeIdentity";

export interface PasswordCheck {
  key: PasswordCheckKey;
  label: string;
  met: boolean | null;
}

export interface PasswordContext {
  username?: string;
  employeeNumbers?: string[];
}

export function normalizeEmployeeNumberValue(value: string) {
  return value.trim().toLowerCase();
}

export function isEmployeeNumberValid(value: string) {
  return employeeNumberPattern.test(normalizeEmployeeNumberValue(value));
}

function normalizeIdentifierForPassword(value: string) {
  return value.trim().normalize("NFKC").toLocaleLowerCase("zh-CN");
}

export function getPasswordChecks(
  password: string,
  context: PasswordContext = {}
): PasswordCheck[] {
  const normalizedPassword = password.toLocaleLowerCase("en-US");
  const username = context.username?.trim() ?? "";
  const employeeNumbers = (context.employeeNumbers ?? [])
    .map(normalizeEmployeeNumberValue)
    .filter(Boolean);
  const hasPassword = password.length > 0;
  const formatValid =
    password.length >= PASSWORD_MIN_LENGTH &&
    password.length <= PASSWORD_MAX_LENGTH &&
    printableAsciiPattern.test(password);
  const commonPasswordSafe =
    hasPassword && !commonPasswords.has(normalizedPassword);
  const usernameSafe =
    !username ||
    normalizedPassword !== normalizeIdentifierForPassword(username);
  const employeeNumbersSafe =
    !employeeNumbers.length || !employeeNumbers.includes(normalizedPassword);
  const identityContextReady = Boolean(username) && employeeNumbers.length > 0;

  return [
    {
      key: "format",
      label: `${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH}个字符，仅使用英文字母、数字和常用半角符号`,
      met: formatValid
    },
    {
      key: "letter",
      label: "包含英文字母",
      met: asciiLetterPattern.test(password)
    },
    {
      key: "digit",
      label: "包含数字",
      met: asciiDigitPattern.test(password)
    },
    {
      key: "safeIdentity",
      label: "不能使用常见密码、用户名或工号",
      met:
        !hasPassword
          ? null
          : !commonPasswordSafe || !usernameSafe || !employeeNumbersSafe
            ? false
            : identityContextReady
              ? true
              : null
    }
  ];
}

export function passwordCheckFailed(check: PasswordCheck) {
  return check.met === false;
}

export function passwordIsValid(
  password: string,
  context: PasswordContext = {}
) {
  return !getPasswordChecks(password, context).some(passwordCheckFailed);
}

export function firstPasswordError(
  password: string,
  context: PasswordContext = {}
) {
  const failed = getPasswordChecks(password, context).find(passwordCheckFailed);
  if (!failed) return null;
  switch (failed.key) {
    case "format":
      return `密码必须为 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH}个字符，且只能使用英文字母、数字和常用半角符号`;
    case "letter":
      return "密码必须包含英文字母";
    case "digit":
      return "密码必须包含数字";
    case "safeIdentity":
      return "密码不能使用常见密码、用户名或工号";
  }
}
