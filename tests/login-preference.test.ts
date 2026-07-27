import { describe, expect, it } from "vitest";
import {
  LOGIN_PREFERENCE_KEY,
  parseLoginPreference,
  readLoginPreference,
  rememberLoginMethod,
  rememberSuccessfulLogin,
  rememberUsername,
  type LoginPreferenceStorage
} from "../src/login-preference.js";

class MemoryStorage implements LoginPreferenceStorage {
  values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("登录偏好", () => {
  it("首次使用和损坏内容回退到用户名登录", () => {
    expect(parseLoginPreference(null)).toEqual({ method: "USERNAME" });
    expect(parseLoginPreference("not-json")).toEqual({ method: "USERNAME" });
    expect(parseLoginPreference('{"method":"UNKNOWN","username":"alice"}')).toEqual({
      method: "USERNAME"
    });
    expect(
      parseLoginPreference('{"method":"EMPLOYEE_NUMBER","employeeNumber":"bad-id"}')
    ).toEqual({ method: "USERNAME" });
  });

  it("切换方式只保存方式，不保存正在输入的账号", () => {
    const storage = new MemoryStorage();
    rememberLoginMethod("EMPLOYEE_NUMBER", storage);
    expect(readLoginPreference(storage)).toEqual({
      method: "EMPLOYEE_NUMBER"
    });
  });

  it("仅在成功登录后分别保存用户名和工号", () => {
    const storage = new MemoryStorage();
    rememberSuccessfulLogin("USERNAME", "Ａlice", "Alice", storage);
    expect(readLoginPreference(storage)).toEqual({
      method: "USERNAME",
      username: "Alice"
    });

    rememberSuccessfulLogin(
      "EMPLOYEE_NUMBER",
      "  WX123456  ",
      "Alice",
      storage
    );
    expect(readLoginPreference(storage)).toEqual({
      method: "EMPLOYEE_NUMBER",
      username: "Alice",
      employeeNumber: "wx123456"
    });
    expect(storage.getItem(LOGIN_PREFERENCE_KEY)).not.toContain("password");
  });

  it("注册时选择用户名方式，修改用户名时不改变当前方式", () => {
    const storage = new MemoryStorage();
    rememberSuccessfulLogin("EMPLOYEE_NUMBER", "10001001", undefined, storage);
    rememberUsername("新用户", true, storage);
    expect(readLoginPreference(storage)).toEqual({
      method: "USERNAME",
      username: "新用户",
      employeeNumber: "10001001"
    });

    rememberLoginMethod("EMPLOYEE_NUMBER", storage);
    rememberUsername("更新用户", false, storage);
    expect(readLoginPreference(storage)).toEqual({
      method: "EMPLOYEE_NUMBER",
      username: "更新用户",
      employeeNumber: "10001001"
    });
  });

  it("浏览器存储不可用时静默回退且不影响操作", () => {
    const storage: LoginPreferenceStorage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      }
    };
    expect(readLoginPreference(storage)).toEqual({ method: "USERNAME" });
    expect(() => rememberLoginMethod("EMPLOYEE_NUMBER", storage)).not.toThrow();
    expect(() =>
      rememberSuccessfulLogin("USERNAME", "alice", "Alice", storage)
    ).not.toThrow();
  });
});
