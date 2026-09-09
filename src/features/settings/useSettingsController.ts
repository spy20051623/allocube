import { hasUncertainEdit, claimEdit, EditCancelled, markEditUncertain } from "../../edit-conflict";
import { useRealtimeRefresh } from "../../useRealtimeRefresh";
import {
  SettingsRequestGate,
  SettingsSaveCancelled,
  validateSettingsResponse,
  smtpConfigurationIsDirty,
  olderSettingsVersion
} from "../../settings-state";
import { withRequestDeadline } from "../../request-deadline";
import { tr, trDynamic } from "../../i18n/index";
import { useRef, useState, useEffect, useCallback } from "react";
import { api, jsonBody, ApiError } from "../../api";
import { normalizeAllowedEmailDomain, EMAIL_DOMAIN_MESSAGE } from "../../shared/email-domain-rules";
import { siteOriginValidationError, normalizeSiteOrigin } from "../../shared/site-origin";
import { icpFilingValidationError } from "../../shared/icp-filing";
import { publicSecurityFilingValidationError } from "../../shared/public-security-filing";
import { useAppDialog } from "../../components/dialogs";
import { type AdminSettingsPayload, type SmtpSettingsPayload } from "../../shared/settings";

export function useSettingsController({
  notify
}: {
  notify: (kind: "success" | "error", message: string) => void;
}) {
  const dialog = useAppDialog();
  const settingsVersions = useRef<Record<string, number>>({});
  const settingsGate = useRef(new SettingsRequestGate());
  const settingsMounted = useRef(true);
  const settingsRetry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsRetryAttempt = useRef(0);
  const settingsRefreshRef = useRef<() => Promise<unknown>>(async () => undefined);
  const [settingsReadError, setSettingsReadError] = useState("");
  const [settingsWriting, setSettingsWriting] = useState(false);
  const settingsWriteController = useRef<AbortController | null>(null);
  const [settingsUncertain, setSettingsUncertain] = useState(() => hasUncertainEdit([
    "/admin/settings", "/admin/settings/site-profile", "/admin/settings/email-domains",
    "/admin/settings/registration-email", "/admin/smtp-settings", "/admin/smtp-settings/test"
  ]));
  const [settingsWriteEpoch, setSettingsWriteEpoch] = useState(0);
  useEffect(() => {
    settingsMounted.current = true;
    return () => {
      settingsMounted.current = false;
      settingsWriteController.current?.abort();
      settingsGate.current.invalidate();
      if (settingsRetry.current) clearTimeout(settingsRetry.current);
    };
  }, []);
  const [bookingForm, setBookingForm] = useState({
    minBookingMinutes: 1,
    maxBookingMinutes: 1440,
    advanceDays: 30,
    blockAdminBookings: false
  });
  const [adminSettings, setAdminSettings] =
    useState<AdminSettingsPayload | null>(null);
  const [allowedEmailDomains, setAllowedEmailDomains] = useState<string[]>([]);
  const [emailDomainInput, setEmailDomainInput] = useState("");
  const [emailDomainError, setEmailDomainError] = useState("");
  const [siteOrigin, setSiteOrigin] = useState("");
  const [siteOriginError, setSiteOriginError] = useState("");
  const [icpFilingNumber, setIcpFilingNumber] = useState("");
  const [icpFilingError, setIcpFilingError] = useState("");
  const [publicSecurityFilingNumber, setPublicSecurityFilingNumber] =
    useState("");
  const [publicSecurityFilingError, setPublicSecurityFilingError] =
    useState("");
  const [savingBooking, setSavingBooking] = useState(false);
  const [savingEmailDomains, setSavingEmailDomains] = useState(false);
  const [togglingEmptyEmail, setTogglingEmptyEmail] = useState(false);
  const [savingSiteProfile, setSavingSiteProfile] = useState(false);
  const [smtp, setSmtp] = useState<SmtpSettingsPayload | null>(null);
  const [smtpForm, setSmtpForm] = useState({
    enabled: false,
    host: "",
    port: 465,
    security: "IMPLICIT_TLS" as "IMPLICIT_TLS" | "STARTTLS",
    username: "",
    fromName: "Allocube",
    fromAddress: ""
  });
  const [smtpPassword, setSmtpPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [testRecipient, setTestRecipient] = useState("");
  const [savingSmtp, setSavingSmtp] = useState(false);
  const [togglingSmtp, setTogglingSmtp] = useState(false);
  const [testingSmtp, setTestingSmtp] = useState(false);

  const applySmtpSettings = useCallback((value: SmtpSettingsPayload) => {
    settingsVersions.current["/admin/smtp-settings"] = value.version;
    setSmtp(value);
    setSmtpForm({
      enabled: value.enabled,
      host: value.host,
      port: value.port,
      security: value.security,
      username: value.username,
      fromName: value.fromName,
      fromAddress: value.fromAddress
    });
    setSmtpPassword("");
    setClearPassword(false);
  }, []);

  const applyAdminSettings = useCallback((value: AdminSettingsPayload) => {
    for (const path of ["/admin/settings", "/admin/settings/site-profile", "/admin/settings/email-domains", "/admin/settings/registration-email"]) {
      settingsVersions.current[path] = value.version;
    }
    setAdminSettings(value);
    setBookingForm({
      minBookingMinutes: value.minBookingMinutes,
      maxBookingMinutes: value.maxBookingMinutes,
      advanceDays: value.advanceDays,
      blockAdminBookings: value.blockAdminBookings
    });
    setAllowedEmailDomains(value.allowedEmailDomains);
    setSiteOrigin(value.siteOrigin);
    setIcpFilingNumber(value.icpFilingNumber);
    setPublicSecurityFilingNumber(value.publicSecurityFilingNumber);
    setSiteOriginError("");
    setIcpFilingError("");
    setPublicSecurityFilingError("");
    setEmailDomainInput("");
    setEmailDomainError("");
  }, []);

  // Each dirty section retains the version it was edited against, even if another section saves.
  const applySavedAdminSettings = (value: AdminSettingsPayload, savedPath: string) => {
    setAdminSettings(value);
    const adopt = (path: string, dirty: boolean) => {
      if (path !== savedPath && dirty) return false;
      settingsVersions.current[path] = value.version;
      return true;
    };
    if (adopt("/admin/settings", bookingDirty)) {
      setBookingForm({ minBookingMinutes: value.minBookingMinutes, maxBookingMinutes: value.maxBookingMinutes, advanceDays: value.advanceDays, blockAdminBookings: value.blockAdminBookings });
    }
    if (adopt("/admin/settings/site-profile", siteProfileDirty)) {
      setSiteOrigin(value.siteOrigin); setIcpFilingNumber(value.icpFilingNumber);
      setPublicSecurityFilingNumber(value.publicSecurityFilingNumber);
    }
    if (adopt("/admin/settings/email-domains", Boolean(emailDomainInput))) setAllowedEmailDomains(value.allowedEmailDomains);
    settingsVersions.current["/admin/settings/registration-email"] = value.version;
  };

  const settingsApi = async <T,>(path: string, options: RequestInit): Promise<T> => {
    if (settingsUncertain || !adminSettings || !smtp) {
      throw new Error(tr("请刷新页面后核对设置"));
    }
    if (!settingsGate.current.beginWrite()) throw new Error(tr("正在保存，请稍候"));
    setSettingsWriting(true);
    const controller = new AbortController(); settingsWriteController.current = controller;
    let release: (() => unknown) | undefined;
    try {
      release = claimEdit(path);
      const body = JSON.parse(String(options.body));
      if (options.method === "PATCH") body.expectedVersion = settingsVersions.current[path] ?? body.expectedVersion;
      const send = (overwrite = false) => withRequestDeadline(signal => api<T>(path, {
        ...options, body: jsonBody({ ...body, ...(overwrite ? { overwrite: true } : {}) }), signal
      }), controller.signal);
      let result: T;
      try {
        result = await send();
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409 || options.method !== "PATCH") throw error;
        if (!settingsMounted.current || controller.signal.aborted) throw new SettingsSaveCancelled();
        const confirmed = await dialog.confirm({
          signal: controller.signal,
          title: tr("设置已更新"),
          message: tr("设置已在其他页面或设备更新。是否用本次提交的内容覆盖对应设置？取消将保留当前草稿。"),
          confirmLabel: tr("确认覆盖"),
          tone: "danger"
        });
        if (!confirmed || !settingsMounted.current) throw new SettingsSaveCancelled();
        // The payload stays fixed while confirmation is open; never replay an ambiguous write.
        result = await send(true);
      }
      if (path !== "/admin/smtp-settings/test") validateSettingsResponse((result as { settings: unknown })?.settings, path === "/admin/smtp-settings");
      return result;
    } catch (error) {
      if (error instanceof SettingsSaveCancelled || error instanceof EditCancelled) throw new SettingsSaveCancelled();
      if (!(error instanceof ApiError) || error.status >= 500) {
        markEditUncertain(path);
        if (settingsMounted.current) setSettingsUncertain(true);
        throw new Error(tr("操作结果未确认，请手动刷新页面后核对。输入已保留。"));
      }
      throw error;
    } finally {
      release?.();
      settingsGate.current.endWrite();
      setSettingsWriting(false);
      setSettingsWriteEpoch(value => value + 1);
    }
  };

  const updateEmailDomains = async (
    nextDomains: string[],
    successMessage: string,
    showFieldError = false
  ) => {
    if (!adminSettings || savingEmailDomains) return false;
    setSavingEmailDomains(true);
    try {
      const result = await settingsApi<{ settings: AdminSettingsPayload }>(
        "/admin/settings/email-domains",
        {
          method: "PATCH",
          body: jsonBody({
            allowedEmailDomains: nextDomains,
            expectedVersion: adminSettings.version
          })
        }
      );
      applySavedAdminSettings(result.settings, "/admin/settings/email-domains");
      setAllowedEmailDomains(result.settings.allowedEmailDomains);
      setEmailDomainError("");
      notify("success", successMessage);
      return true;
    } catch (error) {
      if (error instanceof SettingsSaveCancelled) return false;
      const message = error instanceof Error ? error.message : tr("更新白名单失败");
      if (showFieldError) setEmailDomainError(message);
      notify("error", message);
      return false;
    } finally {
      setSavingEmailDomains(false);
    }
  };

  const appendEmailDomain = async () => {
    if (!emailDomainInput.trim() || savingEmailDomains) return;
    try {
      const domain = normalizeAllowedEmailDomain(emailDomainInput);
      if (allowedEmailDomains.includes(domain)) {
        setEmailDomainError(tr("该邮箱域名已经在白名单中"));
        return;
      }
      if (allowedEmailDomains.length >= 100) {
        setEmailDomainError(tr("最多可以配置100个邮箱域名"));
        return;
      }
      const next = [...allowedEmailDomains, domain];
      if (await updateEmailDomains(next, tr("邮箱域名已添加"), true)) {
        setEmailDomainInput("");
      }
    } catch {
      setEmailDomainError(tr(EMAIL_DOMAIN_MESSAGE));
    }
  };

  const removeEmailDomain = async (domain: string) => {
    if (savingEmailDomains) return;
    await updateEmailDomains(
      allowedEmailDomains.filter((item) => item !== domain),
      tr("邮箱域名已移除")
    );
  };

  const saveBookingSettings = async () => {
    if (!adminSettings || savingBooking) return;
    setSavingBooking(true);
    try {
      const result = await settingsApi<{ settings: AdminSettingsPayload }>(
        "/admin/settings",
        {
          method: "PATCH",
          body: jsonBody({
            ...bookingForm,
            expectedVersion: adminSettings.version
          })
        }
      );
      applySavedAdminSettings(result.settings, "/admin/settings");
      setBookingForm({
        minBookingMinutes: result.settings.minBookingMinutes,
        maxBookingMinutes: result.settings.maxBookingMinutes,
        advanceDays: result.settings.advanceDays,
        blockAdminBookings: result.settings.blockAdminBookings
      });
      notify("success", tr("全局占用规则已更新"));
    } catch (error) {
      if (error instanceof SettingsSaveCancelled) return;
      notify("error", error instanceof Error ? error.message : tr("保存失败"));
    } finally {
      setSavingBooking(false);
    }
  };

  const saveSiteProfile = async () => {
    if (!adminSettings || savingSiteProfile) return;
    const normalizedSiteOrigin = siteOrigin.trim();
    const normalizedIcpFiling = icpFilingNumber.trim();
    const normalizedPublicSecurityFiling =
      publicSecurityFilingNumber.trim();
    const rawOriginIssue = siteOriginValidationError(normalizedSiteOrigin);
    const rawIcpIssue = icpFilingValidationError(normalizedIcpFiling);
    const rawPublicSecurityIssue = publicSecurityFilingValidationError(
      normalizedPublicSecurityFiling
    );
    const originIssue = rawOriginIssue ? trDynamic(rawOriginIssue) : null;
    const icpIssue = rawIcpIssue ? trDynamic(rawIcpIssue) : null;
    const publicSecurityIssue = rawPublicSecurityIssue
      ? trDynamic(rawPublicSecurityIssue)
      : null;
    setSiteOriginError(originIssue ?? "");
    setIcpFilingError(icpIssue ?? "");
    setPublicSecurityFilingError(publicSecurityIssue ?? "");
    if (originIssue || icpIssue || publicSecurityIssue) return;

    setSavingSiteProfile(true);
    try {
      const result = await settingsApi<{ settings: AdminSettingsPayload }>(
        "/admin/settings/site-profile",
        {
          method: "PATCH",
          body: jsonBody({
            siteOrigin: normalizeSiteOrigin(normalizedSiteOrigin),
            icpFilingNumber: normalizedIcpFiling,
            publicSecurityFilingNumber:
              normalizedPublicSecurityFiling,
            expectedVersion: adminSettings.version
          })
        }
      );
      applySavedAdminSettings(result.settings, "/admin/settings/site-profile");
      setSiteOrigin(result.settings.siteOrigin);
      setIcpFilingNumber(result.settings.icpFilingNumber);
      setPublicSecurityFilingNumber(
        result.settings.publicSecurityFilingNumber
      );
      setSiteOriginError("");
      setIcpFilingError("");
      setPublicSecurityFilingError("");
      notify("success", tr("站点信息已更新"));
    } catch (error) {
      if (error instanceof SettingsSaveCancelled) return;
      notify(
        "error",
        error instanceof Error ? error.message : tr("保存站点信息失败")
      );
    } finally {
      setSavingSiteProfile(false);
    }
  };

  const toggleEmptyRegistrationEmail = async (allowed: boolean) => {
    if (!adminSettings || togglingEmptyEmail) return;
    if (allowed === adminSettings.allowRegistrationWithoutEmail) return;
    setTogglingEmptyEmail(true);
    try {
      const result = await settingsApi<{ settings: AdminSettingsPayload }>(
        "/admin/settings/registration-email",
        {
          method: "PATCH",
          body: jsonBody({
            allowRegistrationWithoutEmail: allowed,
            expectedVersion: adminSettings.version
          })
        }
      );
      applySavedAdminSettings(result.settings, "/admin/settings/registration-email");
      notify(
        "success",
        allowed ? tr("已允许注册时不填写邮箱") : tr("注册时必须填写邮箱")
      );
    } catch (error) {
      if (error instanceof SettingsSaveCancelled) return;
      notify(
        "error",
        error instanceof Error ? error.message : tr("注册邮箱规则更新失败")
      );
    } finally {
      setTogglingEmptyEmail(false);
    }
  };

  const smtpConfigurationDirty = smtpConfigurationIsDirty(
    smtp, smtpForm, smtpPassword, clearPassword
  );
  const smtpDirty =
    smtpConfigurationDirty ||
    Boolean(smtp && smtp.enabled !== smtpForm.enabled);
  const bookingDirty = Boolean(
    adminSettings &&
    (bookingForm.minBookingMinutes !== adminSettings.minBookingMinutes ||
      bookingForm.maxBookingMinutes !== adminSettings.maxBookingMinutes ||
      bookingForm.advanceDays !== adminSettings.advanceDays ||
      bookingForm.blockAdminBookings !== adminSettings.blockAdminBookings)
  );
  const siteProfileDirty = Boolean(
    adminSettings &&
    (siteOrigin.trim() !== adminSettings.siteOrigin ||
      icpFilingNumber.trim() !== adminSettings.icpFilingNumber ||
      publicSecurityFilingNumber.trim() !==
      adminSettings.publicSecurityFilingNumber)
  );

  const settingsSnapshot = useRef({ adminSettings, smtp, dirty: false, uncertain: false });
  settingsSnapshot.current = { adminSettings, smtp, dirty: bookingDirty || siteProfileDirty || smtpDirty || Boolean(emailDomainInput), uncertain: settingsUncertain };
  const fetchSettingsChanges = useCallback(async (signal: AbortSignal) => {
    if (settingsRetry.current) clearTimeout(settingsRetry.current);
    settingsRetry.current = null;
    const request = settingsGate.current.beginRead(signal);
    if (!request) return;
    try {
      const [nextSettings, nextSmtp] = await withRequestDeadline(readSignal => Promise.all([
        api<AdminSettingsPayload>("/admin/settings", { signal: readSignal, cache: "no-store" }),
        api<SmtpSettingsPayload>("/admin/smtp-settings", { signal: readSignal, cache: "no-store" })
      ]), request.signal);
      if (!request.current()) return;
      validateSettingsResponse(nextSettings); validateSettingsResponse(nextSmtp, true);
      const previous = settingsSnapshot.current;
      if (olderSettingsVersion(previous, nextSettings, nextSmtp)) throw new Error("Stale settings response");
      setSettingsReadError(""); settingsRetryAttempt.current = 0;
      if (previous.dirty || previous.uncertain && previous.adminSettings && previous.smtp) return;
      applyAdminSettings(nextSettings); applySmtpSettings(nextSmtp);
      // A remounted page may display a fresh snapshot, but only a browser refresh clears an ambiguous write.
      if (!previous.uncertain) setSettingsUncertain(false);
    } catch {
      if (!request.current()) return;
      setSettingsReadError(tr("设置读取失败，正在重试。已有内容和输入已保留。"));
      const delay = [2000, 5000, 15000, 30000][Math.min(settingsRetryAttempt.current++, 3)];
      settingsRetry.current = setTimeout(() => { void settingsRefreshRef.current(); }, delay);
    } finally {
      request.dispose();
    }
  }, [applyAdminSettings, applySmtpSettings]);
  const refreshSettings = useRealtimeRefresh(fetchSettingsChanges, ["settings"]);
  settingsRefreshRef.current = refreshSettings;
  useEffect(() => { void refreshSettings(); }, [refreshSettings, settingsWriteEpoch]);

  const toggleSmtp = async (enabled: boolean) => {
    if (!smtp || enabled === smtp.enabled || togglingSmtp) return;
    if (
      !enabled &&
      !(await dialog.confirm({
        title: tr("停用邮件服务"),
        message: tr("停用后，全部尚未发送的邮件都会被取消。"),
        confirmLabel: tr("确认停用"),
        tone: "danger"
      }))
    ) {
      return;
    }
    setSmtpForm((current) => ({ ...current, enabled }));
    setTogglingSmtp(true);
    try {
      const result = await settingsApi<{ settings: SmtpSettingsPayload }>(
        "/admin/smtp-settings",
        {
          method: "PATCH",
          body: jsonBody({
            host: smtp.host,
            port: smtp.port,
            security: smtp.security,
            username: smtp.username,
            fromName: smtp.fromName,
            fromAddress: smtp.fromAddress,
            enabled,
            clearPassword: false,
            expectedVersion: smtp.version
          })
        }
      );
      setSmtp(result.settings);
      if (!smtpConfigurationDirty) settingsVersions.current["/admin/smtp-settings"] = result.settings.version;
      setSmtpForm((current) => ({
        ...current,
        enabled: result.settings.enabled
      }));
      notify("success", enabled ? tr("邮件服务已启用") : tr("邮件服务已停用"));
    } catch (error) {
      setSmtpForm((current) => ({ ...current, enabled: smtp.enabled }));
      if (error instanceof SettingsSaveCancelled) return;
      notify(
        "error",
        error instanceof Error ? error.message : tr("邮件服务状态更新失败")
      );
    } finally {
      setTogglingSmtp(false);
    }
  };

  const testSmtp = async () => {
    try {
      setTestingSmtp(true);
      await settingsApi("/admin/smtp-settings/test", {
        method: "POST",
        body: jsonBody({ recipient: testRecipient })
      });
      await refreshSettings();
      notify("success", tr("测试邮件已发送，请检查收件箱"));
    } catch (error) {
      await refreshSettings();
      notify("error", error instanceof Error ? error.message : tr("测试邮件发送失败"));
    } finally {
      setTestingSmtp(false);
    }
  };

  const saveSmtp = async () => {
    if (!smtp) return;
    try {
      setSavingSmtp(true);
      const result = await settingsApi<{ settings: SmtpSettingsPayload }>(
        "/admin/smtp-settings",
        {
          method: "PATCH",
          body: jsonBody({
            ...smtpForm,
            enabled: smtp.enabled,
            password: smtpPassword || undefined,
            clearPassword,
            expectedVersion: smtp.version
          })
        }
      );
      applySmtpSettings(result.settings);
      notify(
        "success",
        smtp.enabled
          ? tr("邮件配置已保存并立即生效")
          : tr("邮件配置已保存")
      );
    } catch (error) {
      if (error instanceof SettingsSaveCancelled) return;
      notify("error", error instanceof Error ? error.message : tr("邮件配置保存失败"));
    } finally {
      setSavingSmtp(false);
    }
  };
  return {
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
  };
}
