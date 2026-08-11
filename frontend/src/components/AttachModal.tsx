import { useEffect, useRef, useState } from "react";
import type { Actor, FileStore, PluginKind } from "../types";
import { api } from "../api";
import { Modal } from "./Modal";
import { AutoTextarea } from "./AutoTextarea";
import { SearchableSelect } from "./SearchableSelect";

// The issue detail view's two dialogues, kept out of that view's own module so they are not in the
// bundle that renders the page. Nothing here is on the path to a first paint: every one of these is
// behind a button, and the chunk arrives while the dialogue is opening.

// PUT a file to a presigned URL, reporting progress. XMLHttpRequest rather than fetch because
// fetch has no upload-progress events. The URL is the bucket, not our API: no credentials, and
// only the headers the signature covers.
function putFile(url: string, headers: Record<string, string>, file: File, onProgress: (frac: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`upload failed: HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("upload failed: network error (is CORS configured on the bucket?)"));
    xhr.send(file);
  });
}

// Drop zone for the `file` artifact kind: pick a store, upload straight to it through a presigned
// URL, and hand the resulting object coordinates back so they land in the form fields below —
// which stay visible and editable, and are what actually gets attached.
function FileUpload({ onUploaded, onError }: {
  onUploaded: (payload: { store: string; key: string; name: string; mime: string; size: number }) => void;
  onError: (msg: string) => void;
}) {
  // null: loading; "error": the list request failed (NOT the same as an empty list — claiming
  // "nothing is configured" on a flaky connection would send the operator debugging the wrong
  // thing); otherwise the configured stores.
  const [stores, setStores] = useState<FileStore[] | "error" | null>(null);
  const [store, setStore] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadStores = () => {
    setStores(null);
    api.fileStores()
      .then((s) => { setStores(s); if (s.length > 0) setStore(s[0].name); })
      .catch(() => setStores("error"));
  };
  useEffect(loadStores, []);

  const upload = (file: File) => {
    if (!store || progress != null) return;
    const mime = file.type || "application/octet-stream";
    setProgress(0);
    api.uploadTarget(store, file.name, mime)
      .then((target) =>
        putFile(target.url, target.headers, file, setProgress).then(() => {
          setProgress(null);
          onUploaded({ store: target.store, key: target.key, name: file.name, mime, size: file.size });
        }))
      .catch((e) => { setProgress(null); onError(String(e instanceof Error ? e.message : e)); });
  };

  if (stores === null) return null;
  if (stores === "error") {
    return (
      <p className="muted small">
        Couldn't load the file stores — <button type="button" className="ghost" onClick={loadStores}>retry</button>,
        or fill the fields in by hand.
      </p>
    );
  }
  if (stores.length === 0) {
    return <p className="muted small">No file store is configured on the server — fill the fields in by hand to link an already-hosted object.</p>;
  }
  return (
    <div>
      {stores.length > 1 && (
        <>
          <label>Upload to</label>
          <select value={store} onChange={(e) => setStore(e.target.value)}>
            {stores.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
        </>
      )}
      <div
        className={`drop-zone${over ? " drop-zone-over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const file = e.dataTransfer.files[0];
          if (file) upload(file);
        }}
      >
        {progress != null ? (
          <div style={{ width: "100%" }}>
            <div className="muted small">Uploading… {Math.round(progress * 100)}%</div>
            <div className="progress"><span style={{ width: `${progress * 100}%` }} /></div>
          </div>
        ) : (
          <>
            <span className="muted small">Drop a file here, or</span>
            <button type="button" className="ghost" onClick={() => fileInput.current?.click()}>Choose…</button>
            <input ref={fileInput} type="file" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
          </>
        )}
      </div>
    </div>
  );
}

