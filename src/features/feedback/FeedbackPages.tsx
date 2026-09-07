import { EditCancelled } from "../../edit-conflict";
import { withRequestDeadline } from "../../request-deadline";
import { PageHeader } from "../../PageHeader";
import { Modal } from "../../Modal";
import { tr, trDynamic } from "../../i18n/index";
import { SelectControl } from "../../SelectControl";
import {
  Plus,
  X,
  RefreshCw,
  ChevronRight,
  MessageSquare,
  CircleAlert,
  ChevronLeft,
  Pencil,
  Send,
  Search
} from "lucide-react";
import { useRef, useState, useMemo, useEffect, useCallback } from "react";
import { api, jsonBody, ApiError } from "../../api";
import { AnnouncementMarkdown } from "../../AnnouncementMarkdown";
import {
  type FeedbackTicketSummary,
  feedbackStatusLabels,
  type FeedbackType,
  type FeedbackLevel,
  type FeedbackStatus,
  feedbackTypeLabels,
  feedbackLevelLabels,
  type FeedbackTicketDetail,
  feedbackTemplates,
  feedbackLevelsFor,
  feedbackStatusesFor,
  type FeedbackAttachment
} from "../../shared/feedback";
import { formatChina } from "../../date";
import { EmptyState, BusyButtonContent } from "../../components/feedback";
import { useConflictApi } from "../../app/useConflictApi";
import { ChoiceField, Field } from "../../components/forms";
import { useAppDialog } from "../../components/dialogs";

type FeedbackNotify = (kind: "success" | "error", message: string) => void;

function feedbackMultipart(metadata: unknown, images: File[]) {
  const data = new FormData();
  data.append("metadata", JSON.stringify(metadata));
  for (const image of images) data.append("images", image, image.name);
  return data;
}

const FEEDBACK_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

const FEEDBACK_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const FEEDBACK_IMAGE_MESSAGE_MAX_BYTES = 20 * 1024 * 1024;

