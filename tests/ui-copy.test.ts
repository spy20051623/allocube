import { beforeAll, describe, expect, it } from "vitest";
import i18n, { initializeI18n } from "../src/i18n/index.js";
import {
  auditActionLabel,
  reservationStatusClass,
  reservationStatusLabel,
  resourceGroupStatusLabel,
  userStatusLabel
} from "../src/ui-copy.js";

describe("角色化界面文案", () => {
  beforeAll(async () => {
    await initializeI18n();
    await i18n.changeLanguage("zh-CN");
  });

  it("把内部状态统一映射为中文任务语言", () => {
    expect(userStatusLabel("PENDING_APPROVAL")).toBe("等待审核");
    expect(resourceGroupStatusLabel("ACTIVE")).toBe("启用");
    expect(resourceGroupStatusLabel("DISABLED")).toBe("停用");
    expect(
      reservationStatusLabel(
        "CONFIRMED",
        "2099-01-01T00:00:00.000Z",
        "2099-01-01T01:00:00.000Z",
        0
      )
    ).toBe("未开始");
    expect(auditActionLabel("RESERVATION_CREATE")).toBe("登记资源占用");
    expect(auditActionLabel("RESERVATION_SPLIT_UNAVAILABILITY")).toBe(
      "因维护拆分占用"
    );
    expect(auditActionLabel("UNAVAILABILITY_INTERRUPT_DISABLE")).toBe(
      "因停用中止维护"
    );
    expect(auditActionLabel("SMTP_SETTINGS_ENABLE")).toBe("启用邮件发送");
    expect(auditActionLabel("PROFILE_CHANGE_APPROVE")).toBe("通过资料修改");
    expect(auditActionLabel("USER_DELETE")).toBe("永久删除用户");
    expect(auditActionLabel("RESERVATION_WITHDRAW_FIRST_MINUTE")).toBe(
      "撤销刚开始的占用"
    );
    expect(userStatusLabel("UNKNOWN")).toBe("状态未知");
    expect(auditActionLabel("UNKNOWN")).toBe("UNKNOWN");
  });

  it("占用状态样式只依赖稳定状态和值", () => {
    const now = Date.parse("2026-08-31T08:00:00.000Z");
    expect(
      reservationStatusClass(
        "CONFIRMED",
        "2026-08-31T09:00:00.000Z",
        "2026-08-31T10:00:00.000Z",
        now
      )
    ).toBe("upcoming");
    expect(
      reservationStatusClass(
        "CONFIRMED",
        "2026-08-31T07:00:00.000Z",
        "2026-08-31T09:00:00.000Z",
        now
      )
    ).toBe("active");
    expect(
      reservationStatusClass(
        "CANCELLED",
        "2026-08-31T09:00:00.000Z",
        "2026-08-31T10:00:00.000Z",
        now
      )
    ).toBe("cancelled");
  });
});
