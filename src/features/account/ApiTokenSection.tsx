import { Modal } from "../../Modal";
import { tr } from "../../i18n/index";
import { KeyRound, Plus, Trash2, CircleAlert, Copy } from "lucide-react";
import { useState, useCallback, useEffect } from "react";
import { api, jsonBody } from "../../api";
import { copyTextToClipboard } from "../../clipboard";
import { formatChinaFullMinute } from "../../date";
import { useAppDialog } from "../../components/dialogs";
import { AuthFeedback, Field, ChoiceField } from "../../components/forms";
import { PasswordInput } from "../../components/PasswordFields";
import { BusyButtonContent } from "../../components/feedback";

type PersonalApiToken = {
  id: string;
  name: string;
  prefix: string;
  accessLevel: "READ_ONLY" | "READ_WRITE";
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedReason: string;
};

export function ApiTokenSection({
  notify
}: {
  notify: (kind: "success" | "error", message: string) => void;
}) {
  const dialog = useAppDialog();
  const [tokens, setTokens] = useState<PersonalApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const loadTokens = useCallback(async () => {
    try {
      const result = await api<{
        tokens: PersonalApiToken[];
        maxActiveTokens: number;
      }>("/auth/api-tokens");
      setTokens(result.tokens);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : tr("令牌列表加载失败"));
    } finally {
      setLoading(false);
    }
  }, [notify]);
  useEffect(() => {
    void loadTokens();
  }, [loadTokens]);

  const tokenState = (token: PersonalApiToken) => {
    if (token.revokedAt) return { label: tr("已吊销"), className: "retiring" };
    if (token.expiresAt && token.expiresAt <= new Date().toISOString()) {
      return { label: tr("已到期"), className: "retiring" };
    }
    return { label: tr("有效"), className: "active" };
  };

  const revoke = async (token: PersonalApiToken) => {
    const confirmed = await dialog.confirm({
      title: tr("吊销个人访问令牌"),
      message: tr("吊销“{{v0}}”后，使用它的 AI 或脚本会立即失去访问权限。", { v0: token.name }),
      confirmLabel: tr("吊销令牌"),
      tone: "danger"
    });
    if (!confirmed) return;
    try {
      await api(`/auth/api-tokens/${token.id}`, { method: "DELETE" });
      notify("success", tr("个人访问令牌已吊销"));
      await loadTokens();
    } catch (error) {
      notify("error", error instanceof Error ? error.message : tr("令牌吊销失败"));
    }
  };

  const activeCount = tokens.filter((token) => tokenState(token).label === tr("有效")).length;
  return (
    <div className="profile-section profile-api-tokens">
      <div className="profile-section-head">
        <div className="profile-section-title">
          <span className="profile-section-icon api-token">
            <KeyRound size={16} />
          </span>
          <div>
            <h2>{tr("个人访问令牌")}</h2>
            <small>{tr("供 AI、CLI 和服务端自动化调用官方 API")}</small>
          </div>
        </div>
        <div className="profile-api-token-actions">
          <a
            className="secondary-button"
            href="/docs/api"
            target="_blank"
            rel="noreferrer"
          >
            {tr("API 文档")}</a>
          <button
            type="button"
            className="primary-button"
            disabled={activeCount >= 10}
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={14} />
            {tr("action.apiToken.new")}</button>
        </div>
      </div>
      {loading ? (
        <div className="mini-empty">{tr("正在加载令牌…")}</div>
      ) : tokens.length ? (
        <div className="profile-api-token-list">
          {tokens.map((token) => {
            const state = tokenState(token);
            return (
              <div className="profile-api-token-row" key={token.id}>
                <div className="profile-api-token-main">
                  <div>
                    <strong>{token.name}</strong>
                    <span className={`state-chip ${state.className}`}>{state.label}</span>
                    <span className="state-chip">
                      {token.accessLevel === "READ_WRITE" ? tr("读写") : tr("只读")}
                    </span>
                  </div>
                  <code>{token.prefix}…</code>
                </div>
                <div className="profile-api-token-meta">
                  <span>{tr("创建于")}{formatChinaFullMinute(token.createdAt)}</span>
                  <span>
                    {token.lastUsedAt
                      ? tr("最近使用 {{v0}}", { v0: formatChinaFullMinute(token.lastUsedAt) })
                      : tr("尚未使用")}
                  </span>
                  <span>
                    {token.expiresAt
                      ? tr("到期 {{v0}}", { v0: formatChinaFullMinute(token.expiresAt) })
                      : tr("永不过期")}
                  </span>
                </div>
                {!token.revokedAt && state.label === tr("有效") && (
                  <button
                    type="button"
                    className="icon-button danger"
                    title={tr("吊销令牌")}
                    aria-label={tr("吊销令牌 {{v0}}", { v0: token.name })}
                    onClick={() => void revoke(token)}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mini-empty">{tr("尚未创建个人访问令牌")}</div>
      )}
      {createOpen && (
        <ApiTokenCreateModal
          notify={notify}
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            await loadTokens();
          }}
        />
      )}
    </div>
  );
}

function ApiTokenCreateModal({
  notify,
  onClose,
  onCreated
}: {
  notify: (kind: "success" | "error", message: string) => void;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [accessLevel, setAccessLevel] = useState<"READ_ONLY" | "READ_WRITE">(
    "READ_ONLY"
  );
  const [expiry, setExpiry] = useState<"NEVER" | "30" | "90" | "365">("NEVER");
  const [currentPassword, setCurrentPassword] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const normalizedName = name.trim();
    if (!normalizedName) {
      setError(tr("请输入令牌名称"));
      return;
    }
    if (!currentPassword) {
      setError(tr("请输入当前密码"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api<{ token: PersonalApiToken; secret: string }>(
        "/auth/api-tokens",
        {
          method: "POST",
          body: jsonBody({
            name: normalizedName,
            accessLevel,
            expiresInDays: expiry === "NEVER" ? null : Number(expiry),
            currentPassword
          })
        }
      );
      setCurrentPassword("");
      setSecret(result.secret);
      await onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : tr("令牌创建失败"));
    } finally {
      setBusy(false);
    }
  };

  if (secret) {
    return (
      <Modal title={tr("保存个人访问令牌")} onClose={onClose}>
        <div className="api-token-secret-view">
          <div className="context-notice warning">
            <CircleAlert size={15} />
            <span>{tr("这是令牌明文唯一一次显示。关闭窗口后无法再次查看，请立即保存到可信的密钥管理工具。")}</span>
          </div>
          <code>{secret}</code>
          <div className="modal-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={async () => {
                try {
                  await copyTextToClipboard(secret);
                  notify("success", tr("复制成功"));
                } catch {
                  notify("error", tr("复制失败，请手动选择令牌"));
                }
              }}
            >
              <Copy size={14} />
              {tr("复制令牌")}</button>
            <button type="button" className="primary-button" onClick={onClose}>
              {tr("我已保存")}</button>
          </div>
          {error && <AuthFeedback tone="error">{error}</AuthFeedback>}
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={tr("创建个人访问令牌")} onClose={onClose}>
      <form className="stack-form api-token-create-form" onSubmit={submit}>
        <Field label={tr("令牌名称")}>
          <input
            autoFocus
            value={name}
            maxLength={80}
            placeholder={tr("例如：AI 排期助手")}
            onChange={(event) => {
              setName(event.target.value);
              setError("");
            }}
          />
        </Field>
        <ChoiceField
          label={tr("访问权限")}
          value={accessLevel}
          options={[
            { value: "READ_ONLY", label: tr("只读：查询资源和本人占用") },
            { value: "READ_WRITE", label: tr("读写：可预检并提交本人占用操作") }
          ]}
          onChange={(value) => setAccessLevel(value as "READ_ONLY" | "READ_WRITE")}
        />
        <ChoiceField
          label={tr("有效期")}
          value={expiry}
          options={[
            { value: "NEVER", label: tr("永不过期") },
            { value: "30", label: tr("30 天") },
            { value: "90", label: tr("90 天") },
            { value: "365", label: tr("365 天") }
          ]}
          onChange={(value) => setExpiry(value as "NEVER" | "30" | "90" | "365")}
        />
        <Field label={tr("当前密码")}>
          <PasswordInput
            autoComplete="current-password"
            value={currentPassword}
            maxLength={256}
            onChange={(event) => {
              setCurrentPassword(event.target.value);
              setError("");
            }}
          />
        </Field>
        {error && <AuthFeedback tone="error" anchored={false}>{error}</AuthFeedback>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            {tr("取消")}</button>
          <button className="primary-button" disabled={busy}>
            <BusyButtonContent busy={busy}>{tr("action.apiToken.create")}</BusyButtonContent>
          </button>
        </div>
      </form>
    </Modal>
  );
}
