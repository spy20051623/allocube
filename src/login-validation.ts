import {
  EMPLOYEE_NUMBER_MESSAGE,
  isEmployeeNumberValid
} from "./shared/identity-rules";

export type LoginIdentifierType = "USERNAME" | "EMPLOYEE_NUMBER";
export type LoginField = "identifier" | "password";
export type LoginFieldErrors = Partial<Record<LoginField, string>>;

export function validateLoginField(
  identifierType: LoginIdentifierType,
  field: LoginField,
  identifier: string,
  password: string
) {
  if (field === "password") {
    return password.length === 0 ? "请输入密码" : null;
  }

  if (!identifier.trim()) {
    return identifierType === "USERNAME" ? "请输入用户名" : "请输入工号";
  }

  if (
    identifierType === "EMPLOYEE_NUMBER" &&
    !isEmployeeNumberValid(identifier)
  ) {
    return EMPLOYEE_NUMBER_MESSAGE;
  }

  return null;
}

export function validateLoginForm(
  identifierType: LoginIdentifierType,
  identifier: string,
  password: string
) {
  const errors: LoginFieldErrors = {};
  const identifierError = validateLoginField(
    identifierType,
    "identifier",
    identifier,
    password
  );
  const passwordError = validateLoginField(
    identifierType,
    "password",
    identifier,
    password
  );

  if (identifierError) errors.identifier = identifierError;
  if (passwordError) errors.password = passwordError;
  return errors;
}
