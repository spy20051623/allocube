import { EditCancelled, canSyncDraft } from "../../edit-conflict";
import { withRequestDeadline } from "../../request-deadline";
import { PageHeader } from "../../PageHeader";
import { Modal } from "../../Modal";
import { tr } from "../../i18n/index";
import { Plus, Megaphone } from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { jsonBody, ApiError } from "../../api";
import { subscribeRealtimeEvent } from "../../realtime";
import { AnnouncementMarkdown } from "../../AnnouncementMarkdown";
import { formatChinaFullMinute } from "../../date";
import { useConflictApi } from "../../app/useConflictApi";
import { useAppDialog } from "../../components/dialogs";
import { type SystemAnnouncement, type AnnouncementEditorState } from "./types";
import { EmptyState } from "../../components/feedback";
import { validationDetailFromApi } from "../../api-errors";
import { Field } from "../../components/forms";

export function AnnouncementAdminPanel({
  notify
}: {
  notify: (kind: "success" | "error", message: string) => void;
}) {
  const { request: api } = useConflictApi();
  const dialog = useAppDialog();
  const [announcements, setAnnouncements] = useState<SystemAnnouncement[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [editorState, setEditorState] = useState<AnnouncementEditorState | null>(null);
  const [showWithdrawn, setShowWithdrawn] = useState(false);

  const visibleAnnouncements = showWithdrawn
    ? announcements
    : announcements.filter((announcement) => announcement.status === "ACTIVE");

  const readController = useRef<AbortController | null>(null);
  useEffect(() => () => readController.current?.abort(), []);
  const load = useCallback(async () => {
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    try {
      const result = await withRequestDeadline(signal => api<{ announcements: SystemAnnouncement[] }>(
        "/admin/announcements", { signal }
      ), controller.signal);
      if (controller.signal.aborted) return;
      setAnnouncements(result.announcements);
      setLoadError(false);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof EditCancelled) return;
      setLoadError(true);
      notify("error", error instanceof Error ? error.message : tr("公告加载失败"));
    } finally {
      if (controller.signal.aborted) return;
      setLoaded(true);
    }
  }, [notify]);

  useEffect(() => {
    void load();
    return subscribeRealtimeEvent("announcement", () => void load());
  }, [load]);

  const withdraw = async (announcement: SystemAnnouncement) => {
    if (!(await dialog.confirm({
      title: tr("撤下系统公告"),
      message: tr("撤下“{{v0}}”后，尚未查看的用户将不再收到此公告。", { v0: announcement.title }),
      confirmLabel: tr("确认撤下"),
      tone: "danger"
    }))) return;
    try {
      await api(`/admin/announcements/${announcement.id}/withdraw`, {
        method: "POST",
        body: jsonBody({ expectedVersion: announcement.version })
      });
      notify("success", tr("系统公告已撤下"));
      await load();
    } catch (error) {
      if (error instanceof EditCancelled) return;
      if (error instanceof ApiError && error.status === 409) await load();
      notify("error", error instanceof Error ? error.message : tr("公告撤下失败"));
    }
  };

  return (
    <div className="announcement-management-page">
      <PageHeader
        title={tr("系统公告")}
        actions={
          <div className="announcement-page-actions">
            <label className="settings-toggle-control announcement-history-toggle">
              <strong>{tr("显示已撤下")}</strong>
              <input
                type="checkbox"
                checked={showWithdrawn}
                onChange={(event) => setShowWithdrawn(event.target.checked)}
              />
              <i className="settings-toggle" aria-hidden="true"><i /></i>
            </label>
            <button
              type="button"
              className="primary-button"
              onClick={() => setEditorState({ mode: "CREATE" })}
            >
              <Plus size={16} />{tr("action.announcement.new")}</button>
          </div>
        }
      />
      {!loaded ? (
        <div className="card announcement-admin-empty">{tr("正在加载系统公告…")}</div>
      ) : loadError ? (
        <div className="card announcement-load-error" role="alert">
          <span>{tr("系统公告加载失败，当前列表可能不是最新状态")}</span>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setLoaded(false);
              void load();
            }}
          >
            {tr("重试")}</button>
        </div>
      ) : visibleAnnouncements.length ? (
        <div className="announcement-admin-list">
          {visibleAnnouncements.map((announcement) => (
            <article className="card announcement-admin-card" key={announcement.id}>
              <header>
                <div>
                  <span className={`state-chip ${announcement.status === "ACTIVE" ? "active" : ""}`}>
                    {announcement.status === "ACTIVE" ? tr("展示中") : tr("已撤下")}
                  </span>
                  <h2>{announcement.title}</h2>
                </div>
                <div className="announcement-card-actions">
                  {announcement.status === "ACTIVE" ? (
                    <>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => setEditorState({ mode: "EDIT", announcement })}
                      >
                        {tr("编辑")}</button>
                      <button
                        type="button"
                        className="danger-button"
                        onClick={() => void withdraw(announcement)}
                      >
                        {tr("撤下")}</button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => setEditorState({ mode: "REACTIVATE", announcement })}
                    >
                      {tr("重新启用")}</button>
                  )}
                </div>
              </header>
              <AnnouncementMarkdown
                markdown={announcement.bodyMarkdown}
                onInternalNavigate={(href) => window.location.assign(href)}
              />
              <footer>
                <span>{announcement.createdByName}</span>
                <time>{tr("发布于")}{formatChinaFullMinute(announcement.publishedAt)}</time>
                {announcement.withdrawnAt && (
                  <span>{tr("撤下于")}{formatChinaFullMinute(announcement.withdrawnAt)}</span>
                )}
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Megaphone}
          title={announcements.length ? tr("暂无展示中的公告") : tr("暂无系统公告")}
          text={
            announcements.length
              ? tr("打开“显示已撤下”可查看历史公告，或创建一条新公告。")
              : tr("创建后，用户下次进入系统时会依次看到公告。")
          }
        />
      )}
      {editorState && (
        <AnnouncementEditorModal
          key={`${editorState.mode}:${editorState.mode === "CREATE" ? "new" : editorState.announcement.id}`}
          state={editorState.mode === "CREATE" ? editorState : { ...editorState, announcement: announcements.find(item => item.id === editorState.announcement.id) ?? editorState.announcement }}
          notify={notify}
          onClose={() => setEditorState(null)}
          onSaved={async (message) => {
            setEditorState(null);
            notify("success", message);
            await load();
          }}
        />
      )}
    </div>
  );
}

