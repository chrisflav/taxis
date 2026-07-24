import { useMemo } from "react";
import type { IssuePage } from "../types";
import { CHILDREN_PAGE_SIZE, api, issuePagePath } from "../api";
import { EMPTY, LIST_MAX_AGE, useResource } from "../cache";
import { Modal } from "./Modal";
import { Markdown } from "./Markdown";

// Asking about the children before completing or closing a container.
//
// Finishing a container almost always means the work filed under it is finished too, and the only
// way to say so used to be to visit each child and press the same button again. So ask once — and
// ask by *listing* the children that would change, not by counting them: "also close 12 issues" is
// not a question anyone can answer, whereas a list is where you notice the one that should stay
// open and choose "only this issue" instead.
//
// Direct children only, deliberately. Cascading down the whole subtree would write to issues this
// dialogue never showed, and a list bounded to one page could not honestly stand for them; a
// grandchild's own page asks the same question when its turn comes.

/** The states worth asking about. Reopening an issue makes no claim about its children. */
export type CascadeState = "closed" | "completed";

/** The action named after the state, since every line here is about doing it and not about being
    in it — "complete these children", not "these children are completed". */
const VERB: Record<CascadeState, { lower: string; upper: string }> = {
  completed: { lower: "complete", upper: "Complete" },
  closed: { lower: "close", upper: "Close" },
};

export function CascadeStateModal({
  parent, state, onApply, onCancel,
}: {
  parent: number;
  state: CascadeState;
  /** Apply `state` to the issue, and to these children — empty for "only this issue". */
  onApply: (childIds: number[]) => void;
  onCancel: () => void;
}) {
  // Asked of the server as its own question rather than sieved out of the children panel's page:
  // that page is mixed-state and stops at `CHILDREN_PAGE_SIZE` rows, so the open children it
  // happens to hold are an arbitrary subset of the ones this dialogue is about to change.
  const query = useMemo(
    () => ({ parent, state: "open", limit: CHILDREN_PAGE_SIZE } as const), [parent]);
  const res = useResource<IssuePage>(
    issuePagePath(query), () => api.issuePage(query), LIST_MAX_AGE);
  const open = res.data?.issues ?? EMPTY;
  // Counted over every open child by the same predicate that produced the page, so it is the truth
  // about the issue where `open.length` is only the truth about this list.
  const openTotal = res.data?.stateCounts?.open ?? res.data?.total ?? open.length;
  const beyondList = Math.max(openTotal - open.length, 0);

  const verb = VERB[state];
  // Nothing to cascade to until the list is here, and a failed fetch leaves this dialogue with
  // nothing to write — but "only this issue" is still exactly what it was, so that path stays open
  // rather than trapping the reader in a prompt they cannot answer.
  const canCascade = open.length > 0;

  return (
    <Modal title={`${verb.upper} child issues too?`} onClose={onCancel}>
      {res.error && <div className="error small" style={{ marginBottom: 10 }}>{res.error}</div>}

      <p style={{ marginTop: 0 }}>
        {res.loading
          ? "Looking for open child issues…"
          : canCascade
            ? `${openTotal} child issue${openTotal === 1 ? " is" : "s are"} still open. `
              + `${verb.upper} ${openTotal === 1 ? "it" : "them"} as well?`
            : "No child issue is still open — this will only change the issue itself."}
      </p>

      {res.loading && (
        <div>
          {[0, 1, 2].map((i) => (
            <span key={i} className="skeleton-line" style={{ width: `${78 - i * 16}%` }} />
          ))}
        </div>
      )}

      {/* The list scrolls in its own box: a hundred rows would otherwise push the buttons that
          decide what happens to them off the bottom of the dialogue. */}
      {canCascade && (
        <div style={{ maxHeight: 260, overflowY: "auto" }}>
          {open.map((c) => (
            <div key={c.id} className="child-row">
              <span className="child-id">#{c.id}</span>
              <span className="child-title"><Markdown text={c.title} inline /></span>
            </div>
          ))}
        </div>
      )}

      {/* Say plainly when the list is not all of them. Silently changing the hundred it fetched
          and leaving the rest untouched would read as a bug in the cascade rather than a bound on
          it — and the issue list, which pages and edits in bulk, is the tool for the rest. */}
      {beyondList > 0 && (
        <div className="rail-empty" style={{ marginTop: 10 }}>
          Showing the first {open.length} of {openTotal} open children; only these will be changed.
          To {verb.lower} the remaining {beyondList},{" "}
          <a href={`#/issues?parents=${parent}&state=open`}>open them in the issue list</a> and
          select them there.
        </div>
      )}

      <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
        <button onClick={onCancel}>Cancel</button>
        <button onClick={() => onApply([])}>Only this issue</button>
        <button
          className="primary"
          disabled={!canCascade}
          onClick={() => onApply(open.map((c) => c.id))}
        >
          {verb.upper} all
        </button>
      </div>
    </Modal>
  );
}
