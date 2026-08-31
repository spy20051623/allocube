import { tr, trDynamic } from "./i18n/index";
import {
  EMPLOYEE_NUMBER_MESSAGE,
  getPasswordChecks,
  isEmployeeNumberValid,
  passwordCheckFailed
} from "./shared/identity-rules";

export const registrationFields = [
  "username",
  "realName",
  "employeeNumber",
  "email",
  "code",
  "password",
  "confirmPassword"
] as const;

export type RegistrationField = (typeof registrationFields)[number];
export type ServerRegistrationField = Exclude<
  RegistrationField,
  "confirmPassword"
>;

export type RegistrationFieldErrors = Partial<
  Record<RegistrationField, string[]>
>;

export interface RegistrationFormValues {
  username: string;
  realName: string;
  employeeNumber: string;
  email: string;
  challengeId: string;
  challengeEmail: string;
  code: string;
  password: string;
  confirmPassword: string;
}

const usernameEdge = "[\\p{Script=Han}A-Za-z0-9]";
const usernameBody = "[\\p{Script=Han}A-Za-z0-9._-]";
const usernamePattern = new RegExp(
  `^${usernameEdge}(?:${usernameBody}*${usernameEdge})?$`,
  "u"
);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeRegistrationEmail(value: string) {
  return value.trim().toLowerCase();
}

export function validateUsername(value: string) {
  const display = value.trim().normalize("NFKC");
  const length = Array.from(display).length;
  if (length < 2 || length > 32) {
    return [tr("用户名必须为 2–32 个字符")];
  }
  if (!usernamePattern.test(display)) {
    return [
      tr("用户名仅支持中文、字母、数字、点、下划线和短横线，且首尾须为文字或数字")
    ];
  }
  if (display.toLocaleLowerCase("zh-CN") === "administrator") {
    return [tr("该用户名为系统保留名称")];
  }
  return [];
}

export function validateRealName(value: string) {
  const length = Array.from(value.trim()).length;
  return length >= 2 && length <= 60 ? [] : [tr("姓名必须为 2–60 个字符")];
}

export function validateEmployeeNumber(value: string) {
  return isEmployeeNumberValid(value) ? [] : [tr(EMPLOYEE_NUMBER_MESSAGE)];
}

export function validateEmail(value: string, allowedDomains: string[]) {
  const email = normalizeRegistrationEmail(value);
  if (!email || email.length > 254 || !emailPattern.test(email)) {
    return [tr("请输入有效的邮箱地址")];
  }
  if (allowedDomains.length) {
    const domain = email.slice(email.lastIndexOf("@") + 1);
    if (!allowedDomains.includes(domain)) {
      return [tr("仅允许以下邮箱域名：{{v0}}", { v0: allowedDomains.join("、") })];
    }
  }
  return [];
}

export function validateRegistrationField(
  field: RegistrationField,
  values: RegistrationFormValues,
  allowedDomains: string[],
  emailEnabled = true,
  allowEmptyEmail = true
): string[] {
  switch (field) {
    case "username":
      return validateUsername(values.username);
    case "realName":
      return validateRealName(values.realName);
    case "employeeNumber":
      return validateEmployeeNumber(values.employeeNumber);
    case "email":
      if (!emailEnabled) return [];
      if (!values.email.trim()) return allowEmptyEmail ? [] : [tr("请输入邮箱")];
      return validateEmail(values.email, allowedDomains);
    case "code":
      if (!emailEnabled || !values.email.trim()) return [];
      return values.code.length === 6 ? [] : [tr("请输入6位验证码")];
    case "password": {
      const failed = getPasswordChecks(values.password, {
        username: values.username,
        employeeNumbers: [values.employeeNumber]
      }).filter(passwordCheckFailed);
      return failed.map((item) => trDynamic(item.label));
    }
    case "confirmPassword":
      if (!values.confirmPassword) return [tr("请再次输入密码")];
      return values.confirmPassword === values.password
        ? []
        : [tr("两次输入的密码不一致")];
  }
}

export function validateRegistrationForm(
  values: RegistrationFormValues,
  allowedDomains: string[],
  emailEnabled = true,
  allowEmptyEmail = true
) {
  const errors: RegistrationFieldErrors = {};
  for (const field of registrationFields) {
    const fieldErrors = validateRegistrationField(
      field,
      values,
      allowedDomains,
      emailEnabled,
      allowEmptyEmail
    );
    if (fieldErrors.length) errors[field] = fieldErrors;
  }
  return errors;
}

export function registrationFieldValue(
  field: RegistrationField,
  values: RegistrationFormValues
) {
  switch (field) {
    case "code":
      return `${normalizeRegistrationEmail(values.email)}\u0000${values.challengeId}\u0000${values.code}`;
    case "password":
      return `${values.password}\u0000${values.username}\u0000${values.employeeNumber}`;
    case "confirmPassword":
      return `${values.confirmPassword}\u0000${values.password}`;
    default:
      return values[field];
  }
}

export function isServerRegistrationField(
  value: string
): value is ServerRegistrationField {
  return (
    value === "username" ||
    value === "realName" ||
    value === "employeeNumber" ||
    value === "email" ||
    value === "code" ||
    value === "password"
  );
}

export function parseServerRegistrationErrors(
  input: unknown
): RegistrationFieldErrors | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const parsed: RegistrationFieldErrors = {};
  for (const [field, messages] of Object.entries(input)) {
    if (!isServerRegistrationField(field) || !Array.isArray(messages)) continue;
    const validMessages = messages.filter(
      (message): message is string =>
        typeof message === "string" && message.trim().length > 0
    );
    if (validMessages.length) parsed[field] = validMessages;
  }
  return Object.keys(parsed).length ? parsed : null;
}