// Modal for attaching *or editing* an artifact or check. Renders a form derived from the selected
// kind's field schema (from /api/plugins) and assembles the payload — no raw JSON needed.
//
// Editing passes `existing`, which seeds the fields from the stored payload and fixes the kind: the
// kind is what selects the schema the payload is written against, so changing it would leave the
// values describing nothing. Swapping kind is a remove and an attach.
export function AttachModal({
  title, kinds, existing, onClose, onSubmit, onDone,
}: {
  title: string;
  kinds: PluginKind[];
  existing?: { kind: string; value: unknown };
  onClose: () => void;
  onSubmit: (kind: string, value: unknown) => Promise<unknown>;
  onDone: () => void;
}) {
  const [kind, setKind] = useState(existing?.kind ?? "");
  // Seeded from the stored payload so an edit starts from what is there rather than from blank —
  // the schema's field names are exactly the payload's keys.
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    if (!existing) return {};
    const stored = (existing.value ?? {}) as Record<string, unknown>;
    const seeded: Record<string, string | boolean> = {};
    for (const f of kinds.find((k) => k.kind === existing.kind)?.fields ?? []) {
      const v = stored[f.name];
      seeded[f.name] = f.type === "boolean" ? !!v : v == null ? "" : String(v);
    }
    return seeded;
  });
  const [err, setErr] = useState<string | null>(null);

  const selected = kinds.find((k) => k.kind === kind);

  const chooseKind = (k: string) => {
    setKind(k);
    setErr(null);
    const kd = kinds.find((x) => x.kind === k);
    const init: Record<string, string | boolean> = {};
    kd?.fields.forEach((f) => { init[f.name] = f.type === "boolean" ? false : ""; });
    setValues(init);
  };
  const setField = (name: string, v: string | boolean) => setValues((prev) => ({ ...prev, [name]: v }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) { setErr("choose a kind"); return; }
    const payload: Record<string, unknown> = {};
    for (const f of selected.fields) {
      const raw = values[f.name];
      if (f.type === "boolean") { payload[f.name] = !!raw; continue; }
      const s = String(raw ?? "").trim();
      if (s === "") {
        if (f.required) { setErr(`${f.label} is required`); return; }
        continue;
      }
      if (f.type === "number") {
        const n = Number(s);
        if (Number.isNaN(n)) { setErr(`${f.label} must be a number`); return; }
        payload[f.name] = n;
      } else {
        payload[f.name] = s;
      }
    }
    onSubmit(kind, payload).then(onDone).catch((e2) => setErr(String(e2)));
  };

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit}>
        {err && <div className="error small">{err}</div>}
        <label>Kind</label>
        {existing ? (
          <>
            <div className="field-disabled">{existing.kind}</div>
            <div className="rail-empty" style={{ marginTop: 4 }}>
              The kind is fixed. To use a different one, remove this and add a new one.
            </div>
          </>
        ) : (
          <select value={kind} onChange={(e) => chooseKind(e.target.value)} required>
            <option value="" disabled>choose a kind…</option>
            {kinds.map((k) => <option key={k.kind} value={k.kind}>{k.kind}</option>)}
          </select>
        )}

        {selected && selected.fields.length === 0 && (
          <p className="muted small">No additional fields required.</p>
        )}
        {selected?.kind === "file" && !existing && (
          <FileUpload
            onUploaded={(p) => {
              setErr(null);
              setValues((prev) => ({ ...prev, store: p.store, key: p.key, name: p.name, mime: p.mime, size: String(p.size) }));
            }}
            onError={setErr}
          />
        )}
        {selected?.fields.map((f) => (
          <div key={f.name}>
            <label>{f.label}{f.required ? " *" : ""}</label>
            {f.type === "boolean" ? (
              <input type="checkbox" checked={!!values[f.name]} onChange={(e) => setField(f.name, e.target.checked)} />
            ) : f.type === "text" ? (
              <AutoTextarea value={String(values[f.name] ?? "")} placeholder={f.placeholder ?? ""} onChange={(e) => setField(f.name, e.target.value)} />
            ) : (
              <input type={f.type === "number" ? "number" : "text"} value={String(values[f.name] ?? "")} placeholder={f.placeholder ?? ""} onChange={(e) => setField(f.name, e.target.value)} />
            )}
            {f.help && <div className="muted small">{f.help}</div>}
          </div>
        ))}

        <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="submit" disabled={!selected}>{existing ? "Save" : "Attach"}</button>
        </div>
      </form>
    </Modal>
  );
}

// Modal to ask a specific actor to review the issue — independent of assignment.
export function RequestReviewModal({
  issueId, actors, onClose, onDone,
}: {
  issueId: number;
  actors: Actor[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [actorId, setActorId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (actorId == null) { setErr("Choose who should review this."); return; }
    api.requestReview(issueId, actorId).then(onDone).catch((e2) => setErr(String(e2)));
  };

  return (
    <Modal title="Request review" onClose={onClose}>
      <form onSubmit={submit}>
        {err && <div className="error small">{err}</div>}
        <label>Reviewer</label>
        <SearchableSelect
          options={actors.map((a) => ({ value: a.id, label: a.displayName }))}
          value={actorId}
          onChange={setActorId}
          allowNone={false}
          placeholder="Choose an actor…"
        />
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="submit" disabled={actorId == null}>Request</button>
        </div>
      </form>
    </Modal>
  );
}