function FeedbackImagePicker({
  files,
  onChange,
  onError,
  maxFiles = 5,
  maxTotalBytes = FEEDBACK_IMAGE_MESSAGE_MAX_BYTES,
  disabled = false,
  compact = false
}: {
  files: File[];
  onChange: (files: File[]) => void;
  onError: (message: string) => void;
  maxFiles?: number;
  maxTotalBytes?: number;
  disabled?: boolean;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const selectedBytes = files.reduce((sum, file) => sum + file.size, 0);
  const canAdd = !disabled && files.length < maxFiles && selectedBytes < maxTotalBytes;
  const previews = useMemo(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [files]
  );
  useEffect(
    () => () => previews.forEach((preview) => URL.revokeObjectURL(preview.url)),
    [previews]
  );

  const addFiles = (candidates: File[]) => {
    if (disabled) return;
    let next = [...files];
    let rejectedType = false;
    let rejectedSize = false;
    let rejectedCount = false;
    let rejectedTotal = false;
    for (const candidate of candidates) {
      if (!FEEDBACK_IMAGE_TYPES.has(candidate.type)) {
        rejectedType = true;
        continue;
      }
      if (candidate.size <= 0 || candidate.size > FEEDBACK_IMAGE_MAX_BYTES) {
        rejectedSize = true;
        continue;
      }
      if (
        next.some(
          (file) =>
            file.name === candidate.name &&
            file.size === candidate.size &&
            file.lastModified === candidate.lastModified
        )
      ) {
        continue;
      }
      if (next.length >= maxFiles) {
        rejectedCount = true;
        continue;
      }
      if (next.reduce((sum, file) => sum + file.size, 0) + candidate.size > maxTotalBytes) {
        rejectedTotal = true;
        continue;
      }
      next.push(candidate);
    }
    onChange(next);
    if (rejectedType) onError(tr("仅支持 PNG、JPEG 或 WebP 图片"));
    else if (rejectedSize) onError(tr("每张图片必须小于等于 5 MB"));
    else if (rejectedCount) onError(tr("最多还能选择 {{v0}} 张图片", { v0: Math.max(0, maxFiles - files.length) }));
    else if (rejectedTotal) onError(tr("本次图片合计不能超过 20 MB"));
  };

  const openPicker = () => {
    if (canAdd) inputRef.current?.click();
  };

  return (
    <div className={`feedback-image-picker${compact ? " compact" : ""}`}>
      <input
        ref={inputRef}
        className="feedback-image-native-input"
        disabled={disabled}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <div
        className={`feedback-image-dropzone${dragging ? " dragging" : ""}${canAdd ? "" : " full"}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          addFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <span className="feedback-image-dropzone-icon"><Plus size={18} /></span>
        <span className="feedback-image-dropzone-copy">
          <strong>{dragging ? tr("松开即可添加图片") : compact ? tr("添加评论图片") : tr("拖拽图片到这里")}</strong>
          <small>{tr("PNG、JPEG、WebP · 单张 5 MB · 合计 20 MB")}</small>
        </span>
        <button
          type="button"
          className="secondary-button compact"
          disabled={!canAdd}
          onClick={openPicker}
        >
          {tr("选择图片")}</button>
      </div>
      {previews.length > 0 && (
        <div className="feedback-selected-images" aria-label={tr("已选择的图片")}>
          {previews.map(({ file, url }, index) => (
            <div className="feedback-selected-image" key={`${file.name}-${file.lastModified}-${index}`}>
              <img src={url} alt="" />
              <span>
                <strong title={file.name}>{file.name}</strong>
                <small>{feedbackFileSize(file.size)}</small>
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label={tr("移除 {{v0}}", { v0: file.name })}
                disabled={disabled} onClick={() => onChange(files.filter((_, fileIndex) => fileIndex !== index))}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function feedbackFileSize(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function FeedbackPage({
  feedbackId,
  refreshToken,
  notify,
  onUnreadCountRefresh,
  onOpen,
  onBack
}: {
  feedbackId?: string;
  refreshToken: number;
  notify: FeedbackNotify;
  onUnreadCountRefresh: () => Promise<void>;
  onOpen: (id: string) => void;
  onBack: () => void;
}) {
  const [tickets, setTickets] = useState<FeedbackTicketSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const load = useCallback(async () => {
    if (feedbackId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (typeFilter) params.set("type", typeFilter);
      if (statusFilter) params.set("status", statusFilter);
      const result = await api<{ tickets: FeedbackTicketSummary[]; nextCursor: string | null }>(
        `/feedback${params.size ? `?${params}` : ""}`
      );
      setTickets(result.tickets);
      setNextCursor(result.nextCursor);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : tr("反馈加载失败"));
    } finally {
      setLoading(false);
    }
  }, [feedbackId, notify, statusFilter, typeFilter]);
  useEffect(() => { void load(); }, [load, refreshToken]);

  if (feedbackId) {
    return (
      <FeedbackDetailView
        id={feedbackId}
        admin={false}
        refreshToken={refreshToken}
        notify={notify}
        onBack={onBack}
        onRead={() => void onUnreadCountRefresh()}
      />
    );
  }

  return (
    <div className="page-shell feedback-page">
      <PageHeader
        title={tr("我的反馈")}
        actions={
          <button type="button" className="primary-button" onClick={() => setCreating(true)}>
            <Plus size={16} />{tr("action.feedback.new")}</button>
        }
      />
      <div className="feedback-filter-bar card">
        <SelectControl
          ariaLabel={tr("反馈类型")}
          value={typeFilter}
          options={[
            { value: "", label: tr("全部类型") },
            { value: "ISSUE", label: tr("问题单") },
            { value: "REQUIREMENT", label: tr("需求单") }
          ]}
          onChange={setTypeFilter}
        />
        <SelectControl
          ariaLabel={tr("反馈状态")}
          value={statusFilter}
          options={[
            { value: "", label: tr("全部状态") },
            ...Object.entries(feedbackStatusLabels).map(([value, label]) => ({
              value,
              label: trDynamic(label)
            }))
          ]}
          onChange={setStatusFilter}
        />
      </div>
      {loading ? (
        <div className="content-loading"><RefreshCw className="spin" />{tr("正在载入")}</div>
      ) : tickets.length ? (
        <>
          <div className="feedback-ticket-list">
            {tickets.map((ticket) => (
              <button type="button" className="card feedback-ticket-card" key={ticket.id} onClick={() => onOpen(ticket.id)}>
                <span className="feedback-ticket-main">
                  <span className="feedback-ticket-number">{ticket.displayNumber}</span>
                  <span className="feedback-ticket-title-row">
                    <strong>{ticket.title}</strong>
                    <span className="feedback-intrinsic-badges">
                      <FeedbackPill value={ticket.type}>{feedbackTypeLabel(ticket.type)}</FeedbackPill>
                      <FeedbackPill tone="level" value={ticket.level}>{feedbackLevelLabel(ticket.level)}</FeedbackPill>
                    </span>
                  </span>
                  <small>{formatChina(ticket.updatedAt)} {tr("更新")}</small>
                </span>
                <span className="feedback-ticket-status">
                  <FeedbackPill tone="status" value={ticket.status}>{feedbackStatusLabel(ticket.status)}</FeedbackPill>
                  <ChevronRight size={18} />
                </span>
              </button>
            ))}
          </div>
          {nextCursor && (
            <button type="button" className="secondary-button feedback-load-more" onClick={async () => {
              const params = new URLSearchParams({ cursor: nextCursor });
              if (typeFilter) params.set("type", typeFilter);
              if (statusFilter) params.set("status", statusFilter);
              try {
                const result = await api<{ tickets: FeedbackTicketSummary[]; nextCursor: string | null }>(`/feedback?${params}`);
                setTickets((current) => [...current, ...result.tickets]);
                setNextCursor(result.nextCursor);
              } catch (error) {
                notify("error", error instanceof Error ? error.message : tr("更多反馈加载失败"));
              }
            }}>{tr("加载更多")}</button>
          )}
        </>
      ) : (
        <EmptyState icon={MessageSquare} title={tr("还没有反馈")} />
      )}
      {creating && (
        <FeedbackEditorModal
          notify={notify}
          onClose={() => setCreating(false)}
          onSaved={(ticket) => {
            setCreating(false);
            notify("success", tr("反馈已提交"));
            onOpen(ticket.id);
          }}
        />
      )}
    </div>
  );
}

function FeedbackPill({
  children,
  tone = "type",
  value
}: {
  children: React.ReactNode;
  tone?: "type" | "level" | "status";
  value: FeedbackType | FeedbackLevel | FeedbackStatus;
}) {
  return <span className={`feedback-pill ${tone} ${tone}-${value.toLowerCase().replaceAll("_", "-")}`}>{children}</span>;
}

function feedbackTypeLabel(value: FeedbackType) {
  return trDynamic(feedbackTypeLabels[value]);
}

function feedbackLevelLabel(value: FeedbackLevel) {
  return trDynamic(feedbackLevelLabels[value]);
}

function feedbackStatusLabel(value: FeedbackStatus) {
  return trDynamic(feedbackStatusLabels[value]);
}

function localizedFeedbackTemplate(type: FeedbackType) {
  const sections = type === "ISSUE"
    ? [tr("问题描述"), tr("复现步骤"), tr("预期结果"), tr("实际结果"), tr("补充信息")]
    : [tr("使用场景"), tr("需求描述"), tr("预期效果"), tr("补充信息")];
  return sections
    .map((section, index) => `## ${section}\n\n${type === "ISSUE" && index === 1 ? "1. \n" : ""}`)
    .join("\n");
}

function FeedbackEditorModal({
  ticket,
  notify,
  onClose,
  onSaved
}: {
  ticket?: FeedbackTicketDetail;
  notify: FeedbackNotify;
  onClose: () => void;
  onSaved: (ticket: FeedbackTicketDetail) => void;
}) {
  const { request: api, busy: mutationBusy } = useConflictApi();
  const editing = Boolean(ticket);
  const [savedTicket, setSavedTicket] = useState(ticket);
  const [type, setType] = useState<FeedbackType>(ticket?.type ?? "ISSUE");
  const [level, setLevel] = useState<FeedbackLevel>(ticket?.level ?? "NORMAL");
  const [title, setTitle] = useState(ticket?.title ?? "");
  const [bodyMarkdown, setBodyMarkdown] = useState(ticket?.bodyMarkdown ?? localizedFeedbackTemplate("ISSUE"));
  const [retainedIds, setRetainedIds] = useState(() => new Set(ticket?.attachments.map((item) => item.id) ?? []));
  const [images, setImages] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!ticket || !savedTicket || ticket.version <= savedTicket.version || mutationBusy || busy || images.length) return;
    if (title !== savedTicket.title || bodyMarkdown !== savedTicket.bodyMarkdown || level !== savedTicket.level ||
      retainedIds.size !== savedTicket.attachments.length || savedTicket.attachments.some(item => !retainedIds.has(item.id))) return;
    setSavedTicket(ticket); setType(ticket.type); setLevel(ticket.level); setTitle(ticket.title); setBodyMarkdown(ticket.bodyMarkdown);
    setRetainedIds(new Set(ticket.attachments.map(item => item.id)));
  }, [ticket, savedTicket, title, bodyMarkdown, level, retainedIds, images, mutationBusy, busy]);
  const changeType = (next: FeedbackType) => {
    setType(next);
    setLevel("NORMAL");
    const defaultTemplates = [
      feedbackTemplates.ISSUE,
      feedbackTemplates.REQUIREMENT,
      localizedFeedbackTemplate("ISSUE"),
      localizedFeedbackTemplate("REQUIREMENT")
    ];
    if (!editing && defaultTemplates.includes(bodyMarkdown)) {
      setBodyMarkdown(localizedFeedbackTemplate(next));
    }
  };
  const currentAttachments = savedTicket?.attachments.filter((item) => retainedIds.has(item.id)) ?? [];
  const totalImages = currentAttachments.length + images.length;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !bodyMarkdown.trim()) return;
    if (totalImages > 5) {
      notify("error", tr("正文最多包含 5 张图片"));
      return;
    }
    setBusy(true);
    try {
      const metadata = editing
        ? { expectedVersion: savedTicket!.version, level, title, bodyMarkdown, retainedAttachmentIds: currentAttachments.map((item) => item.id) }
        : { type, level, title, bodyMarkdown };
      const result = await api<{ ticket: FeedbackTicketDetail }>(
        editing ? `/feedback/${ticket!.id}` : "/feedback",
        { method: editing ? "PUT" : "POST", body: feedbackMultipart(metadata, images) }
      );
      onSaved(result.ticket);
    } catch (error) {
      if (error instanceof EditCancelled) return;
      notify("error", error instanceof Error ? error.message : tr("反馈保存失败"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={editing ? tr("编辑 {{v0}}", { v0: ticket!.displayNumber }) : tr("提交反馈")} onClose={onClose} large className="feedback-editor-modal">
      <form className="feedback-editor-form" onSubmit={(event) => void submit(event)}>
        <div className="feedback-editor-scroll">
          <fieldset disabled={busy || mutationBusy} className="editor-fieldset feedback-editor-fields">
            <div className="feedback-editor-row">
              <ChoiceField
                label={tr("类型")}
                disabled={editing}
                value={type}
                options={[
                  { value: "ISSUE", label: tr("问题单") },
                  { value: "REQUIREMENT", label: tr("需求单") }
                ]}
                onChange={(value) => changeType(value as FeedbackType)}
              />
              <ChoiceField
                label={tr("等级")}
                value={level}
                options={feedbackLevelsFor(type).map((value) => ({
                  value,
                  label: feedbackLevelLabel(value)
                }))}
                onChange={(value) => setLevel(value as FeedbackLevel)}
              />
            </div>
            <Field label={tr("标题")}>
              <input autoFocus maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} />
            </Field>
            <Field label={tr("正文")}>
              <textarea maxLength={10000} value={bodyMarkdown} onChange={(event) => setBodyMarkdown(event.target.value)} />
            </Field>
            <div className="field">
              <span>{tr("图片（")}{totalImages}/5）</span>
              <FeedbackImagePicker
                disabled={busy || mutationBusy}
                files={images}
                onChange={setImages}
                onError={(message) => notify("error", message)}
                maxFiles={Math.max(0, 5 - currentAttachments.length)}
                maxTotalBytes={Math.max(
                  0,
                  FEEDBACK_IMAGE_MESSAGE_MAX_BYTES -
                  currentAttachments.reduce((sum, attachment) => sum + attachment.byteSize, 0)
                )}
              />
            </div>
            {currentAttachments.length > 0 && (
              <div className="feedback-retained-images">
                {currentAttachments.map((attachment) => (
                  <button type="button" key={attachment.id} onClick={() => setRetainedIds((current) => {
                    const next = new Set(current); next.delete(attachment.id); return next;
                  })}>
                    <img src={attachment.contentUrl} alt="" />
                    <span><X size={13} />{tr("移除")}</span>
                  </button>
                ))}
              </div>
            )}
          </fieldset>
          <div className="feedback-editor-preview">
            <strong>{tr("预览")}</strong>
            <AnnouncementMarkdown markdown={bodyMarkdown} />
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{tr("取消")}</button>
          <button className="primary-button" disabled={busy || !title.trim() || !bodyMarkdown.trim()}>
            <BusyButtonContent busy={busy}>{editing ? tr("保存修改") : tr("action.feedback.create")}</BusyButtonContent>
          </button>
        </div>
      </form>
    </Modal>
  );
}

