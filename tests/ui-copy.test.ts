import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  auditActionLabel,
  reservationStatusLabel,
  resourceGroupStatusLabel,
  userStatusLabel
} from "../src/ui-copy.js";

describe("角色化界面文案", () => {
  it("把内部状态统一映射为中文任务语言", () => {
    expect(userStatusLabel("PENDING_APPROVAL")).toBe("等待审核");
    expect(resourceGroupStatusLabel("ACTIVE")).toBe("启用");
    expect(resourceGroupStatusLabel("DISABLED")).toBe("长期停用");
    expect(
      reservationStatusLabel(
        "CONFIRMED",
        "2099-01-01T00:00:00.000Z",
        "2099-01-01T01:00:00.000Z",
        0
      )
    ).toBe("未开始");
    expect(auditActionLabel("RESERVATION_CREATE")).toBe("登记资源占用");
    expect(auditActionLabel("SMTP_SETTINGS_ENABLE")).toBe("启用邮件发送");
    expect(auditActionLabel("PROFILE_CHANGE_APPROVE")).toBe("通过资料修改");
    expect(auditActionLabel("USER_DELETE")).toBe("永久删除用户");
    expect(auditActionLabel("RESERVATION_WITHDRAW_FIRST_MINUTE")).toBe(
      "撤销刚开始的占用"
    );
    expect(userStatusLabel("UNKNOWN")).toBe("状态未知");
    expect(auditActionLabel("UNKNOWN")).toBe("其他系统操作");
  });

  it("普通界面不出现开发实现术语", () => {
    const source = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    for (const forbidden of [
      "首个工号",
      "永久用户 ID",
      "申请版本",
      "原子改期",
      "申请段",
      "整批回滚"
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("登录页只保留必要提示，并把待审规则放在注册流程", () => {
    const source = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    for (const redundant of [
      "欢迎回来",
      "登录后查看今天的资源安排",
      "进入工作台",
      "本地管理员账号已预填",
      "待审核账号也使用用户名登录",
      "只有已启用工号可以登录"
    ]) {
      expect(source).not.toContain(redundant);
    }
    expect(source).toContain('<AuthLayout title="账号登录">');
    expect(source).toContain('title="用户注册"');
    expect(source).not.toContain("验证邮箱后提交注册申请");
    expect(source).not.toContain("我们会发送一个 30 分钟有效的链接");
    expect(source).not.toContain(
      "使用 8–64 位英文字母、数字和常用半角符号，并同时包含字母和数字"
    );
    expect(source).not.toContain('placeholder="name@company.com"');
    expect(source.match(/注册审核通过前请使用用户名登录。/g)).toHaveLength(1);
  });

  it("机器权限区域使用简洁列表名称和图标操作", () => {
    const source = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain('label: "资源管理"');
    expect(source).toContain('label: "用户管理"');
    expect(source).not.toContain('label: "机器与资源组"');
    expect(source).not.toContain('label: "用户审核"');
    expect(source).toContain('title="用户列表"');
    expect(source).toContain('title="申请列表"');
    expect(source).not.toContain('title="有权限用户"');
    expect(source).not.toContain('title="使用权申请"');
    for (const action of [
      "设为管理员",
      "取消管理员",
      "移除用户",
      "通过申请",
      "拒绝申请"
    ]) {
      expect(source).toContain(`title="${action}"`);
    }
    expect(source).toContain(
      'member.role === "MACHINE_ADMIN" ? "管理员" : "使用者"'
    );
    expect(source).not.toContain("<span>账号状态</span>");
    expect(source).not.toContain("member-status-chip");
    expect(source).toContain('title="停用账号"');
    expect(source).not.toContain("停用并保留占用");
    expect(source).not.toContain("停用并取消占用");
  });

  it("机器简短信息与功能页签共用同一顶部栏", () => {
    const source = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const contextStart = source.indexOf('className="machine-context-bar card"');
    const contentStart = source.indexOf(
      'className="machine-section-content"',
      contextStart
    );
    const contextBar = source.slice(contextStart, contentStart);
    expect(contextBar).toContain('className="machine-context-identity"');
    expect(contextBar).toContain('className="machine-section-tabs"');
    expect(contextBar.indexOf('className="machine-section-tabs"')).toBeLessThan(
      contextBar.indexOf('className="machine-context-identity"')
    );
    expect(styles).toMatch(
      /\.machine-context-bar\s*\{[^}]*display:\s*flex[^}]*justify-content:\s*space-between/s
    );
  });

  it("机器编辑浮窗采用紧凑分组并移除冗余提示", () => {
    const source = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    expect(source).toContain('machine ? "编辑机器" : "新增机器"');
    expect(source).toContain('className="machine-form-public-notes"');
    expect(source).toContain("硬件说明（用户可见）");
    expect(source).toContain("连接说明（用户可见）");
    expect(source).toContain("请勿填写密码或密钥");
    expect(source).not.toContain(
      "硬件说明和连接说明会对所有拥有这台机器使用权的用户显示。"
    );
    expect(source).not.toContain(
      "请勿在管理备注中保存密码、密钥或其他可直接使用的凭据。"
    );
    expect(styles).toMatch(
      /\.machine-form-public-notes\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s
    );
  });

  it("用户管理把正式用户和两类审批申请分开呈现", () => {
    const source = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain('className="user-management-sections"');
    expect(source).toContain('className="card panel-card user-list-panel"');
    expect(source).toContain('className="card panel-card user-application-panel"');
    expect(source).toContain("{applications.length > 0 && (");
    expect(source).toContain('type: "REGISTRATION" as const');
    expect(source).toContain('type: "PROFILE_CHANGE" as const');
    expect(source).toContain('className="application-new-user-tag"');
    expect(source).toContain('className="application-employee-number"');
    expect(source).toContain('className="application-email"');
    expect(source).toContain('title="不通过，要求修改"');
    expect(source).toContain('<Trash2 size={15} />');
    const applicationList = source.slice(
      source.indexOf('className="user-application-list"'),
      source.indexOf("{emailChangeUser &&")
    );
    expect(applicationList).not.toContain("<span>类型</span>");
    expect(applicationList).toContain("<span>状态</span>");
    expect(applicationList).toContain('"待修改"');
    expect(applicationList).toContain('"待审核"');
    expect(applicationList).toContain('className="application-action-placeholder"');
    expect(
      applicationList.slice(applicationList.indexOf("{!isRegistration && ("))
    ).not.toContain("<Trash2");
    expect(source).toContain("<span>最后登录时间</span>");
    expect(source).toContain("formatChinaFullMinute(user.lastLoginAt)");
    expect(source).not.toContain("合并重复注册");
    expect(source).not.toContain("/merge");
  });

  it("管理页面优先展示申请并隐藏空申请表格", () => {
    const source = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    expect(source).toContain("{canManage && access.requests.length > 0 && (");
    expect(source).toContain("{applications.length > 0 && (");
    expect(source).not.toContain("暂无待处理申请");
    expect(styles).toMatch(/\.machine-requests-panel\s*\{\s*order:\s*1/);
    expect(styles).toMatch(/\.machine-access-panel\s*\{\s*order:\s*2/);
    expect(styles).toMatch(/\.user-application-panel\s*\{\s*order:\s*1/);
    expect(styles).toMatch(/\.user-list-panel\s*\{\s*order:\s*2/);
  });

  it("资源组支持计划停用、长期停用、恢复和彻底删除", () => {
    const source = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    const server = fs.readFileSync(new URL("../server/routes-admin.ts", import.meta.url), "utf8");
    expect(source).toContain('title="重新启用"');
    expect(source).toContain('title="永久删除"');
    expect(source).toContain("/enable");
    expect(source).toContain("/unavailability");
    expect(source).toContain('className="machine-unavailability-row"');
    expect(source.match(/className="unavailability-bar"/g)).toHaveLength(1);
    expect(server).toContain("disableLongTerm");
    expect(server).toContain("resource_unavailability");
  });

  it("机器停用、恢复和删除操作集中在停用管理卡片", () => {
    const source = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const machineInfoStart = source.indexOf('className="card panel-card machine-info-panel"');
    const unavailabilityStart = source.indexOf(
      'className="card panel-card machine-unavailability-panel"',
      machineInfoStart
    );
    const unavailabilityEnd = source.indexOf("{editMachine &&", unavailabilityStart);
    const machineInfoCard = source.slice(machineInfoStart, unavailabilityStart);
    const unavailabilityCard = source.slice(unavailabilityStart, unavailabilityEnd);
    expect(machineInfoCard).toContain("<Pencil");
    expect(machineInfoCard).toContain('className="machine-info-overview"');
    expect(machineInfoCard).toContain('className="machine-info-details"');
    expect(machineInfoCard).toContain('className="machine-info-detail management"');
    expect(machineInfoCard).not.toContain('className="machine-info-facts"');
    expect(machineInfoCard).not.toContain('className="machine-info-notes"');
    expect(machineInfoCard).not.toContain("setDisableMode");
    expect(machineInfoCard).not.toContain("handleDelete");
    expect(unavailabilityCard).toContain(
      'title={canManage ? "停用管理" : "停用安排"}'
    );
    expect(unavailabilityCard).toContain('setDisableMode("PLANNED")');
    expect(unavailabilityCard).toContain('setDisableMode("LONG_TERM")');
    expect(unavailabilityCard).toContain("<span>停用方式</span>");
    expect(unavailabilityCard).not.toContain("<span>范围</span>");
    expect(unavailabilityCard).not.toContain(': "整机"');
    expect(unavailabilityCard).toContain("长期停用");
    expect(unavailabilityCard).toContain("重新启用");
    expect(unavailabilityCard).toContain("永久删除");
    expect(source).toContain("function MachineDisableModal");
    expect(source).toContain("<Eye size={15} />查看影响");
    expect(source).toContain("确认停用");
    expect(styles).toMatch(
      /\.machine-disable-entry-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s
    );
  });

  it("所有已启用用户都能进入管理页，具体操作按机器权限显示", () => {
    const source = fs.readFileSync(
      new URL("../src/App.tsx", import.meta.url),
      "utf8"
    );
    expect(source).toContain("showAdmin={Boolean(activeUser)}");
    expect(source).not.toContain("canOpenAdmin");
    expect(source).not.toContain("你还不是机器管理员");
    expect(source).not.toContain('className="admin-scope"');
    expect(source).toContain(
      '{ id: "users" as const, label: "用户管理", icon: Users, show: true }'
    );
    expect(source).toContain(
      'isSystemAdmin ? "/admin/users" : "/users/directory"'
    );
    expect(source).toContain("canManage={isSystemAdmin}");
    expect(source).toContain('canManage={Boolean(');
    expect(source).toContain('title={canManage ? "停用管理" : "停用安排"}');
    expect(source).toContain(
      "{canManage && access.requests.length > 0 && ("
    );
  });

  it("没有机器权限时使用紧凑空状态并提供资源申请入口", () => {
    const source = fs.readFileSync(
      new URL("../src/App.tsx", import.meta.url),
      "utf8"
    );
    const styles = fs.readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8"
    );
    expect(source).toContain(
      'onOpenResourceCatalog={() => navigate("resources")}'
    );
    expect(source).toContain("暂无可查看的机器");
    expect(source).toContain("查看全部资源");
    expect(source).toContain(") : !machines.length ? (");
    expect(styles).toMatch(
      /\.machine-management-empty\s*\{[^}]*min-height:\s*250px;[^}]*flex:\s*0 0 auto;/s
    );
  });

  it("资源日历按实际内容收紧并只在长列表时滚动", () => {
    const source = fs.readFileSync(
      new URL("../src/App.tsx", import.meta.url),
      "utf8"
    );
    const styles = fs.readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8"
    );
    const timelineShell =
      styles.match(/\.timeline-scroll-shell\s*\{([^}]*)\}/)?.[1] ?? "";
    const timelineCard = styles.match(/\.timeline-card\s*\{([^}]*)\}/)?.[1] ?? "";
    const calendarLayout =
      styles.match(/\.calendar-layout\s*\{([^}]*)\}/)?.[1] ?? "";
    const calendarMain =
      styles.match(/\.calendar-main\s*\{([^}]*)\}/)?.[1] ?? "";
    const timelineFrame =
      styles.match(/\.timeline-scroll-frame\s*\{([^}]*)\}/)?.[1] ?? "";
    const bookingDrawer =
      styles.match(/\.booking-drawer\s*\{([^}]*)\}/)?.[1] ?? "";
    const calendarEmptyState =
      styles.match(/\.calendar-empty-state\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(source).toContain('title="没有符合条件的资源组"');
    expect(source).toContain("可以前往全部资源查看完整机器列表");
    expect(source).toContain('onOpenResourceCatalog={() => navigate("resources")}');
    expect(source).toContain("function CalendarEmptyState");
    expect(source).toContain(
      '<div ref={timelineFrameRef} className="timeline-scroll-frame">'
    );
    expect(source).toContain(
      'frame.addEventListener("wheel", handleTimelineWheel, { passive: false })'
    );
    expect(calendarEmptyState).toContain("flex: 1 1 auto");
    expect(calendarEmptyState).toContain("min-height: 0");
    expect(styles).toMatch(
      /\.calendar-empty-state\s*\{[^}]*overflow:\s*hidden;/s
    );
    expect(timelineCard).not.toContain("min-height");
    expect(calendarLayout).toContain(
      "height: calc(100dvh - var(--app-header-height))"
    );
    expect(calendarLayout).toContain("min-height: 0");
    expect(calendarLayout).toContain("overflow: hidden");
    expect(calendarMain).toContain("min-height: 0");
    expect(calendarMain).toContain("display: flex");
    expect(timelineFrame).toContain("min-height: 0");
    expect(timelineFrame).toContain("flex: 1 1 auto");
    expect(timelineShell).toContain("min-height: 0");
    expect(timelineShell).toContain("flex: 1 1 auto");
    expect(timelineShell).toContain("overflow-x: hidden");
    expect(timelineShell).toContain("overflow-y: auto");
    expect(bookingDrawer).toContain("overflow-y: auto");
    expect(timelineCard).not.toContain("overflow:");
    expect(styles).toMatch(
      /\.timeline-head\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;/s
    );
  });

  it("统计排行空状态不使用排行三列布局", () => {
    const styles = fs.readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8"
    );
    expect(styles).toContain(".ranking-list > div:not(.mini-empty)");
    expect(styles).toMatch(
      /\.ranking-list > \.mini-empty\s*\{[^}]*place-items:\s*center;[^}]*white-space:\s*nowrap;/s
    );
  });

  it("资源页面只保留查看和运维操作，配置在专用浮窗中整批保存", () => {
    const source = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const server = fs.readFileSync(
      new URL("../server/routes-admin.ts", import.meta.url),
      "utf8"
    );
    const resourcesStart = source.indexOf("function MachineResourcesSection");
    const resourcesEnd = source.indexOf(
      "function GroupUnavailabilityModal",
      resourcesStart
    );
    const resourcesPage = source.slice(resourcesStart, resourcesEnd);

    expect(resourcesPage).toContain("<Pencil size={14} />编辑资源");
    expect(resourcesPage).toContain('title="资源组"');
    expect(resourcesPage).not.toContain('title="资源配置"');
    expect(resourcesPage).not.toContain("resource-pool-panel");
    expect(resourcesPage).not.toContain('title="永久删除资源项"');
    expect(resourcesPage).not.toContain('title="编辑资源项"');
    expect(resourcesPage).not.toContain('title="编辑资源组"');
    expect(resourcesPage).toContain('title="计划停用"');
    expect(resourcesPage).toContain('title="长期停用"');
    expect(source).toContain("function ResourceConfigurationModal");
    expect(source).toContain('<option value="EXCLUSIVE">独占分配</option>');
    expect(source).toContain('<option value="SHARED">共享使用</option>');
    expect(source).toContain('sharingMode: "EXCLUSIVE"');
    expect(source).toContain("deletedPools");
    expect(source).toContain('"删除资源项"');
    expect(source).toContain("validateResourceConfigurationDraft");
    expect(source).toContain("reorderResourceDrafts");
    expect(source).toContain("draggable");
    expect(source).not.toContain('draggable={section === "POOLS"}');
    expect(source).toContain("<GripVertical");
    expect(source).not.toContain('<Field label="排序">');
    expect(source).toContain("function TagEditor");
    expect(source).toContain('event.key !== "Enter"');
    expect(source).toContain("event.nativeEvent.isComposing");
    expect(source).toContain('aria-label="输入标签"');
    expect(source).toContain('className="resource-tag-entry"');
    expect(source).toContain('className="resource-tag-list"');
    expect(source).toContain('"resource-tag-input-shell"');
    expect(source).not.toContain('<Field label="标签">');
    expect(source).not.toContain("标签（逗号分隔）");
    expect(source).not.toContain("tags.split");
    expect(source).toContain("resource-config-conflict-chip");
    expect(source).toContain("resource-allocation-errors");
    expect(source).toContain(
      "disabled={saving || validationIssues.length > 0}"
    );
    expect(source).toContain('role="tablist" aria-label="资源编辑内容"');
    expect(source).toContain("保存配置");
    expect(source).toContain(
      "`/admin/machines/${machine.id}/resource-configuration`"
    );
    expect(styles).toContain(".resource-config-workspace");
    expect(styles).toContain(".resource-allocation-card.conflict");
    expect(styles).toContain(".resource-config-error-count");
    expect(styles).toContain("button.drop-before::before");
    expect(styles).toContain("button.drop-after::after");
    expect(styles).toContain(".resource-tag-list");
    expect(styles).toContain(".resource-tag-input-shell");
    expect(styles).toContain(".resource-allocation-editor > .section-label");
    expect(styles).not.toContain(".resource-tag-editor input");
    expect(styles).not.toContain("button.drag-over");
    expect(server).toContain(
      '"/api/v1/admin/machines/:id/resource-configuration"'
    );
    expect(server).toContain("validateResourceConfiguration(body)");
  });

  it("所有密码框复用公共显示按钮并隐藏 Edge 原生按钮", () => {
    const source = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    expect(source).not.toContain('type="password"');
    expect(source).toContain('className="password-visibility-button"');
    expect(styles).toContain(".password-input-shell input::-ms-reveal");
    expect(styles).toContain(".password-input-shell input::-ms-clear");
  });

  it("所有确认和输入操作使用站内浮窗", () => {
    const source = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    for (const nativeDialog of [
      "window.alert",
      "window.confirm",
      "window.prompt"
    ]) {
      expect(source).not.toContain(nativeDialog);
    }
    expect(source).toContain("function DialogProvider");
    expect(source).toContain("function AppActionDialog");
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
  });

  it("管理员协助换绑邮箱复用单个邮箱验证浮窗", () => {
    const source = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain('title="协助换绑邮箱"');
    expect(source).toContain(
      "codeEndpoint={`/admin/users/${emailChangeUser.id}/email-change-code`}"
    );
    expect(source).toContain(
      "changeEndpoint={`/admin/users/${emailChangeUser.id}/change-email`}"
    );
    expect(source).toContain('submitLabel="确认换绑"');
    expect(source).not.toContain('title: "验证新邮箱"');
  });
});
