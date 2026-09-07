import { EditCancelled } from "../../edit-conflict";
import { PageHeader } from "../../PageHeader";
import { Modal } from "../../Modal";
import { tr } from "../../i18n/index";
import { UserX, UserCheck, Trash2, KeyRound, ChevronRight, Check, X, Copy } from "lucide-react";
import { useState } from "react";
import { ApiError, jsonBody } from "../../api";
import { copyTextToClipboard } from "../../clipboard";
import { formatChinaFullMinute } from "../../date";
import { userStatusLabel } from "../../ui-copy";
import { useConflictApi } from "../../app/useConflictApi";
import { SectionHeader } from "../../components/SectionHeader";
import { AuthFeedback } from "../../components/forms";

export function UserAdminPanel({
  users,
  canManage,
  notify,
  reload
}: {
  users: any[];
  canManage: boolean;
  notify: (kind: "success" | "error", message: string) => void;
  reload: () => Promise<void>;
}) {
  const { request: api, dialog } = useConflictApi();
  const [passwordResetLink, setPasswordResetLink] = useState<{
    displayName: string;
    resetUrl: string;
    expiresAt: string;
  } | null>(null);
  const processRegistration = async (
    action: () => Promise<unknown>,
    successMessage: string
  ) => {
    try {
      await action();
      notify("success", successMessage);
      await reload();
    } catch (error) {
      if (error instanceof EditCancelled) return;
      if (error instanceof ApiError && error.status === 409) {
        notify("error", tr("注册信息已被更新，用户列表已刷新。"));
        await reload();
        return;
      }
      notify("error", error instanceof Error ? error.message : tr("处理失败"));
    }
  };

  const disableUser = async (user: any) => {
    try {
      const preview = await api<{
        user: {
          id: string;
          displayName: string;
          status: string;
          version: number;
        };
        counts: {
          activeReservations: number;
          futureReservations: number;
          machineMemberships: number;
          machineAdminRoles: number;
          pendingProfileChanges: number;
        };
        revision: number;
      }>(`/admin/users/${user.id}/disable/preview`, {
        method: "POST",
        body: "{}"
      });
      const reason = await dialog.prompt({
        title: tr("停用账号"),
        message:
          tr("停用 {{v0}} 后将结束 {{v1}} 条当前占用，并取消 {{v2}} 条未来占用。\n", { v0: preview.user.displayName, v1: preview.counts.activeReservations, v2: preview.counts.futureReservations }) +
          tr("该用户在 {{v0}} 台机器中拥有使用权，其中管理 {{v1}} 台；这些关系会保留，但停用期间不可使用。", { v0: preview.counts.machineMemberships, v1: preview.counts.machineAdminRoles }) +
          (preview.counts.pendingProfileChanges
            ? tr("\n另有 {{v0}} 条资料修改申请将被取消。", { v0: preview.counts.pendingProfileChanges })
            : ""),
        label: tr("原因（选填）"),
        multiline: true,
        maxLength: 500,
        confirmLabel: tr("确认停用"),
        tone: "danger"
      });
      if (reason === null) return;
      await api(`/admin/users/${user.id}/disable`, {
        method: "POST",
        body: jsonBody({
          expectedVersion: preview.user.version,
          expectedRevision: preview.revision,
          reason: reason.trim()
        })
      });
      notify("success", tr("账号已停用，相关占用已释放"));
      await reload();
    } catch (error) {
      if (error instanceof EditCancelled) return;
      if (error instanceof ApiError && error.status === 409) {
        await reload();
      }
      notify("error", error instanceof Error ? error.message : tr("更新失败"));
    }
  };
  const enableUser = async (user: any) => {
    try {
      await api(`/admin/users/${user.id}/enable`, {
        method: "POST",
        body: jsonBody({ expectedVersion: Number(user.version) })
      });
      notify("success", tr("账号已重新启用"));
      await reload();
    } catch (error) {
      if (error instanceof EditCancelled) return;
      if (error instanceof ApiError && error.status === 409) {
        await reload();
      }
      notify("error", error instanceof Error ? error.message : tr("更新失败"));
    }
  };
  const deleteUser = async (user: any) => {
    try {
      const impact = await api<{
        user: {
          id: string;
          displayName: string;
          status: string;
          version: number;
        };
        counts: {
          machineMemberships: number;
          machineAdminRoles: number;
          accessRequests: number;
          reservations: number;
          notifications: number;
          auditLogs: number;
          feedbackTickets: number;
          feedbackActivities: number;
        };
      }>(`/admin/users/${user.id}/deletion-impact`);
      if (impact.user.status !== "DISABLED") {
        notify("error", tr("请先停用账号，再进行删除"));
        await reload();
        return;
      }
      const permissionCount =
        impact.counts.machineMemberships + impact.counts.machineAdminRoles;
      if (!(await dialog.confirm({
        title: tr("永久删除用户"),
        message:
          tr("删除 {{v0}} 后无法恢复，用户名、邮箱和工号将被释放。\n", { v0: impact.user.displayName }) +
          tr("将清除 {{v0}} 项机器权限、{{v1}} 条使用权申请和 {{v2}} 条通知。\n", { v0: permissionCount, v1: impact.counts.accessRequests, v2: impact.counts.notifications }) +
          tr("将保留 {{v0}} 条占用记录、{{v1}} 条反馈及 {{v2}} 条反馈活动和 {{v3}} 条审计记录，其中用户统一显示为“用户已删除”。", { v0: impact.counts.reservations, v1: impact.counts.feedbackTickets, v2: impact.counts.feedbackActivities, v3: impact.counts.auditLogs }),
        confirmLabel: tr("永久删除"),
        tone: "danger"
      }))) {
        return;
      }
      await api(`/admin/users/${user.id}`, {
        method: "DELETE",
        body: jsonBody({ expectedVersion: impact.user.version })
      });
      notify("success", tr("用户已永久删除"));
      await reload();
    } catch (error) {
      if (error instanceof EditCancelled) return;
      if (error instanceof ApiError && error.status === 409) {
        await reload();
      }
      notify(
        "error",
        error instanceof Error ? error.message : tr("删除用户失败")
      );
    }
  };
  const processProfileChange = async (
    user: any,
    action: "approve" | "reject"
  ) => {
    const request = user.pendingProfileChange;
    if (!request) return;
    let reason = "";
    if (action === "reject") {
      const enteredReason = await dialog.prompt({
        title: tr("不通过资料修改"),
        message: tr("确认不通过 {{v0}} 提交的资料修改？", { v0: user.displayName }),
        label: tr("原因（选填）"),
        multiline: true,
        maxLength: 500,
        confirmLabel: tr("确认不通过")
      });
      if (enteredReason === null) return;
      reason = enteredReason.trim();
    }
    try {
      await api(`/admin/profile-change-requests/${request.id}/${action}`, {
        method: "POST",
        body: jsonBody({
          expectedVersion: Number(request.expectedVersion),
          ...(action === "reject" ? { reason } : {})
        })
      });
      notify("success", action === "approve" ? tr("资料修改已通过") : tr("资料修改未通过"));
      await reload();
    } catch (error) {
      if (error instanceof EditCancelled) return;
      if (
        error instanceof ApiError &&
        error.code === "PROFILE_CHANGE_ALREADY_PROCESSED"
      ) {
        notify("error", tr("该资料修改已被处理，申请列表已刷新。"));
        await reload();
        return;
      }
      notify("error", error instanceof Error ? error.message : tr("处理失败"));
    }
  };
  const accountUsers = canManage
    ? users.filter((user) => ["ACTIVE", "DISABLED"].includes(user.status))
    : users;
  const applications = canManage ? [
    ...users
      .filter((user) =>
        ["PENDING_APPROVAL", "CHANGES_REQUESTED"].includes(user.status)
      )
      .map((user) => ({
        key: `registration-${user.id}`,
        type: "REGISTRATION" as const,
        user,
        submittedAt: user.lastSubmittedAt ?? user.createdAt
      })),
    ...accountUsers
      .filter((user) => user.pendingProfileChange)
      .map((user) => ({
        key: `profile-${user.pendingProfileChange.id}`,
        type: "PROFILE_CHANGE" as const,
        user,
        submittedAt: user.pendingProfileChange.requestedAt
      }))
  ].sort(
    (left, right) =>
      new Date(right.submittedAt).getTime() -
      new Date(left.submittedAt).getTime()
  ) : [];
  return (
    <div className="user-management-page">
      <PageHeader title={tr("用户管理")} />
      <div className="user-management-sections">
        <section className="card panel-card user-list-panel">
          <SectionHeader
            title={tr("用户列表")}
            actions={<span className="request-count">{accountUsers.length}</span>}
          />
          <div className="admin-table user-account-table">
            <div className={`admin-table-row user-account-row head${canManage ? "" : " directory"}`}>
              <span>{tr("用户")}</span><span>{tr("工号")}</span>
              {canManage && (
                <>
                  <span>{tr("邮箱")}</span>
                  <span>{tr("最后登录时间")}</span>
                  <span>{tr("状态")}</span>
                  <span />
                </>
              )}
              {!canManage && <span>{tr("状态")}</span>}
            </div>
            {accountUsers.map((user) => (
              <div
                className={`admin-table-row user-account-row${canManage ? "" : " directory"}`}
                key={user.id ?? user.username}
              >
                <div className="member-identity">
                  <div className="avatar small">{user.displayName.slice(0, 1)}</div>
                  <span>
                    <strong>{user.displayName}</strong>
                    <small>@{user.username}</small>
                  </span>
                </div>
                <strong className="user-account-employee-number">
                  {user.employeeNumber ?? tr("暂无工号")}
                </strong>
                {!canManage && (
                  <span className={`state-chip ${user.status.toLowerCase()}`}>
                    {userStatusLabel(user.status)}
                  </span>
                )}
                {canManage && (
                  <>
                    <span className="user-account-email" title={user.email || undefined}>
                      {user.email || tr("未填写邮箱")}
                    </span>
                    <time className="user-account-last-login">
                      {user.lastLoginAt
                        ? formatChinaFullMinute(user.lastLoginAt)
                        : tr("从未登录")}
                    </time>
                    <span className={`state-chip ${user.status.toLowerCase()}`}>
                      <span
                        title={
                          user.status === "DISABLED"
                            ? [
                              user.disabledAt
                                ? tr("停用于 {{v0}}", { v0: formatChinaFullMinute(user.disabledAt) })
                                : tr("账号已停用"),
                              user.disableReason || ""
                            ].filter(Boolean).join(" · ")
                            : undefined
                        }
                      >
                        {userStatusLabel(user.status)}
                      </span>
                    </span>
                    <div className="row-actions">
                      {user.status === "ACTIVE" && user.role !== "SYSTEM_ADMIN" && (
                        <button
                          type="button"
                          className="icon-button tiny list-icon-action danger"
                          title={tr("停用账号")}
                          aria-label={tr("停用 {{v0}} 并释放相关占用", { v0: user.displayName })}
                          onClick={() => void disableUser(user)}
                        >
                          <UserX size={14} />
                        </button>
                      )}
                      {user.status === "DISABLED" && (
                        <>
                          <button
                            type="button"
                            className="icon-button tiny list-icon-action approve"
                            title={tr("重新启用")}
                            aria-label={tr("重新启用 {{v0}}", { v0: user.displayName })}
                            onClick={() => void enableUser(user)}
                          >
                            <UserCheck size={14} />
                          </button>
                          {user.role !== "SYSTEM_ADMIN" && (
                            <button
                              type="button"
                              className="icon-button tiny list-icon-action danger destructive"
                              title={tr("永久删除用户")}
                              aria-label={tr("永久删除 {{v0}}", { v0: user.displayName })}
                              onClick={() => void deleteUser(user)}
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </>
                      )}
                      {user.status === "ACTIVE" &&
                        user.role !== "SYSTEM_ADMIN" && (
                          <button
                            type="button"
                            className="icon-button tiny list-icon-action"
                            title={tr("生成重置链接")}
                            aria-label={tr("为 {{v0}} 生成密码重置链接", { v0: user.displayName })}
                            onClick={async () => {
                              try {
                                const result = await api<{
                                  resetUrl: string;
                                  expiresAt: string;
                                }>(
                                  `/admin/users/${user.id}/password-reset-link`,
                                  {
                                    method: "POST",
                                    body: "{}"
                                  }
                                );
                                setPasswordResetLink({
                                  displayName: user.displayName,
                                  ...result
                                });
                              } catch (error) {
                                if (error instanceof EditCancelled) return;
                                notify(
                                  "error",
                                  error instanceof Error
                                    ? error.message
                                    : tr("重置链接生成失败")
                                );
                              }
                            }}
                          >
                            <KeyRound size={14} />
                          </button>
                        )}
                    </div>
                  </>
                )}
              </div>
            ))}
            {!accountUsers.length && <div className="mini-empty">{tr("暂无正式用户")}</div>}
          </div>
        </section>

        {applications.length > 0 && (
          <section className="card panel-card user-application-panel">
            <SectionHeader
              title={tr("申请列表")}
              actions={<span className="request-count">{applications.length}</span>}
            />
            <div className="user-application-list">
              <div className="user-application-row head">
                <span>{tr("申请人")}</span><span>{tr("工号")}</span><span>{tr("邮箱")}</span>
                <span>{tr("提交时间")}</span><span>{tr("状态")}</span><span />
              </div>
              {applications.map((application) => {
                const user = application.user;
                const profileRequest = user.pendingProfileChange;
                const isRegistration = application.type === "REGISTRATION";
                return (
                  <div className="user-application-row" key={application.key}>
                    <div className="member-identity">
                      <div className="avatar small">{user.displayName.slice(0, 1)}</div>
                      <span>
                        <strong>
                          {isRegistration ? user.displayName : profileRequest.displayName}
                        </strong>
                        <small className="application-user-meta">
                          <span>
                            {!isRegistration && profileRequest.displayName !== user.displayName
                              ? tr("原姓名：{{v0}} · @{{v1}}", { v0: user.displayName, v1: user.username })
                              : `@${user.username}`}
                          </span>
                          {isRegistration && (
                            <span className="application-new-user-tag">{tr("新用户")}</span>
                          )}
                        </small>
                      </span>
                    </div>
                    {!isRegistration && profileRequest.employeeNumber !== user.employeeNumber ? (
                      <div className="application-field-change">
                        <del>{user.employeeNumber || tr("无")}</del>
                        <ChevronRight size={13} />
                        <strong>{profileRequest.employeeNumber}</strong>
                      </div>
                    ) : (
                      <strong className="application-employee-number">
                        {isRegistration
                          ? user.pendingEmployeeNumber ?? user.employeeNumber ?? tr("未填写")
                          : profileRequest.employeeNumber}
                      </strong>
                    )}
                    <span className="application-email" title={user.email || undefined}>
                      {user.email || tr("未填写邮箱")}
                    </span>
                    <time>{formatChinaFullMinute(application.submittedAt)}</time>
                    <span className={`state-chip ${isRegistration && user.status === "CHANGES_REQUESTED"
                        ? "retiring"
                        : "pending"
                      }`}>
                      {isRegistration && user.status === "CHANGES_REQUESTED"
                        ? tr("待修改")
                        : tr("待审核")}
                    </span>
                    <div className="row-actions application-actions">
                      {isRegistration && (
                        <>
                          {user.status === "PENDING_APPROVAL" ? (
                            <>
                              <button
                                type="button"
                                className="icon-button tiny list-icon-action approve"
                                title={tr("通过注册")}
                                aria-label={tr("通过 {{v0}} 的注册", { v0: user.displayName })}
                                onClick={() => void processRegistration(
                                  () => api(`/admin/users/${user.id}/approve`, {
                                    method: "POST",
                                    body: jsonBody({
                                      expectedRevision: Number(user.applicationRevision)
                                    })
                                  }),
                                  tr("账号已批准")
                                )}
                              >
                                <Check size={15} />
                              </button>
                              <button
                                type="button"
                                className="icon-button tiny list-icon-action danger"
                                title={tr("不通过，要求修改")}
                                aria-label={tr("{{v0}} 的注册不通过，要求修改", { v0: user.displayName })}
                                onClick={async () => {
                                  const reason = await dialog.prompt({
                                    title: tr("要求修改注册信息"),
                                    message: tr("提交后，{{v0}} 可以更新资料并重新进入审核。", { v0: user.displayName }),
                                    label: tr("需要修改的内容（选填）"),
                                    multiline: true,
                                    maxLength: 500,
                                    confirmLabel: tr("发送要求")
                                  });
                                  if (reason === null) return;
                                  await processRegistration(
                                    () => api(`/admin/users/${user.id}/return`, {
                                      method: "POST",
                                      body: jsonBody({
                                        expectedRevision: Number(user.applicationRevision),
                                        reason: reason.trim()
                                      })
                                    }),
                                    tr("已要求用户修改注册信息")
                                  );
                                }}
                              >
                                <X size={15} />
                              </button>
                            </>
                          ) : (
                            <>
                              <span className="application-action-placeholder" aria-hidden="true" />
                              <span className="application-action-placeholder" aria-hidden="true" />
                            </>
                          )}
                          <button
                            type="button"
                            className="icon-button tiny list-icon-action danger destructive"
                            title={tr("拒绝注册")}
                            aria-label={tr("拒绝 {{v0}} 的注册", { v0: user.displayName })}
                            onClick={async () => {
                              const reason = await dialog.prompt({
                                title: tr("拒绝注册"),
                                message: tr("拒绝后将立即释放该用户占用的用户名、邮箱和工号。"),
                                label: tr("原因（选填）"),
                                multiline: true,
                                maxLength: 500,
                                confirmLabel: tr("确认拒绝"),
                                tone: "danger"
                              });
                              if (reason === null) return;
                              await processRegistration(
                                () => api(`/admin/users/${user.id}/reject`, {
                                  method: "POST",
                                  body: jsonBody({
                                    expectedRevision: Number(user.applicationRevision),
                                    reason: reason.trim()
                                  })
                                }),
                                tr("注册已拒绝")
                              );
                            }}
                          >
                            <Trash2 size={15} />
                          </button>
                        </>
                      )}
                      {!isRegistration && (
                        <>
                          <button
                            type="button"
                            className="icon-button tiny list-icon-action approve"
                            title={tr("通过资料修改")}
                            aria-label={tr("通过 {{v0}} 的资料修改", { v0: user.displayName })}
                            onClick={() => void processProfileChange(user, "approve")}
                          >
                            <Check size={15} />
                          </button>
                          <button
                            type="button"
                            className="icon-button tiny list-icon-action danger"
                            title={tr("不通过资料修改")}
                            aria-label={tr("不通过 {{v0}} 的资料修改", { v0: user.displayName })}
                            onClick={() => void processProfileChange(user, "reject")}
                          >
                            <X size={15} />
                          </button>
                          <span className="application-action-placeholder" aria-hidden="true" />
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
      {canManage && passwordResetLink && (
        <Modal
          title={tr("密码重置链接")}
          onClose={() => setPasswordResetLink(null)}
        >
          <div className="stack-form profile-edit-form">
            <AuthFeedback tone="warning" anchored={false}>
              {tr("请通过可信渠道将链接转交给")}{passwordResetLink.displayName}{tr("。关闭后无法再次查看。")}</AuthFeedback>
            <label className="field">
              <span>{tr("重置链接")}</span>
              <div className="copy-value-row">
                <input
                  readOnly
                  value={passwordResetLink.resetUrl}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={async () => {
                    try {
                      await copyTextToClipboard(passwordResetLink.resetUrl);
                      notify("success", tr("重置链接已复制"));
                    } catch {
                      notify("error", tr("复制失败，请手动复制链接"));
                    }
                  }}
                >
                  <Copy size={14} />
                  {tr("复制")}</button>
              </div>
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => setPasswordResetLink(null)}
              >
                {tr("完成")}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