function FeedbackDetailView({
  id,
  admin,
  refreshToken,
  notify,
  onBack,
  onRead
}: {
  id: string;
  admin: boolean;
  refreshToken: number;
  notify: FeedbackNotify;
  onBack: () => void;
  onRead?: () => void;
}) {
  const { request: api, busy: mutationBusy, writing: mutationWriting } = useConflictApi();
  const dialog = useAppDialog();
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;
  const [ticket, setTicket] = useState<FeedbackTicketDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  const [commentImages, setCommentImages] = useState<File[]>([]);
  const [commenting, setCommenting] = useState(false);
  const [nextStatus, setNextStatus] = useState<FeedbackStatus | "">("");
  const [processingNote, setProcessingNote] = useState("");
  const [changing, setChanging] = useState(false);
  const detailState = useRef({ nextStatus, processingNote });
  detailState.current = { nextStatus, processingNote };
  const statusVersion = useRef<number | null>(null);
  const loadSequence = useRef(0);
  const readController = useRef<AbortController | null>(null);
  useEffect(() => () => readController.current?.abort(), []);
  const load = useCallback(async () => {
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    const sequence = ++loadSequence.current;
    try {
      const result = await withRequestDeadline(signal => api<{ ticket: FeedbackTicketDetail }>(`${admin ? "/admin" : ""}/feedback/${id}`, { signal }), controller.signal);
      if (controller.signal.aborted) return;
      if (sequence !== loadSequence.current || mutationWriting.current) return;
      setTicket(current => current && current.version > result.ticket.version ? current : result.ticket);
      if (!detailState.current.nextStatus && !detailState.current.processingNote) statusVersion.current = Math.max(statusVersion.current ?? 0, result.ticket.version);
      onReadRef.current?.();
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof EditCancelled) return;
      notify("error", error instanceof Error ? error.message : tr("反馈加载失败"));
    } finally {
      if (controller.signal.aborted) return;
      setLoading(false);
    }
  }, [admin, id, notify]);
  useEffect(() => { void load(); }, [load, refreshToken]);

  if (loading) return <div className="content-loading"><RefreshCw className="spin" />{tr("正在载入")}</div>;
  if (!ticket) return <div className="page-shell"><EmptyState icon={CircleAlert} title={tr("反馈不存在")} /></div>;

  const withdraw = async () => {
    if (!(await dialog.confirm({ title: tr("撤回反馈"), message: tr("撤回后反馈将完全只读，且管理员不能恢复。"), confirmLabel: tr("确认撤回"), tone: "danger" }))) return;
    try {
      const result = await api<{ ticket: FeedbackTicketDetail }>(`/feedback/${id}/withdraw`, {
        method: "POST", body: jsonBody({ expectedVersion: ticket.version })
      });
      setTicket(result.ticket);
      notify("success", tr("反馈已撤回"));
    } catch (error) {
      if (error instanceof EditCancelled) return;
      notify("error", error instanceof Error ? error.message : tr("撤回失败"));
      if (error instanceof ApiError && error.status === 409) void load();
    }
  };

  const submitComment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!comment.trim() || mutationWriting.current) return;
    setCommenting(true);
    try {
      const result = await api<{ ticket: FeedbackTicketDetail }>(`${admin ? "/admin" : ""}/feedback/${id}/comments`, {
        method: "POST", body: feedbackMultipart({ bodyMarkdown: comment }, commentImages)
      });
      setTicket(result.ticket);
      setComment("");
      setCommentImages([]);
      notify("success", tr("评论已发送"));
    } catch (error) {
      if (error instanceof EditCancelled) return;
      notify("error", error instanceof Error ? error.message : tr("评论发送失败"));
    } finally {
      setCommenting(false);
    }
  };

  const changeStatus = async () => {
    if (!nextStatus || !processingNote.trim() || mutationWriting.current) return;
    setChanging(true);
    try {
      const result = await api<{ ticket: FeedbackTicketDetail }>(`/admin/feedback/${id}/status`, {
        method: "PUT",
        body: jsonBody({ expectedVersion: statusVersion.current ?? ticket.version, status: nextStatus, processingNote })
      });
      setTicket(result.ticket);
      setNextStatus("");
      setProcessingNote("");
      statusVersion.current = result.ticket.version;
      notify("success", tr("反馈状态已更新"));
    } catch (error) {
      if (error instanceof EditCancelled) return;
      notify("error", error instanceof Error ? error.message : tr("状态更新失败"));
      if (error instanceof ApiError && error.status === 409) void load();
    } finally {
      setChanging(false);
    }
  };

  const changeLevel = async (level: FeedbackLevel) => {
    if (level === ticket.level || mutationWriting.current) return;
    setChanging(true);
    try {
      const result = await api<{ ticket: FeedbackTicketDetail }>(`/admin/feedback/${id}/level`, {
        method: "PUT", body: jsonBody({ expectedVersion: ticket.version, level })
      });
      setTicket(result.ticket);
      notify("success", tr("反馈等级已更新"));
    } catch (error) {
      if (error instanceof EditCancelled) return;
      notify("error", error instanceof Error ? error.message : tr("等级更新失败"));
      if (error instanceof ApiError && error.status === 409) void load();
    } finally {
      setChanging(false);
    }
  };

  return (
    <div className={`page-shell feedback-detail-page${admin ? " admin-feedback-detail" : ""}`}>
      <button type="button" className="feedback-back-button" onClick={onBack}><ChevronLeft size={16} />{tr("返回反馈列表")}</button>
      <section className="card feedback-detail-header">
        <div>
          <span className="feedback-ticket-number">{ticket.displayNumber}</span>
          <div className="feedback-detail-title-row">
            <h1>{ticket.title}</h1>
            <div className="feedback-intrinsic-badges">
              <FeedbackPill value={ticket.type}>{feedbackTypeLabel(ticket.type)}</FeedbackPill>
              <FeedbackPill tone="level" value={ticket.level}>{feedbackLevelLabel(ticket.level)}</FeedbackPill>
            </div>
          </div>
          <p>{ticket.submittedByName} · {formatChina(ticket.createdAt)} {tr("提交")}</p>
        </div>
        <div className="feedback-detail-status">
          <FeedbackPill tone="status" value={ticket.status}>{feedbackStatusLabel(ticket.status)}</FeedbackPill>
        </div>
        {!admin && (ticket.canEdit || ticket.canWithdraw) && (
          <div className="feedback-detail-actions">
            {ticket.canEdit && <button type="button" className="secondary-button" onClick={() => setEditing(true)}><Pencil size={15} />{tr("编辑")}</button>}
            {ticket.canWithdraw && <button type="button" className="danger-button" onClick={() => void withdraw()}>{tr("撤回")}</button>}
          </div>
        )}
      </section>
      {admin && ticket.status !== "WITHDRAWN" && (
        <section className="card feedback-admin-actions">
          <div>
            <ChoiceField
              label={tr("调整等级")}
              disabled={mutationBusy || changing}
              value={ticket.level}
              options={feedbackLevelsFor(ticket.type).map((value) => ({
                value,
                label: feedbackLevelLabel(value)
              }))}
              onChange={(value) => void changeLevel(value as FeedbackLevel)}
            />
          </div>
          <div className="feedback-status-change">
            <ChoiceField
              label={tr("变更状态")}
              disabled={mutationBusy || changing}
              value={nextStatus}
              options={[
                { value: "", label: tr("选择新状态") },
                ...feedbackStatusesFor(ticket.type)
                  .filter((value) => value !== ticket.status)
                  .map((value) => ({ value, label: feedbackStatusLabel(value) }))
              ]}
              onChange={(value) => setNextStatus(value as FeedbackStatus)}
            />
            <Field label={tr("处理说明")}>
              <textarea disabled={mutationBusy || changing} maxLength={10000} value={processingNote} onChange={(event) => setProcessingNote(event.target.value)} />
            </Field>
            <button type="button" className="primary-button" disabled={mutationBusy || changing || !nextStatus || !processingNote.trim()} onClick={() => void changeStatus()}>
              <BusyButtonContent busy={changing}>{tr("更新状态")}</BusyButtonContent>
            </button>
          </div>
        </section>
      )}
      <section className="card feedback-current-content">
        <h2>{tr("反馈内容")}</h2>
        <AnnouncementMarkdown markdown={ticket.bodyMarkdown} />
        <FeedbackAttachments attachments={ticket.attachments} />
      </section>
      <section className="feedback-timeline">
        <h2>{tr("处理时间线")}</h2>
        {ticket.activities.map((activity) => (
          <article className="card feedback-activity" key={activity.id}>
            <div className="feedback-activity-marker"><MessageSquare size={15} /></div>
            <div>
              <header>
                <strong>{activity.actorName}</strong>
                <span>{feedbackActivityTitle(activity)}</span>
                <time>{formatChina(activity.createdAt)}</time>
              </header>
              {activity.bodyMarkdown && <AnnouncementMarkdown markdown={activity.bodyMarkdown} />}
              {activity.changedFields.length > 0 && <p className="feedback-changed-fields">{tr("已更新：")}{activity.changedFields.map(feedbackChangedFieldLabel).join("、")}</p>}
              <FeedbackAttachments attachments={activity.attachments} />
            </div>
          </article>
        ))}
      </section>
      {ticket.canComment && (
        <form className="card feedback-comment-form" onSubmit={(event) => void submitComment(event)}>
          <Field label={admin ? tr("管理员回复") : tr("追加评论")}>
            <textarea disabled={mutationBusy || commenting} maxLength={10000} value={comment} onChange={(event) => setComment(event.target.value)} />
          </Field>
          <FeedbackImagePicker
            compact
            disabled={mutationBusy || commenting}
            files={commentImages}
            onChange={setCommentImages}
            onError={(message) => notify("error", message)}
          />
          <div className="feedback-comment-actions">
            <button className="primary-button" disabled={mutationBusy || commenting || !comment.trim()}><Send size={15} /><BusyButtonContent busy={commenting}>{tr("发送评论")}</BusyButtonContent></button>
          </div>
        </form>
      )}
      {editing && (
        <FeedbackEditorModal
          ticket={ticket}
          notify={notify}
          onClose={() => setEditing(false)}
          onSaved={(updated) => { setTicket(updated); setEditing(false); notify("success", tr("反馈已更新")); }}
        />
      )}
    </div>
  );
}

