import { Modal } from "../../Modal";
import { currentLocale } from "../../i18n";

export function SshKeyNotice({ message, onClose }: { message: string; onClose: () => void }) {
  const en = currentLocale() === "en";
  return (
    <Modal title={en ? "Unable to complete the operation" : "操作未完成"} onClose={onClose} className="ssh-key-modal">
      <div className="action-dialog">
        <p className="action-dialog-message danger">{message}</p>
        <div className="modal-actions">
          <button type="button" className="primary-button" onClick={onClose}>{en ? "Got it" : "知道了"}</button>
        </div>
      </div>
    </Modal>
  );
}
