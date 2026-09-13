import { EditCancelled } from "../../edit-conflict";
import { useRealtimeRefresh } from "../../useRealtimeRefresh";
import { Modal } from "../../Modal";
import { tr } from "../../i18n/index";
import { Check, X, UserPlus, ShieldCheck, ShieldOff, UserMinus, Search, RefreshCw, Pencil } from "lucide-react";
import { useState, useCallback, useEffect } from "react";
import { jsonBody, api, ApiError } from "../../api";
import { formatChinaFullMinute } from "../../date";
import { useConflictApi } from "../../app/useConflictApi";
import { SectionHeader } from "../../components/SectionHeader";
import { useAppDialog } from "../../components/dialogs";
import { ContextNotice } from "../../components/feedback";
import { AccessExpiryField, accessExpiryValue, accessExpiryLabel, accessExpiryInput, defaultAccessExpiryInput } from "./AccessExpiryField";

type AccessIdentity = { displayName: string; username: string; employeeNumber?: string | null };

function MemberIdentity({ user }: { user: AccessIdentity }) {
  return <div className="member-identity">
    <div className="avatar small" aria-hidden="true">{user.displayName.slice(0, 1)}</div>
    <span><strong title={user.displayName}>{user.displayName}</strong><small>@{user.username}{user.employeeNumber ? ` · ${user.employeeNumber}` : ""}</small></span>
  </div>;
}

function ExpiryCell({ item, onEdit }: { item: { displayName: string; expiresAt: string | null; expired?: boolean }; onEdit?: () => void }) {
  const label = accessExpiryLabel(item.expiresAt);
  return <div className={`access-expiry-cell${item.expired ? " expired" : ""}`}>
    {onEdit ? <button type="button" className="access-expiry-button" onClick={onEdit}
      aria-label={tr("修改 {{v0}} 的到期时间", { v0: item.displayName })}><span>{label}</span><Pencil size={12} aria-hidden="true" /></button>
      : <span className="access-expiry-readonly">{label}</span>}
    {item.expired && <small>{tr("已过期")}</small>}
  </div>;
}

