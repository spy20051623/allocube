import { validateEmail } from "./registration-validation";
import {
  getPasswordChecks,
  passwordCheckFailed
} from "./shared/identity-rules";

export type ResetPasswordField = "password" | "confirmPassword";
export type ResetPasswordStaticErrors = Partial<
  Record<ResetPasswordField, string[]>
>;

export function validateForgotPasswordEmail(email: string) {
  return validateEmail(email, []);
}

export function validateResetPasswordForm(
  password: string,
  confirmPassword: string
) {
  const errors: ResetPasswordStaticErrors = {};
  const failedChecks = getPasswordChecks(password).filter(passwordCheckFailed);
  if (failedChecks.length) {
    errors.password = failedChecks.map((check) => check.label);
  }
  if (!confirmPassword) {
    errors.confirmPassword = ["请再次输入密码"];
  } else if (confirmPassword !== password) {
    errors.confirmPassword = ["两次输入的密码不一致"];
  }
  return errors;
}
