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

export function firstPasswordError(password, username = "") {
  if (
    password.length < 8 ||
    password.length > 64 ||
    !/^[\x21-\x7e]+$/.test(password)
  ) {
    return "密码必须为 8–64个字符，且只能使用英文字母、数字和常用半角符号";
  }
  if (!/[A-Za-z]/.test(password)) return "密码必须包含英文字母";
  if (!/\d/.test(password)) return "密码必须包含数字";
  if (
    commonPasswords.has(password.toLowerCase()) ||
    (username &&
      password.toLowerCase() ===
        username.trim().normalize("NFKC").toLowerCase())
  ) {
    return "密码不能使用常见密码、用户名或工号";
  }
  return null;
}
