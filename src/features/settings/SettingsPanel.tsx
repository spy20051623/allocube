import { PageHeader } from "../../PageHeader";
import { tr } from "../../i18n/index";
import { RefreshCw, Clock3, Globe2, Mail, CircleAlert, ShieldCheck, X, Settings } from "lucide-react";
import { formatChina } from "../../date";
import { SectionHeader } from "../../components/SectionHeader";
import { Field, ChoiceField } from "../../components/forms";
import { BusyButtonContent, ContextNotice } from "../../components/feedback";
import { PasswordField } from "../../components/PasswordFields";
import { useSettingsController } from "./useSettingsController";

export function SettingsPanel({
  notify
}: {
  notify: (kind: "success" | "error", message: string) => void;
}) {
  const {
    settingsReadError,
    refreshSettings,
    settingsUncertain,
    adminSettings,
    smtp,
    settingsWriting,
    bookingForm,
    setBookingForm,
    savingBooking,
    bookingDirty,
    saveBookingSettings,
    siteOriginError,
    siteOrigin,
    setSiteOrigin,
    setSiteOriginError,
    saveSiteProfile,
    icpFilingError,
    icpFilingNumber,
    setIcpFilingNumber,
    setIcpFilingError,
    publicSecurityFilingError,
    publicSecurityFilingNumber,
    setPublicSecurityFilingNumber,
    setPublicSecurityFilingError,
    savingSiteProfile,
    siteProfileDirty,
    smtpForm,
    togglingSmtp,
    toggleSmtp,
    togglingEmptyEmail,
    toggleEmptyRegistrationEmail,
    emailDomainError,
    emailDomainInput,
    setEmailDomainInput,
    setEmailDomainError,
    appendEmailDomain,
    savingEmailDomains,
    allowedEmailDomains,
    removeEmailDomain,
    setSmtpForm,
    smtpPassword,
    clearPassword,
    setSmtpPassword,
    smtpDirty,
    testRecipient,
    setTestRecipient,
    testingSmtp,
    testSmtp,
    setClearPassword,
    savingSmtp,
    saveSmtp
  } = useSettingsController({ notify });

  return (
    <div className="settings-management-page">
      <PageHeader title={tr("系统设置")} />
      {settingsReadError && <div className="context-notice warning" role="alert">
        <span>{settingsReadError}</span>
        <button className="secondary-button" onClick={() => void refreshSettings()}>{tr("重试")}</button>
      </div>}
      {settingsUncertain && <div className="context-notice warning" role="alert">
        <span>{tr("操作结果未确认，请手动刷新页面后核对。输入已保留。")}</span>
      </div>}
      {(!adminSettings || !smtp) ? <div className="content-loading" role="status"><RefreshCw className="spin" />{tr("正在载入")}</div> :
        <fieldset className="settings-page" disabled={settingsWriting} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <section className="settings-card card" aria-labelledby="booking-settings-title">
            <SectionHeader
              id="booking-settings-title"
              title={tr("资源占用规则")}
              leadingIcon={Clock3}
              className="settings-intro"
            />
            <div className="settings-fields">
              <Field label={tr("最短占用时长（分钟）")}><input type="number" min={1} value={bookingForm.minBookingMinutes} onChange={(e) => setBookingForm({ ...bookingForm, minBookingMinutes: Number(e.target.value) })} /><small>{tr("自动拆分时，小于该值的时段会被丢弃。")}</small></Field>
              <Field label={tr("单次最长时长（分钟）")}><input type="number" min={1} value={bookingForm.maxBookingMinutes} onChange={(e) => setBookingForm({ ...bookingForm, maxBookingMinutes: Number(e.target.value) })} /></Field>
              <Field label={tr("最远可占用天数")}><input type="number" min={1} value={bookingForm.advanceDays} onChange={(e) => setBookingForm({ ...bookingForm, advanceDays: Number(e.target.value) })} /><small>{tr("以占用结束时间为准。")}</small></Field>
            </div>
            <div className="settings-card-footer">
              <ContextNotice className="settings-rule-note">
                {tr("保存后仅影响新的占用，不会改变已经确认的占用。")}</ContextNotice>
              <button
                className="primary-button"
                disabled={settingsUncertain || !adminSettings || savingBooking || !bookingDirty}
                onClick={() => void saveBookingSettings()}
              >
                {tr("保存规则")}</button>
            </div>
          </section>
          <section
            className="settings-card site-profile-settings-card card"
            aria-labelledby="site-profile-settings-title"
          >
            <SectionHeader
              id="site-profile-settings-title"
              title={tr("站点信息")}
              leadingIcon={Globe2}
              className="settings-intro"
            />
            <div className="site-profile-fields">
              <label
                className={`field site-profile-field site-profile-origin${siteOriginError ? " has-error" : ""
                  }`}
              >
                <span>{tr("站点地址")}</span>
                <input
                  name="site-origin"
                  placeholder="https://allocube.your-company.com"
                  value={siteOrigin}
                  aria-invalid={Boolean(siteOriginError)}
                  onChange={(event) => {
                    setSiteOrigin(event.target.value);
                    setSiteOriginError("");
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key !== "Enter" ||
                      event.nativeEvent.isComposing
                    ) {
                      return;
                    }
                    event.preventDefault();
                    void saveSiteProfile();
                  }}
                />
                {siteOriginError && (
                  <small className="field-inline-error" role="alert">
                    {siteOriginError}
                  </small>
                )}
              </label>
              <label
                className={`field site-profile-field${icpFilingError ? " has-error" : ""
                  }`}
              >
                <span>{tr("ICP备案号（选填）")}</span>
                <input
                  name="icp-filing-number"
                  placeholder={tr("省ICP备12345678号-1")}
                  maxLength={100}
                  value={icpFilingNumber}
                  aria-invalid={Boolean(icpFilingError)}
                  onChange={(event) => {
                    setIcpFilingNumber(event.target.value);
                    setIcpFilingError("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.nativeEvent.isComposing) {
                      return;
                    }
                    event.preventDefault();
                    void saveSiteProfile();
                  }}
                />
                {icpFilingError && (
                  <small className="field-inline-error" role="alert">
                    {icpFilingError}
                  </small>
                )}
              </label>
              <label
                className={`field site-profile-field${publicSecurityFilingError ? " has-error" : ""
                  }`}
              >
                <span>{tr("公安备案号（选填）")}</span>
                <input
                  name="public-security-filing-number"
                  placeholder={tr("省公网安备 11000000000000号")}
                  maxLength={100}
                  value={publicSecurityFilingNumber}
                  aria-invalid={Boolean(publicSecurityFilingError)}
                  onChange={(event) => {
                    setPublicSecurityFilingNumber(event.target.value);
                    setPublicSecurityFilingError("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.nativeEvent.isComposing) {
                      return;
                    }
                    event.preventDefault();
                    void saveSiteProfile();
                  }}
                />
                {publicSecurityFilingError && (
                  <small className="field-inline-error" role="alert">
                    {publicSecurityFilingError}
                  </small>
                )}
              </label>
            </div>
            <div className="settings-card-footer site-profile-footer">
              <button
                type="button"
                className="primary-button"
                disabled={settingsUncertain ||
                  !adminSettings || savingSiteProfile || !siteProfileDirty
                }
                onClick={() => void saveSiteProfile()}
              >
                {savingSiteProfile ? tr("保存中") : tr("保存站点信息")}
              </button>
            </div>
          </section>
          <section
            className={`settings-card smtp-settings-card card${smtp && !smtpForm.enabled ? " is-disabled" : ""
              }`}
            aria-labelledby="smtp-settings-title"
          >
            <SectionHeader
              id="smtp-settings-title"
              title={tr("邮件服务")}
              leadingIcon={Mail}
              className="settings-intro"
              actions={smtp ? (
                <div className="smtp-header-controls">
                  <span
                    className={`smtp-state ${!smtpForm.enabled
                        ? "off"
                        : smtp.operational
                          ? "ready"
                          : "warning"
                      }`}
                  >
                    {togglingSmtp
                      ? smtpForm.enabled
                        ? tr("正在启用")
                        : tr("正在停用")
                      : !smtp.enabled
                        ? tr("status.disabled")
                        : smtp.operational
                          ? tr("运行正常")
                          : tr("配置不可用")}
                  </span>
                  <label className="settings-toggle-control">
                    <strong>{tr("启用邮件服务")}</strong>
                    <input
                      type="checkbox"
                      checked={smtpForm.enabled}
                      disabled={settingsUncertain || togglingSmtp}
                      aria-busy={togglingSmtp}
                      onChange={(event) => void toggleSmtp(event.target.checked)}
                    />
                    <i className="settings-toggle" aria-hidden="true"><i /></i>
                  </label>
                </div>
              ) : undefined}
            />
            {smtp ? (
              <div className="smtp-settings-body">
                <div className="smtp-summary" aria-label={tr("邮件服务状态摘要")}>
                  <div><span>{tr("等待发送")}</span><strong>{smtp.queue.pending}</strong></div>
                  <div><span>{tr("发送失败")}</span><strong>{smtp.queue.failed}</strong></div>
                  <div><span>{tr("密码状态")}</span><strong>{smtp.passwordStatus === "READY" ? tr("已安全保存") : smtp.passwordStatus === "UNREADABLE" ? tr("需要重新输入") : tr("尚未设置")}</strong></div>
                  <div><span>{tr("最近测试")}</span><strong>{smtp.lastTest ? (smtp.lastTest.status === "SUCCESS" ? tr("成功") : tr("失败")) : tr("尚未测试")}</strong></div>
                </div>
                {(smtp.lastTest?.error || smtp.queue.lastError) && (
                  <div className="smtp-warning" role="alert">
                    <CircleAlert size={16} />
                    <span>{smtp.lastTest?.error || smtp.queue.lastError}</span>
                  </div>
                )}
                <div className="mail-service-section registration-email-section">
                  <div className="mail-service-section-heading">
                    <ShieldCheck size={16} />
                    <strong>{tr("注册邮箱")}</strong>
                  </div>
                  <div className="email-domain-settings">
                    <div className="registration-email-policy">
                      <span className="registration-email-field-title">{tr("邮箱要求")}</span>
                      <div className="registration-email-policy-control">
                        <strong>{tr("允许空邮箱")}</strong>
                        <label className="settings-toggle-control">
                          <input
                            type="checkbox"
                            aria-label={tr("允许空邮箱")}
                            checked={Boolean(
                              adminSettings?.allowRegistrationWithoutEmail
                            )}
                            disabled={settingsUncertain || !adminSettings || togglingEmptyEmail}
                            aria-busy={togglingEmptyEmail}
                            onChange={(event) =>
                              void toggleEmptyRegistrationEmail(event.target.checked)
                            }
                          />
                          <i className="settings-toggle" aria-hidden="true"><i /></i>
                        </label>
                      </div>
                    </div>
                    <div className="registration-email-domains">
                      <label className="registration-email-field-title" htmlFor="allowed-email-domain">
                        {tr("邮箱域名白名单")}</label>
                      <div
                        className={`email-domain-entry${emailDomainError ? " is-invalid" : ""
                          }`}
                      >
                        <input
                          id="allowed-email-domain"
                          name="allowed-email-domain"
                          aria-label={tr("邮箱域名")}
                          placeholder="example.com"
                          value={emailDomainInput}
                          aria-invalid={Boolean(emailDomainError)}
                          aria-describedby={
                            emailDomainError ? "email-domain-error" : undefined
                          }
                          onChange={(event) => {
                            setEmailDomainInput(event.target.value);
                            setEmailDomainError("");
                          }}
                          onKeyDown={(event) => {
                            if (
                              event.key !== "Enter" ||
                              event.nativeEvent.isComposing
                            ) {
                              return;
                            }
                            event.preventDefault();
                            void appendEmailDomain();
                          }}
                        />
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={settingsUncertain || !emailDomainInput.trim() || savingEmailDomains}
                          onClick={() => void appendEmailDomain()}
                        >
                          {savingEmailDomains ? tr("处理中") : tr("添加")}
                        </button>
                      </div>
                      {emailDomainError && (
                        <div
                          id="email-domain-error"
                          className="email-domain-error"
                          role="alert"
                        >
                          {emailDomainError}
                        </div>
                      )}
                      {allowedEmailDomains.length > 0 && (
                        <div className="email-domain-list" aria-label={tr("邮箱域名白名单")}>
                          {allowedEmailDomains.map((domain) => (
                            <span className="email-domain-token" key={domain}>
                              <span>{domain}</span>
                              <button
                                type="button"
                                disabled={settingsUncertain || savingEmailDomains}
                                aria-label={tr("移除邮箱域名 {{v0}}", { v0: domain })}
                                onClick={() => void removeEmailDomain(domain)}
                              >
                                <X size={12} />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div className="mail-service-section smtp-configuration-section">
                  <div className="mail-service-section-heading">
                    <Settings size={16} />
                    <strong>{tr("发送配置")}</strong>
                  </div>
                  <div className="smtp-form-grid">
                    <div className="smtp-connection-fields">
                      <Field label={tr("SMTP 服务器")}>
                        <input
                          name="smtp-host"
                          value={smtpForm.host}
                          onChange={(event) =>
                            setSmtpForm({ ...smtpForm, host: event.target.value })
                          }
                        />
                      </Field>
                      <div className="smtp-connection-options">
                        <Field label={tr("端口")}>
                          <input
                            name="smtp-port"
                            type="number"
                            min={1}
                            max={65535}
                            value={smtpForm.port}
                            onChange={(event) =>
                              setSmtpForm({ ...smtpForm, port: Number(event.target.value) })
                            }
                          />
                        </Field>
                        <ChoiceField
                          label={tr("连接加密")}
                          name="smtp-security"
                          value={smtpForm.security}
                          options={[
                            { value: "IMPLICIT_TLS", label: "SSL/TLS" },
                            { value: "STARTTLS", label: "STARTTLS" }
                          ]}
                          onChange={(value) =>
                            setSmtpForm({
                              ...smtpForm,
                              security: value as "IMPLICIT_TLS" | "STARTTLS"
                            })
                          }
                        />
                      </div>
                    </div>
                    <div className="smtp-paired-fields">
                      <Field label={tr("SMTP 登录账号")}>
                        <input
                          name="smtp-username"
                          autoComplete="off"
                          value={smtpForm.username}
                          onChange={(event) =>
                            setSmtpForm({ ...smtpForm, username: event.target.value })
                          }
                        />
                      </Field>
                      <PasswordField
                        label={tr("SMTP 密码")}
                        name="smtp-password"
                        autoComplete="new-password"
                        value={smtpPassword}
                        disabled={clearPassword}
                        onChange={(event) => setSmtpPassword(event.target.value)}
                        placeholder={
                          smtp.passwordStatus === "UNREADABLE"
                            ? tr("请重新输入密码")
                            : smtp.hasPassword && !clearPassword
                              ? tr("已保存密码")
                              : ""
                        }
                      />
                    </div>
                    <div className="smtp-paired-fields">
                      <Field label={tr("发件人名称")}>
                        <input
                          name="smtp-from-name"
                          value={smtpForm.fromName}
                          onChange={(event) =>
                            setSmtpForm({ ...smtpForm, fromName: event.target.value })
                          }
                        />
                      </Field>
                      <Field label={tr("发件邮箱")}>
                        <input
                          name="smtp-from-address"
                          type="email"
                          value={smtpForm.fromAddress}
                          onChange={(event) =>
                            setSmtpForm({ ...smtpForm, fromAddress: event.target.value })
                          }
                        />
                      </Field>
                    </div>
                  </div>
                  <div className="smtp-test">
                    <div className="smtp-test-copy">
                      <strong>{tr("发送测试邮件")}</strong>
                    </div>
                    <div
                      className="smtp-test-control"
                      title={smtpDirty ? tr("请先保存当前修改") : undefined}
                    >
                      <input
                        type="email"
                        value={testRecipient}
                        onChange={(event) => setTestRecipient(event.target.value)}
                        aria-label={tr("测试收件地址")}
                      />
                      <button
                        className="secondary-button async-button smtp-test-button"
                        disabled={settingsUncertain || smtpDirty || !smtp.testable || !testRecipient || testingSmtp}
                        aria-busy={testingSmtp}
                        aria-label={smtpDirty ? tr("发送测试，请先保存当前修改") : tr("发送测试")}
                        onClick={testSmtp}
                      >
                        <BusyButtonContent busy={testingSmtp}>{tr("发送测试")}</BusyButtonContent>
                      </button>
                    </div>
                  </div>
                  <div className="settings-card-footer smtp-footer">
                    <div className="smtp-footer-meta">
                      {smtp.hasPassword && (
                        <button
                          className="text-action danger smtp-password-action"
                          disabled={smtpForm.enabled}
                          onClick={() => {
                            setClearPassword((current) => !current);
                            setSmtpPassword("");
                          }}
                        >
                          {clearPassword ? tr("保留现有密码") : tr("清除已保存密码")}
                        </button>
                      )}
                      <span className="smtp-updated-at">
                        {tr("更新于")}{formatChina(smtp.updatedAt, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}
                      </span>
                    </div>
                    <button
                      className="primary-button async-button smtp-save-button"
                      disabled={settingsUncertain || savingSmtp}
                      aria-busy={savingSmtp}
                      aria-label={tr("保存邮件配置")}
                      onClick={saveSmtp}
                    >
                      <BusyButtonContent busy={savingSmtp}>{tr("保存邮件配置")}</BusyButtonContent>
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mini-empty">{tr("正在加载邮件配置…")}</div>
            )}
          </section>
        </fieldset>}
    </div>
  );
}
