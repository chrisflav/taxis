import { useEffect, useState } from "react";

// A simple centered modal dialog. Click the backdrop or press Escape to dismiss.
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// Guards a modal's close (backdrop click, Escape, explicit Cancel) behind a discard confirmation
// whenever `dirty` is true, instead of silently losing what was entered.
export function useConfirmClose(dirty: boolean, close: () => void) {
  const [confirming, setConfirming] = useState(false);
  return {
    requestClose: () => (dirty ? setConfirming(true) : close()),
    confirming,
    confirmDiscard: () => { setConfirming(false); close(); },
    cancelDiscard: () => setConfirming(false),
  };
}

// A yes/no confirmation dialog.
export function ConfirmModal({
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <p>{message}</p>
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
        <button onClick={onCancel}>Cancel</button>
        <button className={danger ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}