function AnnouncementEditorModal({
  state,
  notify,
  onClose,
  onSaved
}: {
  state: AnnouncementEditorState;
  notify: (kind: "success" | "error", message: string) => void;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const { request: api, busy: mutationBusy } = useConflictApi();
  const existing = state.mode === "CREATE" ? null : state.announcement;
  const [title, setTitle] = useState(existing?.title ?? "");
  const [bodyMarkdown, setBodyMarkdown] = useState(existing?.bodyMarkdown ?? "");
  const [expectedVersion, setExpectedVersion] = useState(existing?.version ?? 1);
  const [serverStatus, setServerStatus] = useState<"ACTIVE" | "WITHDRAWN">(
    existing?.status ?? "ACTIVE"
  );
  const [fieldErrors, setFieldErrors] = useState<{
    title?: string;
    bodyMarkdown?: string;
  }>({});
  const [saving, setSaving] = useState(false);

  const baseline = useRef({ title, bodyMarkdown });
  useEffect(() => {
    if (!existing || existing.version <= expectedVersion || !canSyncDraft(baseline.current, { title, bodyMarkdown }, saving || mutationBusy)) return;
    baseline.current = { title: existing.title, bodyMarkdown: existing.bodyMarkdown };
    setTitle(existing.title); setBodyMarkdown(existing.bodyMarkdown);
    setExpectedVersion(existing.version); setServerStatus(existing.status);
  }, [existing, expectedVersion, title, bodyMarkdown, saving, mutationBusy]);

  const effectiveMode =
    state.mode === "CREATE"
      ? "CREATE"
      : serverStatus === "WITHDRAWN"
        ? "REACTIVATE"
        : "EDIT";

  const modalTitle =
    effectiveMode === "CREATE"
      ? tr("创建系统公告")
      : effectiveMode === "EDIT"
        ? tr("编辑系统公告")
        : tr("重新启用系统公告");
  const submitLabel =
    effectiveMode === "CREATE"
      ? tr("发布公告")
      : effectiveMode === "EDIT"
        ? tr("保存并重新发布")
        : tr("重新启用");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !bodyMarkdown.trim()) return;
    setFieldErrors({});
    setSaving(true);
    try {
      if (effectiveMode === "CREATE") {
        await api("/admin/announcements", {
          method: "POST",
          body: jsonBody({ title, bodyMarkdown })
        });
        await onSaved(tr("系统公告已发布"));
      } else if (existing) {
        await api(`/admin/announcements/${existing.id}`, {
          method: "PUT",
          body: jsonBody({
            title,
            bodyMarkdown,
            expectedVersion,
            reactivate: effectiveMode === "REACTIVATE"
          })
        });
        await onSaved(
          effectiveMode === "REACTIVATE" ? tr("系统公告已重新启用") : tr("系统公告已更新")
        );
      }
    } catch (error) {
      if (error instanceof EditCancelled) return;
      const titleError = validationDetailFromApi(error, "title");
      const bodyMarkdownError = validationDetailFromApi(error, "bodyMarkdown");
      if (titleError || bodyMarkdownError) {
        setFieldErrors({
          ...(titleError ? { title: titleError } : {}),
          ...(bodyMarkdownError ? { bodyMarkdown: bodyMarkdownError } : {})
        });
        return;
      }
      notify("error", error instanceof Error ? error.message : tr("公告保存失败"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={modalTitle} onClose={onClose} large className="announcement-editor-modal">
      <form className="announcement-create-form" onSubmit={(event) => void submit(event)}>
        <fieldset disabled={saving || mutationBusy} className="editor-fieldset announcement-create-fields">
          <Field label={tr("公告标题")} error={fieldErrors.title}>
            <input
              autoFocus
              maxLength={120}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setFieldErrors((current) => ({ ...current, title: undefined }));
              }}
            />
          </Field>
          <Field label={tr("公告内容")} error={fieldErrors.bodyMarkdown}>
            <textarea
              maxLength={10_000}
              value={bodyMarkdown}
              onChange={(event) => {
                setBodyMarkdown(event.target.value);
                setFieldErrors((current) => ({
                  ...current,
                  bodyMarkdown: undefined
                }));
              }}
              placeholder={tr("支持 Markdown。外链：[说明](https://example.org)\n站内跳转：[查看资源日历](allocube:/calendar)")}
            />
            <small>
              {tr("支持段落、列表、粗体、行内代码和链接；站内链接使用")}<code>{tr("[文字](allocube:/路径)")}</code>{tr("，原始 HTML 和其他协议不会渲染。")}</small>
          </Field>
        </fieldset>
        <section className="announcement-preview" aria-label={tr("公告预览")}>
          <strong>{tr("预览")}</strong>
          {bodyMarkdown.trim() ? (
            <AnnouncementMarkdown markdown={bodyMarkdown} interactive={false} />
          ) : (
            <span>{tr("输入内容后在这里预览")}</span>
          )}
        </section>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{tr("取消")}</button>
          <button
            type="submit"
            className="primary-button"
            disabled={saving || !title.trim() || !bodyMarkdown.trim()}
          >
            {saving ? tr("保存中") : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