export function MachineUsersSection({
  machine,
  isSystemAdmin,
  canManage,
  notify,
  reloadMachines
}: {
  machine: any;
  isSystemAdmin: boolean;
  canManage: boolean;
  notify: (kind: "success" | "error", message: string) => void;
  reloadMachines: () => Promise<any[]>;
}) {
  const { request: api, dialog } = useConflictApi();
  const [access, setAccess] = useState<{ members: any[]; requests: any[] }>({
    members: [],
    requests: []
  });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editingExpiry, setEditingExpiry] = useState<{ item: any; pending: boolean } | null>(null);

  const fetchLoad = useCallback(async (signal: AbortSignal) => {
    try {
      const result = await api<{ members: any[]; requests: any[] }>(
        `/admin/machines/${machine.id}/access`, { signal }
      );
      if (signal.aborted) return;
      setAccess(result);
      setEditingExpiry(current => {
        if (!current) return null;
        const latest = (current.pending ? result.requests : result.members).find(item => item.id === current.item.id);
        return !latest || latest.role === "MACHINE_ADMIN" ? null : current;
      });
    } catch (error) {
      if (error instanceof EditCancelled) return;
      if (signal.aborted) return;
      notify("error", error instanceof Error ? error.message : tr("用户权限加载失败"));
    }
  }, [machine.id, notify]);
  const load = useRealtimeRefresh(fetchLoad, ["access"], { filter: () => ({ machineId: machine.id }) });

  useEffect(() => { void load(); }, [load]);

  const refresh = async () => {
    await Promise.all([load(), reloadMachines()]);
  };

  return (
    <div className="machine-section-stack machine-access-section">
      {canManage && access.requests.length > 0 && (
        <section className="card panel-card machine-requests-panel">
          <SectionHeader title={tr("申请列表")} actions={<span className="request-count">{access.requests.length}</span>} />
          <div className="machine-request-list">
            <div className="machine-request-row machine-member-head"><span>{tr("用户")}</span><span>{tr("申请理由")}</span><span>{tr("申请时间")}</span><span>{tr("到期日期")}</span><span /></div>
            {access.requests.map((item) => (
              <div className="machine-request-row" key={item.id}>
                <div><MemberIdentity user={item} />{item.previousExpiresAt && <small className="renewal-request-label">{tr("延期申请")}</small>}</div>
                <p className="access-request-reason" title={item.reason || undefined}>{item.reason || "—"}</p>
                <time dateTime={item.createdAt}>{formatChinaFullMinute(item.createdAt)}</time>
                <div className="renewal-expiry-comparison">{item.previousExpiresAt && <small>{accessExpiryLabel(item.previousExpiresAt)} →</small>}<ExpiryCell item={item} onEdit={() => setEditingExpiry({ item, pending: true })} /></div>
                <div className="row-actions">
                  <button className="icon-button tiny list-icon-action approve" title={tr("通过申请")} onClick={async () => {
                    try {
                      await api(`/admin/machine-access/requests/${item.id}/approve`, {
                        method: "POST",
                        body: jsonBody({ expectedVersion: item.expectedVersion })
                      });
                      notify("success", tr("{{v0}} 已获得机器使用权", { v0: item.displayName }));
                    } catch (error) {
                      if (error instanceof EditCancelled) return;
                      notify("error", error instanceof Error ? error.message : tr("审批失败"));
                    } finally {
                      await refresh();
                    }
                  }}><Check size={15} /></button>
                  <button className="icon-button tiny list-icon-action danger" title={tr("拒绝申请")} onClick={async () => {
                    const reason = await dialog.prompt({
                      title: tr("拒绝使用权申请"),
                      message: tr("拒绝 {{v0}} 对 {{v1}} 的使用权申请。", { v0: item.displayName, v1: machine.name }),
                      label: tr("原因（选填）"),
                      multiline: true,
                      maxLength: 500,
                      confirmLabel: tr("确认拒绝"),
                      tone: "danger"
                    });
                    if (reason === null) return;
                    try {
                      await api(`/admin/machine-access/requests/${item.id}/reject`, {
                        method: "POST",
                        body: jsonBody({ expectedVersion: item.expectedVersion, reason })
                      });
                      notify("success", tr("使用权申请已拒绝"));
                    } catch (error) {
                      if (error instanceof EditCancelled) return;
                      notify("error", error instanceof Error ? error.message : tr("操作失败"));
                    } finally {
                      await refresh();
                    }
                  }}><X size={15} /></button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card panel-card machine-access-panel">
        <SectionHeader
          title={tr("用户列表")}
          actions={canManage ? <button className="secondary-button compact" onClick={() => setInviteOpen(true)}><UserPlus size={15} />{tr("action.machineUser.invite")}</button> : undefined}
        />
        <div className="machine-member-list">
          <div className="machine-member-row machine-member-head">
            <span>{tr("用户")}</span><span>{tr("身份")}</span><span>{tr("加入时间")}</span><span>{tr("到期日期")}</span><span />
          </div>
          {access.members.map((member) => (
            <div
              className="machine-member-row"
              key={member.id ?? `${member.username}:${member.grantedAt}`}
            >
              <MemberIdentity user={member} />
              <span className={`state-chip ${member.role === "MACHINE_ADMIN" ? "active" : "member"}`}>
                {member.role === "MACHINE_ADMIN" ? tr("管理员") : tr("使用者")}
              </span>
              <time dateTime={member.grantedAt}>{formatChinaFullMinute(member.grantedAt)}</time>
              <ExpiryCell item={member} onEdit={canManage && member.role !== "MACHINE_ADMIN" ? () => setEditingExpiry({ item: member, pending: false }) : undefined} />
              <div className="row-actions">
                {canManage && isSystemAdmin && member.role === "MEMBER" && (
                  <button className="icon-button tiny list-icon-action" title={tr("设为管理员")} onClick={async () => {
                    try {
                      await api(`/admin/machines/${machine.id}/managers/${member.id}`, { method: "PUT", body: "{}" });
                      notify("success", tr("{{v0}} 已设为机器管理员", { v0: member.displayName }));
                      await refresh();
                    } catch (error) {
                      if (error instanceof EditCancelled) return;
                      notify("error", error instanceof Error ? error.message : tr("设置管理员失败"));
                    }
                  }}><ShieldCheck size={15} /></button>
                )}
                {canManage && isSystemAdmin && member.role === "MACHINE_ADMIN" && (
                  <button className="icon-button tiny list-icon-action" title={tr("取消管理员")} onClick={async () => {
                    if (!(await dialog.confirm({
                      title: tr("取消管理员身份"),
                      message: tr("确认取消 {{v0}} 的机器管理员身份？该用户仍保留普通使用权。", { v0: member.displayName }),
                      confirmLabel: tr("确认取消")
                    }))) return;
                    try {
                      await api(`/admin/machines/${machine.id}/managers/${member.id}`, { method: "DELETE" });
                      notify("success", tr("管理员身份已取消"));
                      await refresh();
                    } catch (error) {
                      if (error instanceof EditCancelled) return;
                      notify("error", error instanceof Error ? error.message : tr("取消管理员失败"));
                    }
                  }}><ShieldOff size={15} /></button>
                )}
                {canManage && (member.role === "MEMBER" || isSystemAdmin) && (
                  <button className="icon-button tiny list-icon-action danger" title={tr("移除用户")} onClick={async () => {
                    const impact = member.impact;
                    const detail = [
                      impact.activeReservations && tr("{{v0}} 条进行中占用", { v0: impact.activeReservations }),
                      impact.futureReservations && tr("{{v0}} 条未来占用", { v0: impact.futureReservations })
                    ].filter(Boolean).join("、");
                    if (!(await dialog.confirm({
                      title: tr("移除用户"),
                      message: tr("确认将 {{v0}} 移出 {{v1}}？{{v2}}", { v0: member.displayName, v1: machine.name, v2: detail ? `此操作会释放${detail}。` : "" }),
                      confirmLabel: tr("确认移除"),
                      tone: "danger"
                    }))) return;
                    try {
                      await api(`/admin/machines/${machine.id}/members/${member.id}`, { method: "DELETE" });
                      notify("success", tr("{{v0}} 已被移出机器", { v0: member.displayName }));
                      await refresh();
                    } catch (error) {
                      if (error instanceof EditCancelled) return;
                      notify("error", error instanceof Error ? error.message : tr("移除失败"));
                    }
                  }}><UserMinus size={15} /></button>
                )}
              </div>
            </div>
          ))}
          {!access.members.length && <div className="mini-empty">{tr("暂时没有显式授权用户")}</div>}
        </div>
      </section>
      {inviteOpen && canManage && (
        <InviteMachineMemberModal
          machine={machine}
          onClose={() => setInviteOpen(false)}
          onInvited={async () => {
            setInviteOpen(false);
            await refresh();
          }}
          notify={notify}
        />
      )}
      {editingExpiry && canManage && <AccessExpiryModal key={`${editingExpiry.pending}:${editingExpiry.item.id}`}
        item={editingExpiry.item} pending={editingExpiry.pending} onClose={() => setEditingExpiry(null)}
        onSave={async expiresAt => {
          try {
            const endpoint = editingExpiry.pending ? `/admin/machine-access/requests/${editingExpiry.item.id}/expiry`
              : `/admin/machines/${machine.id}/members/${editingExpiry.item.id}/expiry`;
            const result = await api<{ impact?: { cancelled: number; truncated: number } }>(endpoint, {
              method: "PATCH", body: jsonBody({ expiresAt, expectedVersion: editingExpiry.item.expectedVersion })
            });
            await refresh();
            notify("success", result.impact && (result.impact.cancelled || result.impact.truncated) ? tr("有效期已更新，取消 {{v0}} 条占用，截断 {{v1}} 条占用", { v0: result.impact.cancelled, v1: result.impact.truncated }) : tr("有效期已更新"));
            setEditingExpiry(null);
          } catch (error) {
            if (!(error instanceof EditCancelled)) notify("error", error instanceof Error ? error.message : tr("操作失败"));
            await refresh();
          }
        }} />}
    </div>
  );
}

function AccessExpiryModal({ item, pending, onClose, onSave }: {
  item: AccessIdentity & { expiresAt: string | null; previousExpiresAt?: string | null }; pending: boolean; onClose: () => void;
  onSave: (expiresAt: string | null) => Promise<void>;
}) {
  const [value, setValue] = useState(item.expiresAt ? accessExpiryInput(item.expiresAt) : defaultAccessExpiryInput());
  const [permanent, setPermanent] = useState(item.expiresAt === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const next = chinaLocalExpiry(value);
  const shortening = !pending && !permanent && next && (!item.expiresAt || next < item.expiresAt);
  return <Modal title={tr("修改有效期")} className="machine-access-modal" onClose={onClose}>
    <form className="stack-form" onSubmit={async event => {
      event.preventDefault();
      if (busy) return;
      setError(""); setBusy(true);
      try { await onSave(accessExpiryValue(value, permanent)); }
      catch (error) { setError(error instanceof Error ? error.message : tr("操作失败")); }
      finally { setBusy(false); }
    }}>
      <MemberIdentity user={item} />
      {pending && item.previousExpiresAt && <small className="catalog-access-expiry">{tr("原到期日期")}：{accessExpiryLabel(item.previousExpiresAt)}</small>}
      <AccessExpiryField value={value} onChange={setValue} permanent={permanent} onPermanentChange={setPermanent}
        presetBaseDate={pending && item.previousExpiresAt ? accessExpiryInput(item.previousExpiresAt) : undefined} />
      {shortening && <ContextNotice>{tr("超期占用将取消或截断，且不会自动恢复。")}</ContextNotice>}
      {error && <small className="field-inline-error" role="alert">{error}</small>}
      <div className="modal-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>{tr("取消")}</button>
        <button className="primary-button" disabled={busy}>{tr("保存")}</button>
      </div>
    </form>
  </Modal>;
}

function chinaLocalExpiry(value: string) {
  try { return accessExpiryValue(value, false); } catch { return null; }
}

function InviteMachineMemberModal({
  machine,
  onClose,
  onInvited,
  notify
}: {
  machine: any;
  onClose: () => void;
  onInvited: () => Promise<void>;
  notify: (kind: "success" | "error", message: string) => void;
}) {
  const dialog = useAppDialog();
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [expiry, setExpiry] = useState(defaultAccessExpiryInput);
  const [permanent, setPermanent] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const result = await api<{ users: any[] }>(
          `/admin/machines/${machine.id}/member-candidates?q=${encodeURIComponent(query)}`
        );
        setUsers(result.users);
      } catch (error) {
        if (error instanceof EditCancelled) return;
        notify(
          "error",
          error instanceof Error ? error.message : tr("候选用户加载失败")
        );
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [machine.id, notify, query]);

  return (
    <Modal title={tr("邀请用户")} className="machine-access-modal" onClose={onClose}>
      <div className="stack-form invite-member-modal">
        <AccessExpiryField value={expiry} onChange={setExpiry} permanent={permanent} onPermanentChange={setPermanent} />
        <label className="search-box">
          <Search size={16} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tr("搜索姓名、用户名或工号")}
          />
        </label>
        <div className="invite-candidate-list">
          {loading ? (
            <div className="mini-empty"><RefreshCw size={15} className="spin" />{tr("正在查找")}</div>
          ) : users.length ? users.map((user) => (
            <div key={user.id}>
              <MemberIdentity user={user} />
              <button
                type="button"
                className="icon-button tiny list-icon-action invite"
                title={tr("邀请用户")}
                aria-label={tr("邀请 {{v0}}", { v0: user.displayName })}
                disabled={Boolean(busyId)}
                onClick={async () => {
                  if (!(await dialog.confirm({
                    title: tr("邀请用户"),
                    message: tr("添加后，{{v0}} 将立即获得 {{v1}} 的使用权。", { v0: user.displayName, v1: machine.name }),
                    confirmLabel: tr("确认邀请")
                  }))) return;
                  setBusyId(user.id);
                  try {
                    await api(`/admin/machines/${machine.id}/members`, {
                      method: "POST",
                      body: jsonBody({ userId: user.id, expiresAt: accessExpiryValue(expiry, permanent) })
                    });
                    notify("success", tr("{{v0}} 已加入机器", { v0: user.displayName }));
                    await onInvited();
                  } catch (error) {
                    if (error instanceof EditCancelled) return;
                    if (
                      error instanceof ApiError &&
                      ["MACHINE_MEMBER_ALREADY_EXISTS", "MACHINE_ACCESS_REQUEST_PENDING"].includes(
                        error.code ?? ""
                      )
                    ) {
                      notify("error", error.message);
                      await onInvited();
                    } else {
                      notify(
                        "error",
                        error instanceof Error ? error.message : tr("邀请失败")
                      );
                    }
                  } finally {
                    setBusyId("");
                  }
                }}
              >
                {busyId === user.id ? <RefreshCw size={14} className="spin" /> : <UserPlus size={14} />}
              </button>
            </div>
          )) : <div className="mini-empty">{tr("没有可邀请的用户")}</div>}
        </div>
      </div>
    </Modal>
  );
}
