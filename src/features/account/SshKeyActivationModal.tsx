import type { PersonalKey } from "./ssh-key-types";
import { useEffect, useRef, useState } from "react";
import { KeyRound, Search, Server, Trash2 } from "lucide-react";
import { api, jsonBody } from "../../api";
import { Modal } from "../../Modal";
import { currentLocale } from "../../i18n";
import { SshKeyNotice } from "./SshKeyNotice";
import { machineSelectionState, selectMachineChoices } from "./ssh-key-selection";
type Machine = {
  id: string;
  name: string;
  address: string;
  active: boolean;
  available: boolean;
  syncEnabled: boolean;
};
export function SshKeyActivationModal({
  publicKey,
  onClose,
  onSaved,
  onDelete,
}: {
  publicKey: { id: string; name: string; fingerprint: string };
  onClose: () => void;
  onSaved: (keys: PersonalKey[]) => void;
  onDelete: () => void;
}) {
  const t = (zh: string, en: string) => (currentLocale() === "en" ? en : zh);
  const [machines, setMachines] = useState<Machine[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api<{ machines: Machine[] }>(
      `/auth/ssh-keys/${publicKey.id}/activations`,
    )
      .then((r) => {
        if (active) {
          setMachines(r.machines);
          setSelected(r.machines.filter((m) => m.active).map((m) => m.id));
          setLoaded(true);
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
  }, [publicKey.id]);
  const filtered = machines.filter((m) =>
    (m.name + " " + m.address).toLowerCase().includes(search.toLowerCase()),
  );
  const selectAll = useRef<HTMLInputElement>(null);
  const selection = machineSelectionState(filtered, selected);
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = selection.mixed;
  }, [selection.mixed]);
  return (
    <Modal
      title={t("管理公钥", "Manage public key")}
      className="ssh-key-modal"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="stack-form ssh-key-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || !loaded) return;
          setBusy(true);
          setError("");
          try {
            const r = await api<{ keys: PersonalKey[] }>(
              `/auth/ssh-keys/${publicKey.id}/activations`,
              { method: "PUT", body: jsonBody({ machineIds: selected }) },
            );
            onSaved(r.keys);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="ssh-key-summary">
          <span className="ssh-key-symbol"><KeyRound size={19} aria-hidden="true" /></span>
          <div className="ssh-key-identity">
            <strong>{publicKey.name}</strong>
            <code>{publicKey.fingerprint}</code>
          </div>
        </div>
        <div className="ssh-machine-heading">
          <label className="ssh-key-checkbox">
            <input
              ref={selectAll}
              type="checkbox"
              checked={selection.checked}
              aria-checked={selection.mixed ? "mixed" : selection.checked}
              disabled={!loaded || busy || !selection.ids.length}
              onChange={(e) => setSelected((old) => selectMachineChoices(old, selection.ids, e.target.checked))}
            />
            <span>{search.trim() ? t("全选搜索结果", "Select all results") : t("全选机器", "Select all machines")}</span>
          </label>
          <span className={`ssh-key-count${selected.length ? " is-active" : ""}`}>{t("已选 ", "Selected: ")}{selected.length}</span>
        </div>
        <label className="ssh-machine-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            aria-label={t("搜索机器", "Search machines")}
            placeholder={t("搜索机器名称或地址", "Search name or address")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            disabled={loading || busy}
          />
        </label>
        {loading ? (
          <div className="mini-empty">{t("正在加载…", "Loading…")}</div>
        ) : !loaded ? null : machines.length === 0 ? (
          <div className="mini-empty">
            {t(
              "暂无可激活的机器，请先申请机器使用权。",
              "No machines available. Apply for machine access first.",
            )}
          </div>
        ) : (
          <div className="ssh-machine-list" role="group" aria-label={t("激活机器", "Activated machines")}>
            {filtered.map((m) => (
              <label
                key={m.id}
                className={`ssh-machine-option${selected.includes(m.id) ? " is-selected" : ""}${!m.available ? " is-unavailable" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={selected.includes(m.id)}
                  disabled={busy || (!m.available && !m.active)}
                  onChange={(e) =>
                    setSelected((old) =>
                      e.target.checked
                        ? [...old, m.id]
                        : old.filter((id) => id !== m.id),
                    )
                  }
                />
                <Server size={19} className="ssh-machine-icon" aria-hidden="true" />
                <span className="ssh-machine-identity">
                  <span className="ssh-machine-title"><strong>{m.name}</strong>{!m.syncEnabled && <span className="ssh-machine-sync-note">{t("未开启同步 · 仅预配置", "Sync off · Preconfigured only")}</span>}</span>
                  <small>
                    {m.address}
                    {!m.available
                      ? " · " +
                        t(
                          "不可用",
                          "Unavailable",
                        )
                      : ""}
                  </small>
                </span>
              </label>
            ))}
            {!filtered.length && (
              <div className="mini-empty">
                {t("没有匹配的机器", "No matching machines")}
              </div>
            )}
          </div>
        )}
        <div className="modal-actions ssh-key-actions">
          <button
            type="button"
            className="ssh-key-delete"
            disabled={busy}
            onClick={onDelete}
          >
            <Trash2 size={15} aria-hidden="true" />{t("删除公钥", "Delete key")}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={onClose}
          >
            {t("取消", "Cancel")}
          </button>
          <button
            className="primary-button"
            disabled={!loaded || busy}
          >
            {busy
              ? t("保存中…", "Saving…")
              : t("保存设置", "Save settings")}
          </button>
        </div>
      </form>
      {error && <SshKeyNotice message={error} onClose={() => setError("")} />}
    </Modal>
  );
}