function FeedbackAttachments({ attachments }: { attachments: FeedbackAttachment[] }) {
  if (!attachments.length) return null;
  return (
    <div className="feedback-attachments">
      {attachments.map((attachment) => (
        <a key={attachment.id} href={attachment.contentUrl} target="_blank" rel="noreferrer">
          <img src={attachment.contentUrl} alt={attachment.originalName} />
          <span>{attachment.originalName}</span>
        </a>
      ))}
    </div>
  );
}

function feedbackActivityTitle(activity: FeedbackTicketDetail["activities"][number]) {
  if (activity.kind === "CREATED") return tr("提交了反馈");
  if (activity.kind === "COMMENT") return tr("追加了评论");
  if (activity.kind === "CONTENT_UPDATED") return tr("更新了反馈内容");
  if (activity.kind === "WITHDRAWN") return tr("撤回了反馈");
  if (activity.kind === "STATUS_CHANGED" && activity.toStatus) return tr("将状态改为“{{v0}}”", { v0: feedbackStatusLabel(activity.toStatus) });
  if (activity.kind === "LEVEL_CHANGED" && activity.toLevel) return tr("将等级改为“{{v0}}”", { v0: feedbackLevelLabel(activity.toLevel) });
  return tr("更新了反馈");
}

function feedbackChangedFieldLabel(value: string) {
  return ({ title: tr("标题"), bodyMarkdown: tr("正文"), level: tr("等级"), attachments: tr("图片") } as Record<string, string>)[value] ?? value;
}

