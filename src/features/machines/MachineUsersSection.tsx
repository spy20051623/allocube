import { EditCancelled } from "../../edit-conflict";
import { useRealtimeRefresh } from "../../useRealtimeRefresh";
import { Modal } from "../../Modal";
import { tr } from "../../i18n/index";
import { Check, X, UserPlus, ShieldCheck, ShieldOff, UserMinus, Search, RefreshCw } from "lucide-react";
import { useState, useCallback, useEffect } from "react";
import { jsonBody, api, ApiError } from "../../api";
import { formatChinaFullMinute } from "../../date";
import { useConflictApi } from "../../app/useConflictApi";
import { SectionHeader } from "../../components/SectionHeader";
import { useAppDialog } from "../../components/dialogs";
import { ContextNotice } from "../../components/feedback";

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

  const fetchLoad = useCallback(async (signal: AbortSignal) => {
    try {
      const result = await api<{ members: any[]; requests: any[] }>(
        `/admin/machines/${machine.id}/access`, { signal }
      );
      if (signal.aborted) return;
      setAccess(result);
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
    <div className="machine-section-stack">
      {canManage && access.requests.length > 0 && (
        <section className="card panel-card machine-requests-panel">
          <SectionHeader title={tr("申请列表")} actions={<span className="request-count">{access.requests.length}</span>} />
          <div className="machine-request-list">
            {access.requests.map((item) => (
              <div className="machine-request-row" key={item.id}>
                <div className="member-identity">
                  <div className="avatar small">{item.displayName.slice(0, 1)}</div>
                  <span><strong>{item.displayName}</strong><small>@{item.username} · {item.employeeNumber || tr("暂无工号")}</small></span>
                </div>
                <p>{item.reason || tr("未填写申请理由")}</p>
                <time>{formatChinaFullMinute(item.createdAt)}</time>
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
            <span>{tr("用户")}</span><span>{tr("身份")}</span><span>{tr("加入时间")}</span><span />
          </div>
          {access.members.map((member) => (
            <div
              className="machine-member-row"
              key={member.id ?? `${member.username}:${member.grantedAt}`}
            >
              <div className="member-identity">
                <div className="avatar small">{member.displayName.slice(0, 1)}</div>
                <span><strong>{member.displayName}</strong><small>@{member.username} · {member.employeeNumber || tr("暂无工号")}</small></span>
              </div>
              <span className={`state-chip ${member.role === "MACHINE_ADMIN" ? "active" : "member"}`}>
                {member.role === "MACHINE_ADMIN" ? tr("管理员") : tr("使用者")}
              </span>
              <span>{formatChinaFullMinute(member.grantedAt)}</span>
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
    </div>
  );
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
    <Modal title={tr("邀请用户")} onClose={onClose}>
      <div className="stack-form invite-member-modal">
        <label className="search-box">
          <Search size={16} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tr("搜索姓名、用户名或工号")}
          />
        </label>
        <ContextNotice>{tr("添加后，该用户将立即获得这台机器的使用权。")}</ContextNotice>
        <div className="invite-candidate-list">
          {loading ? (
            <div className="mini-empty"><RefreshCw size={15} className="spin" />{tr("正在查找")}</div>
          ) : users.length ? users.map((user) => (
            <div key={user.id}>
              <div className="member-identity">
                <div className="avatar small">{user.displayName.slice(0, 1)}</div>
                <span>
                  <strong>{user.displayName}</strong>
                  <small>@{user.username} · {user.employeeNumber || tr("暂无工号")}</small>
                </span>
              </div>
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
                      body: jsonBody({ userId: user.id })
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
