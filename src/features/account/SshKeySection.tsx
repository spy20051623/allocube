import { useEffect, useRef, useState } from "react";
import { KeyRound, Plus, Upload } from "lucide-react";
import { api, jsonBody } from "../../api";
import { Modal } from "../../Modal";
import { useAppDialog } from "../../components/dialogs";
import { containsPrivateKey, shouldConfirmKeyImport } from "./ssh-key-import";
import { currentLocale } from "../../i18n";
import { SshKeyActivationModal } from "./SshKeyActivationModal";
import { SshKeyNotice } from "./SshKeyNotice";
import type { PersonalKey } from "./ssh-key-types";
import "./ssh-keys.css";
export function SshKeySection({
  notify,
  onBindEmail,
}: {
  notify: (kind: "success" | "error", message: string) => void;
  onBindEmail: () => void;
}) {
  const t = (zh: string, en: string) => (currentLocale() === "en" ? en : zh);
  const fileInput = useRef<HTMLInputElement>(null);
  const dialog = useAppDialog();
  const importAbort = useRef<AbortController | null>(null);
  useEffect(() => () => importAbort.current?.abort(), []);
  const [keys, setKeys] = useState<PersonalKey[]>([]),
    [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"add" | PersonalKey | null>(null),
    [name, setName] = useState(""),
    [publicKey, setPublicKey] = useState(""),
    [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [emailVerification, setEmailVerification] = useState<
    "REQUIRED" | "SKIP" | "BIND_REQUIRED"
  >("REQUIRED");
  const [cooldown, setCooldown] = useState(0);
  const [activationKey, setActivationKey] = useState<PersonalKey | null>(null);
  const [autoActivateAll, setAutoActivateAll] = useState(false);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);
  const clearProof = () => {
    setCode("");
    setChallengeId("");
  };
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api<{
      keys: PersonalKey[];
      emailVerification: "REQUIRED" | "SKIP" | "BIND_REQUIRED";
    }>("/auth/ssh-keys")
      .then((r) => {
        if (active) {
          setKeys(r.keys);
          setEmailVerification(r.emailVerification);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const close = () => {
    if (busy) return;
    setMode(null);
    clearProof();
    setPublicKey("");
    setName("");
    setError("");
    setAutoActivateAll(false);
  };
  const confirmPrivateKeySubmission = async (forEmailCode: boolean) => {
    if (mode !== "add" || !containsPrivateKey(publicKey)) return true;
    importAbort.current?.abort();
    const controller = new AbortController();
    importAbort.current = controller;
    return dialog.confirm({
      signal: controller.signal,
      title: t("这可能是私钥", "This may be a private key"),
      message: t(
        "当前内容包含私钥特征。私钥应只保存在你自己的设备上，提交会将这段内容发送到平台。建议取消并选择对应的 .pub 公钥文件。\n确认后将继续执行，平台仍会校验公钥格式。",
        "This content appears to contain a private key. Private keys should stay on your own device; continuing will send this content to the platform. We recommend cancelling and choosing the matching .pub public key file.\nConfirmation continues the operation; the platform still validates the public key format.",
      ),
      tone: "danger",
      cancelLabel: t("取消", "Cancel"),
      confirmLabel: forEmailCode ? t("仍然获取验证码", "Continue requesting code") : t("仍然添加", "Add anyway"),
    });
  };
  return (
    <div className="profile-section ssh-key-section" id="ssh-keys">
      <div className="profile-section-head">
        <div className="profile-section-title">
          <span className="profile-section-icon">
            <KeyRound size={16} />
          </span>
          <h2>{t("SSH 公钥", "SSH public keys")}</h2>
        </div>
        <button
          type="button"
          className="primary-button"
          disabled={loading || keys.length >= 10}
          onClick={() => {
            setError("");
            setMode("add");
            setAutoActivateAll(false);
          }}
        >
          <Plus size={14} />
          {t("添加公钥", "Add public key")}
        </button>
      </div>
      {loading ? (
        <div className="mini-empty">{t("正在加载…", "Loading…")}</div>
      ) : keys.length ? (
        <div className="ssh-key-list">
          {keys.map((key) => (
            <div
              className="ssh-key-row"
              key={key.id}
            >
              <span className="ssh-key-symbol"><KeyRound size={18} aria-hidden="true" /></span>
              <div className="ssh-key-identity">
                <div className="ssh-key-title">
                  <strong>{key.name}</strong>
                  <span className={`ssh-key-count${key.activeMachineCount ? " is-active" : ""}`}>
                    {key.activeMachineCount ? t(`${key.activeMachineCount} 台已激活`, `${key.activeMachineCount} active`) : t("未激活", "Inactive")}
                  </span>
                </div>
                <code>{key.fingerprint}</code>
              </div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setActivationKey(key)}
                >
                  {t("管理", "Manage")}
                </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="ssh-key-empty">
          <KeyRound size={20} aria-hidden="true" />
          {t("尚未添加 SSH 公钥", "No SSH public keys yet")}
        </div>
      )}
      {activationKey && (
        <SshKeyActivationModal
          key={activationKey.id}
          publicKey={activationKey}
          onClose={() => setActivationKey(null)}
          onDelete={() => {
            setMode(activationKey);
            setActivationKey(null);
            clearProof();
            setError("");
          }}
          onSaved={(keys) => {
            setKeys(keys);
            setActivationKey(null);
            notify(
              "success",
              t(
                "激活设置已保存，等待机器拉取",
                "Activation settings saved; awaiting machine sync",
              ),
            );
          }}
        />
      )}
      {mode && (
        <Modal
          className="ssh-key-modal"
          title={
            mode === "add"
              ? t("添加 SSH 公钥", "Add SSH public key")
              : t("删除 SSH 公钥", "Delete SSH public key")
          }
          onClose={close}
          headerActions={mode === "add" ? (
            <button
              type="button"
              className="secondary-button ssh-key-upload"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <Upload size={15} aria-hidden="true" />
              {t("上传公钥文件", "Upload public key file")}
            </button>
          ) : undefined}
        >
          <form
            className="stack-form ssh-key-form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy) return;
              setBusy(true);
              setError("");
              try {
                if (!(await confirmPrivateKeySubmission(false))) return;
                const result = await api<{
                  keys: PersonalKey[];
                  autoActivatedMachineCount?: number;
                  emailVerification: "REQUIRED" | "SKIP" | "BIND_REQUIRED";
                }>(
                  mode === "add"
                    ? "/auth/ssh-keys"
                    : `/auth/ssh-keys/${mode.id}`,
                  {
                    method: mode === "add" ? "POST" : "DELETE",
                    body: jsonBody(
                      mode === "add"
                        ? {
                            name,
                            publicKey,
                            autoActivateAll,
                            ...(challengeId ? { challengeId, code } : {}),
                          }
                        : { ...(challengeId ? { challengeId, code } : {}) },
                    ),
                  },
                );
                setKeys(result.keys);
                setEmailVerification(result.emailVerification);
                setMode(null);
                clearProof();
                setPublicKey("");
                setName("");
                setAutoActivateAll(false);
                notify(
                  "success",
                  t(
                    mode === "add"
                      ? autoActivateAll
                        ? result.autoActivatedMachineCount
                          ? `公钥已添加，已激活 ${result.autoActivatedMachineCount} 台机器`
                          : "公钥已添加，当前没有可激活的机器"
                        : "公钥已添加"
                      : "公钥已删除，所有机器激活已取消",
                    mode === "add"
                      ? autoActivateAll
                        ? result.autoActivatedMachineCount
                          ? `Key added and activated on ${result.autoActivatedMachineCount} machines.`
                          : "Key added. No machines are currently available to activate."
                        : "Key added."
                      : "Key deleted and deactivated on all machines.",
                  ),
                );
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                void api<{
                  emailVerification: "REQUIRED" | "SKIP" | "BIND_REQUIRED";
                }>("/auth/ssh-keys")
                  .then((r) => setEmailVerification(r.emailVerification))
                  .catch(() => {});
              } finally {
                setBusy(false);
              }
            }}
          >
            {mode === "add" ? (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".pub"
                  hidden
                  disabled={busy}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    setError("");
                    if (file.size > 4096) {
                      setError(t("公钥文件不能超过 4 KB", "Public key file must be at most 4 KB"));
                      return;
                    }
                    setBusy(true);
                    try {
                      const text = await file.text();
                      if (shouldConfirmKeyImport(file.name, text)) {
                        importAbort.current?.abort();
                        const controller = new AbortController();
                        importAbort.current = controller;
                        const confirmed = await dialog.confirm({
                          signal: controller.signal,
                          title: t("这可能是私钥", "This may be a private key"),
                          message: t(
                            "文件名或内容包含私钥特征。私钥应只保存在你自己的设备上，请优先选择对应的 .pub 公钥文件。\n继续仅填入当前表单；提交时会再次确认是否发送到平台。",
                            "The file name or contents suggest a private key. Keep private keys on your own device and choose the matching .pub public key file.\nContinuing only fills this form; submission will ask again before sending the content to the platform.",
                          ),
                          tone: "danger",
                          cancelLabel: t("取消导入", "Cancel import"),
                          confirmLabel: t("仍然导入", "Import anyway"),
                        });
                        if (!confirmed) return;
                      }
                      setPublicKey(text.trim());
                      setName(file.name.replace(/\.pub$/i, "").slice(0, 80));
                      clearProof();
                    } catch {
                      setError(t("文件读取失败，请重新上传", "Could not read the file. Please try again."));
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
                <label className="field">
                  <span>{t("名称", "Name")}</span>
                  <input
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      clearProof();
                    }}
                    maxLength={80}
                    required
                    disabled={busy}
                  />
                </label>
                <label className="field">
                  <span>{t("SSH 公钥", "SSH public key")}</span>
                  <textarea
                    rows={4}
                    value={publicKey}
                    onChange={(e) => {
                      setPublicKey(e.target.value);
                      clearProof();
                    }}
                    maxLength={4096}
                    placeholder="ssh-ed25519 AAAA…"
                    required
                    disabled={busy}
                  />
                </label>
                <label className="ssh-key-checkbox ssh-key-auto-activate">
                  <input
                    type="checkbox"
                    checked={autoActivateAll}
                    disabled={busy}
                    onChange={(e) => setAutoActivateAll(e.target.checked)}
                  />
                  <span>{t("添加后自动激活所有可用机器", "Activate on all available machines after adding")}</span>
                </label>
              </>
            ) : (
              <>
                <strong>{mode.name}</strong>
                <code style={{ overflowWrap: "anywhere" }}>
                  {mode.fingerprint}
                </code>
                <p>
                  {keys.length === 1
                    ? t(
                        "这是最后一把个人公钥。删除将取消它在所有机器上的激活，可能影响后续 SSH 登录。",
                        "This is your last platform key. New SSH connections may fail after deletion is synchronized.",
                      )
                    : t(
                        "删除将取消这把公钥在所有机器上的激活，并在各机器下次成功拉取后移除。",
                        "This synced key will be removed on the next successful pull.",
                      )}
                </p>
              </>
            )}
            {emailVerification === "BIND_REQUIRED" ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    close();
                    onBindEmail();
                  }}
                >
                  {t("绑定邮箱后继续", "Bind email to continue")}
                </button>
            ) : emailVerification === "REQUIRED" ? (
              <label className="field">
                <span>{t("邮箱验证码", "Email verification code")}</span>
                <div className="verification-input-row">
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                    disabled={busy}
                  />
                  <button
                    type="button"
                    className="secondary-button verification-button"
                    disabled={
                      busy ||
                      cooldown > 0 ||
                      (mode === "add" && (!name.trim() || !publicKey.trim()))
                    }
                    onClick={async () => {
                      if (busy) return;
                      setBusy(true);
                      setError("");
                      try {
                        if (!(await confirmPrivateKeySubmission(true))) return;
                        const r = await api<{
                          emailVerification: typeof emailVerification;
                          challengeId?: string;
                        }>("/auth/ssh-keys/email-code", {
                          method: "POST",
                          body: jsonBody(
                            mode === "add"
                              ? { kind: "ADD", name, publicKey }
                              : { kind: "REMOVE", keyId: mode.id },
                          ),
                        });
                        setEmailVerification(r.emailVerification);
                        if (r.challengeId) {
                          setChallengeId(r.challengeId);
                          setCode("");
                          setCooldown(60);
                          notify(
                            "success",
                            t(
                              "验证码已发送至绑定邮箱",
                              "Verification code sent to your email",
                            ),
                          );
                        }
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {cooldown > 0
                      ? cooldown + "s"
                      : t("获取验证码", "Send code")}
                  </button>
                </div>
              </label>
            ) : null}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={close}
              >
                {t("取消", "Cancel")}
              </button>
              <button
                className="primary-button"
                disabled={
                  busy ||
                  emailVerification === "BIND_REQUIRED" ||
                  (emailVerification === "REQUIRED" && !challengeId)
                }
              >
                {busy
                  ? t("处理中…", "Saving…")
                  : mode === "add"
                    ? t("添加公钥", "Add key")
                    : t("确认删除", "Delete key")}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {error && <SshKeyNotice message={error} onClose={() => setError("")} />}
    </div>
  );
}
