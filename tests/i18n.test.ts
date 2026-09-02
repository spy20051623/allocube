import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import i18n, {
  changeLocale,
  initializeI18n,
  LOCALE_STORAGE_KEY,
  normalizeLocale,
  resolveInitialLocale,
  tr,
  trDynamic,
  translateServerMessage,
  translateSystemMessageCode,
  updateDocumentLocale
} from "../src/i18n/index.js";
import { createSystemMessageCatalog } from "../src/shared/system-message.js";
import {
  chineseResources,
  englishResources,
  flattenResources,
  translationDomains
} from "../src/i18n/resources.js";
import { getDocsSections } from "../src/docs-content.js";
import serverEnglish from "../src/i18n/server-en.json";
import { validateLoginField } from "../src/login-validation.js";
import { validateResetPasswordForm } from "../src/public-auth-validation.js";
import { resourceGroupStatusLabel, userStatusLabel } from "../src/ui-copy.js";
import { siteOriginValidationError } from "../src/shared/site-origin.js";
import { icpFilingValidationError } from "../src/shared/icp-filing.js";

function placeholders(value: string) {
  return Array.from(value.matchAll(/\{\{([^}]+)\}\}/g), (match) => match[1]).sort();
}

describe("国际化资源与语言解析", () => {
  beforeAll(async () => {
    await initializeI18n();
  });

  afterAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("将中英文浏览器语言归一化并对其他语言回退简体中文", () => {
    expect(normalizeLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("fr-FR")).toBeNull();
    expect(resolveInitialLocale(null, ["fr-FR", "en-GB"])).toBe("en");
    expect(resolveInitialLocale("zh-TW", ["en-US"])).toBe("zh-CN");
    expect(resolveInitialLocale(null, ["de-DE"])).toBe("zh-CN");
  });

  it("中英文界面资源具有完全一致的键和插值参数", () => {
    const chinese = flattenResources(chineseResources);
    const english = flattenResources(englishResources);
    const chineseKeys = Object.keys(chinese).sort();
    const englishKeys = Object.keys(english).sort();
    expect(englishKeys).toEqual(chineseKeys);
    for (const key of chineseKeys) {
      expect(english[key].trim(), key).not.toBe("");
      expect(placeholders(english[key]), key).toEqual(
        placeholders(chinese[key])
      );
    }
  });

  it("九个领域资源在中英文中逐域对齐", () => {
    expect(translationDomains).toEqual([
      "common", "auth", "calendar", "admin", "feedback",
      "validation", "notifications", "email", "docs"
    ]);
    for (const domain of translationDomains) {
      expect(Object.keys(englishResources[domain]).sort(), domain).toEqual(
        Object.keys(chineseResources[domain]).sort()
      );
    }
  });

  it("英文用户文案不使用常见逐字直译词组", () => {
    const values = [
      ...Object.values(flattenResources(englishResources)),
      ...Object.values(serverEnglish)
    ];
    const awkwardLiteralPatterns = [
      /machine access application/i,
      /profile information modification/i,
      /material modification/i,
      /take(?:n)? down/i,
      /whole machine/i,
      /does not exist/i,
      /not filled/i,
      /mail reception/i,
      /formal users?/i,
      /disablement/i,
      /reconfirm/i
    ];
    for (const pattern of awkwardLiteralPatterns) {
      expect(values.filter((value) => pattern.test(value)), String(pattern)).toEqual([]);
    }
  });

  it("切换语言无需重新初始化并支持安全插值", async () => {
    await i18n.changeLanguage("en");
    expect(tr("登录")).toBe("Log in");
    expect(tr("还有 {{count}} 条公告", { count: 2 })).toContain("2");
    expect(tr("链接到{{v0}}", { v0: "<script>" })).toContain("<script>");
    await i18n.changeLanguage("zh-CN");
    expect(tr("登录")).toBe("登录");
  });

  it("英文紧凑控件使用简短且明确的标签", async () => {
    await i18n.changeLanguage("en");
    try {
      expect(tr("资源日历")).toBe("Calendar");
      expect(tr("我的占用")).toBe("Reservations");
      expect(tr("管理")).toBe("Admin");
      expect(tr("资源管理")).toBe("Resources");
      expect(tr("用户管理")).toBe("Users");
      expect(tr("使用统计")).toBe("Usage");
      expect(tr("系统设置")).toBe("Settings");
      expect(tr("审计记录")).toBe("Audit log");
      expect(tr("API 文档")).toBe("API Docs");
      expect(tr("问题单")).toBe("Issue");
      expect(tr("需求单")).toBe("Request");
      expect(tr("非常紧急")).toBe("Critical");
      expect(tr("已提交")).toBe("Submitted");
      expect(tr("已修复")).toBe("Fixed");
      expect(tr("标签")).toBe("Tags");
      expect(tr("资源占用规则")).toBe("Reservation rules");
      expect(tr("最短占用时长（分钟）")).toBe("Minimum duration (min)");
      expect(tr("最远可占用天数")).toBe("Booking window (days)");
      expect(tr("站点地址")).toBe("Site URL");
      expect(tr("发送配置")).toBe("SMTP settings");
      expect(tr("SMTP 服务器")).toBe("Host");
      expect(tr("SMTP 登录账号")).toBe("Username");
      expect(tr("保存邮件配置")).toBe("Save");
      expect(tr("新建")).toBe("New");
      expect(tr("创建")).toBe("Create");
      expect(tr("添加")).toBe("Add");
      expect(tr("邀请")).toBe("Invite");
      expect(tr("用户信息")).toBe("Profile");
      expect(tr("登录与安全")).toBe("Security");
      expect(tr("个人访问令牌")).toBe("API tokens");
      expect(tr("通知中心")).toBe("Notifications");
      expect(tr("管理控制台")).toBe("Admin");
      expect(tr("占用详情")).toBe("Details");
      expect(tr("资源组")).toBe("Group");
      expect(tr("整机")).toBe("Machine");
      expect(tr("{{count}} 组", { count: 1 })).toBe("1 Group");
      expect(tr("{{count}} 组", { count: 2 })).toBe("2 Groups");
      expect(tr("{{v0}}{{v1}}的资源组", { v0: tr("收起"), v1: "Node" })).toBe("Collapse Node's group");
      expect(tr("安排维护")).toBe("Schedule");
      expect(tr("维护管理")).toBe("Maintenance");
      expect(tr("导出 CSV")).toBe("Export");
      expect(tr("账号登录")).toBe("Login");
      expect(tr("用户注册")).toBe("Register");
      expect(tr("找回密码")).toBe("Reset password");
      expect(tr("设置新密码")).toBe("New password");
      expect(tr("注册申请已提交")).toBe("Registration submitted");
      expect(tr("重置邮件已发送")).toBe("Email sent");
      expect(tr("邮箱验证码")).toBe("Email code");
      expect(tr("重新申请重置链接")).toBe("New link");
      expect(tr("提交注册")).toBe("Register");
      expect(tr("提交申请")).toBe("Submit");
      expect(tr("确认邀请")).toBe("Invite");
      expect(tr("确认拒绝")).toBe("Reject");
      expect(tr("确认撤回")).toBe("Withdraw");
      expect(tr("生成重置链接")).toBe("Reset link");
      expect(tr("修改姓名和工号")).toBe("Edit profile");
      expect(tr("清除已保存密码")).toBe("Clear password");
    } finally {
      await i18n.changeLanguage("zh-CN");
    }
  });

  it("按语义区分状态、动作和确认后的英文术语", async () => {
    await i18n.changeLanguage("en");
    try {
      expect(tr("status.enabled")).toBe("Enabled");
      expect(tr("status.disabled")).toBe("Disabled");
      expect(userStatusLabel("ACTIVE")).toBe("Enabled");
      expect(resourceGroupStatusLabel("DISABLED")).toBe("Disabled");
      expect(tr("启用")).toBe("Enable");
      expect(tr("停用")).toBe("Disable");
      expect(tr("action.apiToken.new")).toBe("New");
      expect(tr("action.apiToken.create")).toBe("Create");
      expect(tr("action.reservation.new")).toBe("New");
      expect(tr("action.feedback.new")).toBe("New");
      expect(tr("action.feedback.create")).toBe("Create");
      expect(tr("action.machine.new")).toBe("New");
      expect(tr("action.machine.create")).toBe("Create");
      expect(tr("action.maintenance.create")).toBe("Create");
      expect(tr("action.machineUser.invite")).toBe("Invite");
      expect(tr("action.resourceGroup.new")).toBe("New");
      expect(tr("action.resourceItem.new")).toBe("New");
      expect(tr("action.device.add")).toBe("Add");
      expect(tr("action.interval.add")).toBe("Add");
      expect(tr("action.announcement.new")).toBe("New");
      expect(tr("邮件通知")).toBe("Email notifications");
      expect(tr("全部资源")).toBe("All resources");
      expect(tr("问题描述")).toBe("Details");
      expect(tr("需求描述")).toBe("Details");
      expect(tr("显示已撤下")).toBe("Show archived");
      expect(tr("密码状态")).toBe("Password status");
      expect(tr("SMTP 密码")).toBe("SMTP password");
      expect(tr("查看影响")).toBe("Review impact");
      expect(tr("用户与权限")).toBe("Users & access");
      expect(tr("等级")).toBe("Priority");
      expect(tr("连接加密")).toBe("Connection security");
      expect(tr("计算资源占用系统")).toBe("Compute resource reservations");
    } finally {
      await i18n.changeLanguage("zh-CN");
    }

    expect(tr("status.enabled")).toBe("启用");
    expect(tr("status.disabled")).toBe("停用");
    expect(userStatusLabel("ACTIVE")).toBe("启用");
    expect(resourceGroupStatusLabel("DISABLED")).toBe("停用");
    expect(tr("action.apiToken.new")).toBe("创建令牌");
    expect(tr("action.apiToken.create")).toBe("创建令牌");
    expect(tr("action.reservation.new")).toBe("新增占用");
    expect(tr("action.feedback.new")).toBe("提交反馈");
    expect(tr("action.feedback.create")).toBe("提交反馈");
    expect(tr("action.machine.new")).toBe("新增机器");
    expect(tr("action.machine.create")).toBe("创建机器");
    expect(tr("action.maintenance.create")).toBe("创建维护");
    expect(tr("action.machineUser.invite")).toBe("邀请用户");
    expect(tr("action.resourceGroup.new")).toBe("新增资源组");
    expect(tr("action.resourceItem.new")).toBe("新增资源项");
    expect(tr("action.device.add")).toBe("添加设备");
    expect(tr("action.interval.add")).toBe("添加区间");
    expect(tr("action.announcement.new")).toBe("创建公告");
  });

  it("英文模式下认证校验和状态回退不泄漏中文", async () => {
    await i18n.changeLanguage("en");
    try {
      expect(
        validateLoginField("EMPLOYEE_NUMBER", "identifier", "123", "")
      ).toBe("Enter a valid employee ID");
      expect(validateResetPasswordForm("short", "").password).toEqual(
        expect.arrayContaining([
          "8–64 characters using letters, numbers, and common ASCII symbols",
          "Include a number"
        ])
      );
      expect(userStatusLabel("UNKNOWN")).toBe("Status unknown");
      expect(trDynamic(siteOriginValidationError("not a url")!)).toBe(
        "Enter a valid site URL"
      );
      expect(trDynamic(icpFilingValidationError("invalid")!)).toContain(
        "Enter a valid ICP filing number"
      );
    } finally {
      await i18n.changeLanguage("zh-CN");
    }
  });

  it("手动选择写入本机偏好并同步 HTML 语言和描述", async () => {
    const stored = new Map<string, string>();
    const meta = { content: "" };
    const fakeDocument = {
      documentElement: { lang: "" },
      querySelector: () => meta
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => stored.get(key) ?? null,
          setItem: (key: string, value: string) => stored.set(key, value)
        }
      }
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: fakeDocument
    });
    try {
      await changeLocale("en");
      expect(stored.get(LOCALE_STORAGE_KEY)).toBe("en");
      expect(fakeDocument.documentElement.lang).toBe("en");
      expect(meta.content).toContain("Reservation coordination");
      updateDocumentLocale("zh-CN");
      expect(fakeDocument.documentElement.lang).toBe("zh-CN");
    } finally {
      Reflect.deleteProperty(globalThis, "window");
      Reflect.deleteProperty(globalThis, "document");
    }
  });

  it("英文模式可翻译带动态参数的服务端兼容消息", async () => {
    await i18n.changeLanguage("en");
    try {
      const catalog = createSystemMessageCatalog(serverEnglish);
      const resolved = catalog.resolve("GPU 的分配方式已经变化，请刷新后重试");
      expect(resolved?.code).toMatch(/^SYSTEM_MESSAGE_[0-9A-F]{8}$/u);
      expect(resolved?.params).toEqual({ v0: "GPU" });
      expect(translateServerMessage("GPU 的分配方式已经变化，请刷新后重试")).toBe(
        "GPU's allocation method has changed. Please refresh and try again."
      );
      expect(translateSystemMessageCode(resolved!.code, resolved!.params)).toBe(
        "GPU's allocation method has changed. Please refresh and try again."
      );
      expect(new Set(catalog.entries.map(({ code }) => code)).size).toBe(catalog.entries.length);
    } finally {
      await i18n.changeLanguage("zh-CN");
    }
  });

  it("BusinessError 默认生成稳定错误码和动态参数，同时保留显式业务码", async () => {
    const { BusinessError } = await import("../server/business-error.js");
    const dynamic = new BusinessError("GPU 的分配方式已经变化，请刷新后重试", 409);
    expect(dynamic.code).toMatch(/^SYSTEM_MESSAGE_[0-9A-F]{8}$/u);
    expect(dynamic.params).toEqual({ v0: "GPU" });
    const explicit = new BusinessError(
      "反馈已被更新，请刷新后重试",
      409,
      undefined,
      "FEEDBACK_STALE"
    );
    expect(explicit.code).toBe("FEEDBACK_STALE");
    expect(explicit.messageCode).toMatch(/^SYSTEM_MESSAGE_[0-9A-F]{8}$/u);
  });

  it("八套中英文手册保持相同路径和章节标识", () => {
    const zh = getDocsSections("zh-CN");
    const en = getDocsSections("en");
    expect(en).toHaveLength(8);
    expect(en.map(({ slug, path }) => ({ slug, path }))).toEqual(
      zh.map(({ slug, path }) => ({ slug, path }))
    );
    expect(en.every((section) => section.markdown.startsWith("# "))).toBe(true);
    expect(en.every((section) => !/[\u4e00-\u9fff]/u.test(section.title))).toBe(true);
  });

  it("公开 API 规范与运行时实现不重新引入中文系统文案", () => {
    for (const file of ["server/open-api.ts", "server/openapi-document.ts"]) {
      const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/[\u4e00-\u9fff]/u);
      expect(source, file).not.toMatch(
        /too frequent|Confirm the token|pre-check|re-preflight|Interface does not exist|Whole machine|does not exist/u
      );
    }
  });

  it("安全邮件包含中英文并对通知动态内容统一转义", () => {
    const auth = fs.readFileSync(new URL("../server/routes-auth.ts", import.meta.url), "utf8");
    const mailer = fs.readFileSync(new URL("../server/mailer.ts", import.meta.url), "utf8");
    expect(auth).toContain("Registration verification code");
    expect(auth).toContain("Reset your Allocube password");
    expect(mailer).toContain("English");
    expect(mailer).toContain("escapeHtml(title)");
    expect(mailer).toContain("escapeHtml(body)");
    expect(mailer).toContain("escapeHtml(detailUrl)");
  });
});
