import { PageHeader } from "../../PageHeader";
import { tr } from "../../i18n/index";
import { UserCheck, Pencil, Copy, ShieldCheck, Mail, Info } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { api, jsonBody } from "../../api";
import { copyTextToClipboard } from "../../clipboard";
import { rememberUsername } from "../../login-preference";
import { formatChina, formatChinaFullMinute } from "../../date";
import type { DashboardBootstrap, AuthUser } from "../../shared/types";
import { userStatusLabel } from "../../ui-copy";
import { type RegistrationConfigPayload } from "../../shared/settings";
import { ApiTokenSection } from "./ApiTokenSection";
import { UsernameEditModal, IdentityEditModal, EmailEditModal } from "./ProfileEditModals";
import { PasswordChangeModal } from "./PasswordChangeModal";

export function AccountProfilePage({
  bootstrap,
  notify,
  reload
}: {
  bootstrap: DashboardBootstrap;
  notify: (kind: "success" | "error", message: string) => void;
  reload: () => Promise<void>;
}) {
  const [usernameOpen, setUsernameOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [registrationConfig, setRegistrationConfig] =
    useState<RegistrationConfigPayload | null>(null);
  const [emailPreferences, setEmailPreferences] = useState(
    bootstrap.user.emailPreferences
  );
  const [emailPreferenceSaving, setEmailPreferenceSaving] = useState<
    keyof AuthUser["emailPreferences"] | null
  >(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewCloseTimer = useRef<number | null>(null);
  const user = bootstrap.user;
  const editable = user.role !== "SYSTEM_ADMIN";
  const closeReviewLater = () => {
    if (reviewCloseTimer.current !== null) {
      window.clearTimeout(reviewCloseTimer.current);
    }
    reviewCloseTimer.current = window.setTimeout(() => setReviewOpen(false), 140);
  };
  const keepReviewOpen = () => {
    if (reviewCloseTimer.current !== null) {
      window.clearTimeout(reviewCloseTimer.current);
      reviewCloseTimer.current = null;
    }
    setReviewOpen(true);
  };
  useEffect(() => {
    setEmailPreferences(bootstrap.user.emailPreferences);
  }, [bootstrap.user.emailPreferences]);
  useEffect(() => {
    let active = true;
    void api<RegistrationConfigPayload>("/auth/registration-config")
      .then((result) => {
        if (active) setRegistrationConfig(result);
      })
      .catch(() => {
        if (active) setRegistrationConfig(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const updateEmailPreference = async (
    key: keyof AuthUser["emailPreferences"],
    enabled: boolean
  ) => {
    const next = { ...emailPreferences, [key]: enabled };
    setEmailPreferenceSaving(key);
    try {
      await api("/auth/email-preferences", {
        method: "PATCH",
        body: jsonBody(next)
      });
      setEmailPreferences(next);
      notify("success", tr("邮件接收设置已更新"));
      await reload();
    } catch (error) {
      notify(
        "error",
        error instanceof Error ? error.message : tr("邮件接收设置更新失败")
      );
    } finally {
      setEmailPreferenceSaving(null);
    }
  };
  const emailPreferenceOptions: Array<{
    key: keyof AuthUser["emailPreferences"];
    label: string;
    details: string[];
  }> = [
      {
        key: "reservationUpdates",
        label: tr("排期影响"),
        details: [
          tr("管理员取消或释放占用"),
          tr("维护、停用或删除影响排期")
        ]
      },
      {
        key: "administrationUpdates",
        label: tr("超时待办"),
        details: [tr("超过 15 分钟未处理的审核请求")]
      }
    ];

  return (
    <>
      <div className="page-shell narrow-page profile-layout">
        <PageHeader
          title={tr("用户信息")}
          actions={
            user.status === "PENDING_APPROVAL" ||
              user.status === "CHANGES_REQUESTED" ? (
              <span
                className={`state-chip ${user.status === "CHANGES_REQUESTED"
                    ? "retiring"
                    : "pending_approval"
                  }`}
              >
                {userStatusLabel(user.status)}
              </span>
            ) : undefined
          }
        />
        <section className="card profile-form-card">
          <div className="profile-section">
            <div className="profile-section-head">
              <div className="profile-section-title">
                <span className="profile-section-icon">
                  <UserCheck size={16} />
                </span>
                <h2>{tr("账号资料")}</h2>
              </div>
            </div>
            <div className="profile-fields-grid">
              <div className="profile-field profile-field-third">
                <div className="profile-field-head">
                  <span>{tr("用户名")}</span>
                  {editable && (
                    <button
                      type="button"
                      className="icon-button profile-edit"
                      title={tr("修改用户名")}
                      aria-label={tr("修改用户名")}
                      onClick={() => setUsernameOpen(true)}
                    >
                      <Pencil size={15} />
                    </button>
                  )}
                </div>
                <strong>{user.username}</strong>
              </div>
              <div className="profile-field profile-field-third">
                <div className="profile-field-head">
                  <span>{tr("姓名")}</span>
                  {editable && (
                    <button
                      type="button"
                      className="icon-button profile-edit"
                      title={user.pendingProfileChange ? tr("请先撤回待审修改") : tr("修改姓名和工号")}
                      aria-label={tr("修改姓名和工号")}
                      disabled={Boolean(user.pendingProfileChange)}
                      onClick={() => setIdentityOpen(true)}
                    >
                      <Pencil size={15} />
                    </button>
                  )}
                </div>
                <strong>{user.displayName}</strong>
              </div>
              <div className="profile-field profile-field-third">
                <div className="profile-field-head">
                  <span>{tr("工号")}</span>
                  <div className="profile-row-actions">
                    {user.pendingProfileChange && (
                      <div
                        className="profile-review-anchor"
                        onMouseEnter={keepReviewOpen}
                        onMouseLeave={closeReviewLater}
                        onFocus={keepReviewOpen}
                        onBlur={(event) => {
                          if (!event.currentTarget.contains(event.relatedTarget)) {
                            setReviewOpen(false);
                          }
                        }}
                      >
                        <button
                          type="button"
                          className="state-chip pending profile-review-chip"
                          aria-expanded={reviewOpen}
                        >
                          {tr("审核中")}</button>
                        {reviewOpen && (
                          <div className="profile-review-popover" role="dialog" aria-label={tr("待审资料")}>
                            <div><span>{tr("新姓名")}</span><strong>{user.pendingProfileChange.displayName}</strong></div>
                            <div><span>{tr("新工号")}</span><strong>{user.pendingProfileChange.employeeNumber}</strong></div>
                            <small>{tr("提交于")}{formatChina(user.pendingProfileChange.requestedAt)}</small>
                            <button
                              type="button"
                              className="text-action danger"
                              onClick={async () => {
                                try {
                                  await api(`/auth/profile-change-requests/${user.pendingProfileChange!.id}`, {
                                    method: "DELETE"
                                  });
                                  notify("success", tr("资料修改已撤回"));
                                  setReviewOpen(false);
                                  await reload();
                                } catch (error) {
                                  notify("error", error instanceof Error ? error.message : tr("撤回失败"));
                                  await reload();
                                }
                              }}
                            >
                              {tr("撤回")}</button>
                          </div>
                        )}
                      </div>
                    )}
                    {editable && (
                      <button
                        type="button"
                        className="icon-button profile-edit"
                        title={user.pendingProfileChange ? tr("请先撤回待审修改") : tr("修改姓名和工号")}
                        aria-label={tr("修改姓名和工号")}
                        disabled={Boolean(user.pendingProfileChange)}
                        onClick={() => setIdentityOpen(true)}
                      >
                        <Pencil size={15} />
                      </button>
                    )}
                  </div>
                </div>
                <strong>{user.employeeNumber ?? tr("不适用")}</strong>
              </div>
              <div className="profile-field profile-field-half">
                <div className="profile-field-head">
                  <span>{tr("邮箱")}</span>
                  {editable &&
                    (registrationConfig?.emailEnabled || user.email) && (
                      <button
                        type="button"
                        className="icon-button profile-edit"
                        title={tr("修改邮箱")}
                        aria-label={tr("修改邮箱")}
                        onClick={() => setEmailOpen(true)}
                      >
                        <Pencil size={15} />
                      </button>
                    )}
                </div>
                <strong title={user.email ?? undefined}>{user.email ?? tr("未设置")}</strong>
              </div>
              <div className="profile-field profile-field-half profile-id-cell">
                <div className="profile-field-head">
                  <span>{tr("账号 ID")}</span>
                  <button
                    type="button"
                    className="icon-button profile-edit"
                    title={tr("复制账号 ID")}
                    aria-label={tr("复制账号 ID")}
                    onClick={async () => {
                      try {
                        await copyTextToClipboard(user.id);
                        notify("success", tr("账号 ID 已复制"));
                      } catch {
                        notify("error", tr("复制失败，请手动选择账号 ID"));
                      }
                    }}
                  >
                    <Copy size={15} />
                  </button>
                </div>
                <code title={user.id}>{user.id}</code>
              </div>
            </div>
          </div>

          <div className="profile-section">
            <div className="profile-section-head">
              <div className="profile-section-title">
                <span className="profile-section-icon security">
                  <ShieldCheck size={16} />
                </span>
                <h2>{tr("登录与安全")}</h2>
              </div>
            </div>
            <div className="profile-security-grid">
              <div className="profile-field">
                <div className="profile-field-head">
                  <span>{tr("最近登录")}</span>
                </div>
                <strong>
                  {user.lastLoginAt
                    ? formatChinaFullMinute(user.lastLoginAt)
                    : tr("暂无记录")}
                </strong>
                {user.lastLoginIp && (
                  <span className="profile-field-meta">IP {user.lastLoginIp}</span>
                )}
              </div>
              <div className="profile-field">
                <div className="profile-field-head">
                  <span>{tr("密码")}</span>
                </div>
                <button
                  type="button"
                  className="secondary-button profile-password-action"
                  onClick={() => setPasswordOpen(true)}
                >
                  <Pencil size={13} />
                  {tr("修改密码")}</button>
              </div>
            </div>
          </div>

          <ApiTokenSection notify={notify} />

          {registrationConfig?.emailEnabled && user.email && (
            <div className="profile-section profile-email-preferences">
              <div className="profile-section-head">
                <div className="profile-section-title">
                  <span className="profile-section-icon mail">
                    <Mail size={16} aria-hidden="true" />
                  </span>
                  <h2>{tr("邮件通知")}</h2>
                </div>
              </div>
              <div className="profile-email-preferences-grid">
                <label
                  className="profile-email-preference profile-email-preference-locked"
                  tabIndex={0}
                >
                  <span className="profile-email-preference-label">
                    {tr("必要邮件")}
                    <Info size={12} aria-hidden="true" />
                  </span>
                  <input
                    type="checkbox"
                    checked
                    disabled
                    readOnly
                    aria-describedby="email-preference-required-detail"
                  />
                  <i className="profile-email-switch" aria-hidden="true">
                    <i />
                  </i>
                  <span
                    id="email-preference-required-detail"
                    className="profile-email-preference-detail"
                    role="tooltip"
                  >
                    <ul>
                      <li>{tr("验证码与密码重置")}</li>
                      <li>{tr("注册拒绝、退回或账号停用")}</li>
                    </ul>
                  </span>
                </label>
                {emailPreferenceOptions.map(({ key, label, details }) => (
                  <label className="profile-email-preference" key={key}>
                    <span className="profile-email-preference-label">
                      {label}
                      <Info size={12} aria-hidden="true" />
                    </span>
                    <input
                      type="checkbox"
                      checked={emailPreferences[key]}
                      disabled={emailPreferenceSaving !== null}
                      aria-describedby={`email-preference-${key}-detail`}
                      onChange={(event) =>
                        void updateEmailPreference(key, event.target.checked)
                      }
                    />
                    <i className="profile-email-switch" aria-hidden="true">
                      <i />
                    </i>
                    <span
                      id={`email-preference-${key}-detail`}
                      className="profile-email-preference-detail"
                      role="tooltip"
                    >
                      <ul>
                        {details.map((detail) => (
                          <li key={detail}>{detail}</li>
                        ))}
                      </ul>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
      {usernameOpen && (
        <UsernameEditModal
          currentUsername={user.username}
          onClose={() => setUsernameOpen(false)}
          onSaved={async (username) => {
            rememberUsername(username, false);
            setUsernameOpen(false);
            notify("success", tr("用户名已更新"));
            await reload();
          }}
        />
      )}
      {identityOpen && user.employeeNumber && (
        <IdentityEditModal
          displayName={user.displayName}
          employeeNumber={user.employeeNumber}
          registrationPending={user.status !== "ACTIVE"}
          onClose={() => setIdentityOpen(false)}
          onSubmitted={async () => {
            setIdentityOpen(false);
            notify(
              "success",
              user.status === "ACTIVE"
                ? tr("资料修改已提交审核")
                : tr("资料已更新，注册信息已重新提交")
            );
            await reload();
          }}
        />
      )}
      {emailOpen && (
        <EmailEditModal
          currentEmail={user.email}
          notify={notify}
          onClose={() => setEmailOpen(false)}
          onSaved={async () => {
            setEmailOpen(false);
            notify("success", tr("邮箱已更新"));
            await reload();
          }}
        />
      )}
      {passwordOpen && (
        <PasswordChangeModal
          username={user.username}
          employeeNumber={user.employeeNumber}
          onClose={() => setPasswordOpen(false)}
          onSaved={async () => {
            setPasswordOpen(false);
            notify("success", tr("密码已更新"));
            await reload();
          }}
        />
      )}
    </>
  );
}