export function FeedbackAdminPanel({
  feedbackId,
  refreshToken,
  notify,
  onOpen,
  onUnreadCountRefresh
}: {
  feedbackId?: string;
  refreshToken: number;
  notify: FeedbackNotify;
  onOpen: (id?: string) => void;
  onUnreadCountRefresh: () => Promise<void>;
}) {
  const [tickets, setTickets] = useState<FeedbackTicketSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [level, setLevel] = useState("");
  const load = useCallback(async () => {
    if (feedbackId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (type) params.set("type", type);
      if (status) params.set("status", status);
      if (level) params.set("level", level);
      const result = await api<{ tickets: FeedbackTicketSummary[]; nextCursor: string | null }>(`/admin/feedback${params.size ? `?${params}` : ""}`);
      setTickets(result.tickets);
      setNextCursor(result.nextCursor);
    } catch (error) {
      if (error instanceof EditCancelled) return;
      notify("error", error instanceof Error ? error.message : tr("反馈队列加载失败"));
    } finally {
      setLoading(false);
    }
  }, [feedbackId, level, notify, search, status, type]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 180); return () => window.clearTimeout(timer); }, [load, refreshToken]);
  if (feedbackId) {
    return <FeedbackDetailView id={feedbackId} admin refreshToken={refreshToken} notify={notify} onBack={() => onOpen()} onRead={() => void onUnreadCountRefresh()} />;
  }
  return (
    <div className="feedback-admin-page">
      <PageHeader title={tr("反馈处理")} />
      <div className="feedback-filter-bar card feedback-admin-filters">
        <label className="feedback-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tr("搜索编号或标题")} /></label>
        <SelectControl
          ariaLabel={tr("类型")}
          value={type}
          options={[
            { value: "", label: tr("全部类型") },
            { value: "ISSUE", label: tr("问题单") },
            { value: "REQUIREMENT", label: tr("需求单") }
          ]}
          onChange={setType}
        />
        <SelectControl
          ariaLabel={tr("状态")}
          value={status}
          options={[
            { value: "", label: tr("全部状态") },
            ...Object.entries(feedbackStatusLabels).map(([value, label]) => ({
              value,
              label: trDynamic(label)
            }))
          ]}
          onChange={setStatus}
        />
        <SelectControl
          ariaLabel={tr("等级")}
          value={level}
          options={[
            { value: "", label: tr("全部等级") },
            ...Object.entries(feedbackLevelLabels).map(([value, label]) => ({
              value,
              label: trDynamic(label)
            }))
          ]}
          onChange={setLevel}
        />
      </div>
      {loading ? <div className="content-loading"><RefreshCw className="spin" />{tr("正在载入")}</div> : tickets.length ? (
        <>
          <div className="card feedback-admin-table">
            {tickets.map((ticket) => (
              <button type="button" key={ticket.id} onClick={() => onOpen(ticket.id)}>
                <span className="feedback-ticket-number">{ticket.displayNumber}</span>
                <span>
                  <span className="feedback-ticket-title-row">
                    <strong>{ticket.title}</strong>
                    <span className="feedback-intrinsic-badges">
                      <FeedbackPill value={ticket.type}>{feedbackTypeLabel(ticket.type)}</FeedbackPill>
                      <FeedbackPill tone="level" value={ticket.level}>{feedbackLevelLabel(ticket.level)}</FeedbackPill>
                    </span>
                  </span>
                  <small>{ticket.submittedByName} · {formatChina(ticket.updatedAt)}</small>
                </span>
                <span className="feedback-ticket-status">
                  <FeedbackPill tone="status" value={ticket.status}>{feedbackStatusLabel(ticket.status)}</FeedbackPill>
                </span>
                <ChevronRight size={17} />
              </button>
            ))}
          </div>
          {nextCursor && (
            <button type="button" className="secondary-button feedback-load-more" onClick={async () => {
              const params = new URLSearchParams({ cursor: nextCursor });
              if (search.trim()) params.set("search", search.trim());
              if (type) params.set("type", type);
              if (status) params.set("status", status);
              if (level) params.set("level", level);
              try {
                const result = await api<{ tickets: FeedbackTicketSummary[]; nextCursor: string | null }>(`/admin/feedback?${params}`);
                setTickets((current) => [...current, ...result.tickets]);
                setNextCursor(result.nextCursor);
              } catch (error) {
                if (error instanceof EditCancelled) return;
                notify("error", error instanceof Error ? error.message : tr("更多反馈加载失败"));
              }
            }}>{tr("加载更多")}</button>
          )}
        </>
      ) : <EmptyState icon={MessageSquare} title={tr("没有匹配的反馈")} />}
    </div>
  );
}
