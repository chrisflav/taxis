import Taxis.Db.Issues

/-!
# The change feed

What a client follows to keep a copy of the tracker current without re-reading it.

`issue_changes` (see `Schema.lean`) is an append-only log of "this issue's list row moved", written
by triggers so that no write path can forget to file one. This module is the read side: given the
sequence number a client last saw, it answers with the issues that have changed since, each as its
*current* row rather than as a diff.

Three things make that answer usable rather than merely available.

**It is coalesced.** One edit touches several tables and so files several log rows; a client wants
the issue's state once, not a replay of how it got there. So the window is reduced to one entry per
issue, in the order each was first touched.

**It is complete up to a stated point.** `upTo` is not "the newest change" — it is the sequence
number through which `changes` is exhaustive. A capped page stops early and says so, and a client
that stores `upTo` and comes back cannot have a gap in the middle.

**It says when it cannot help.** A cursor older than the retained log cannot be answered
incrementally, and guessing would silently leave a client wrong for ever. `reset` says so, and the
client reads the tracker from scratch.
-/

namespace Taxis.Db

/-- One issue's worth of change, resolved to what the reader should now hold. -/
structure IssueChange where
  /-- Where this issue was first touched in the window. Ordering only; the cursor is `upTo`. -/
  seq : Int64
  id : IssueId
  /-- The row as it now stands, or absent — meaning *drop this*. Absent covers both an issue that
      was deleted and one that is no longer visible to this reader, because to a client holding a
      copy those are the same instruction. -/
  row : Option IssueListRow
deriving Inhabited

/-- An answer to "what has changed since `since`?". -/
structure ChangesPage where
  changes : Array IssueChange
  /-- The cursor to send next time: every change at or below it is accounted for above. -/
  upTo : Int64
  /-- The cursor predates the retained log, so nothing incremental can be said and the client
      should read the tracker again from scratch. -/
  reset : Bool
  /-- Changes remain past `upTo`; ask again rather than waiting for the next event. -/
  more : Bool
deriving Inhabited

private structure SeqRow where
  n : Int64
deriving SQLite.Row, Inhabited

private structure ChangeRow where
  seq : Int64
  issueId : IssueId
deriving SQLite.Row, Inhabited

private structure AccessRow where
  issueId : IssueId
  visibility : String
deriving SQLite.Row, Inhabited

private def queryAll (db : Conn) (α : Type) [SQLite.Row α] (sql : String) : IO (Array α) := do
  ((← SQLite.prepare db sql).resultsAs α).toArray

private def idTuple (ids : Array Int64) : String :=
  "(" ++ ", ".intercalate (ids.toList.map toString) ++ ")"

/-- The visibility rule the issue list applies, restated over a group set already in hand. Empty
    means public; `none` for the actor's groups is a reader who is not signed in. -/
private def visibleToGroups (actorGroups : Option (Array GroupId)) (vis : Array GroupId) : Bool :=
  vis.isEmpty ||
    (match actorGroups with
     | none => false
     | some gs => vis.any (fun g => gs.contains g))

/-- A stored `visibility` column — `"3,7"`, or empty for public — back into group ids. -/
private def parseGroups (s : String) : Array GroupId :=
  ((s.splitOn ",").filterMap (fun p => p.trimAscii.toString.toInt?)).toArray.map
    (fun n => (⟨Int64.ofInt n⟩ : GroupId))

/-- The newest sequence number in the log, or 0 when nothing has been recorded.

    What a client takes *before* reading the tracker in full, so that whatever changes while it
    reads is replayed to it afterwards rather than missed between the two. -/
def changesHead (db : Conn) : IO Int64 := do
  let rows ← queryAll db SeqRow "SELECT COALESCE(MAX(seq), 0) FROM issue_changes"
  pure ((rows[0]?.map (·.n)).getD 0)

/--
Changes after `since`, as the issues they leave behind.

`limit` bounds the log rows read, not the issues returned — coalescing can only shrink that — so a
page never skips a change to stay under it.
-/
def changesSince (db : Conn) (since : Int64) (actorGroups : Option (Array GroupId))
    (limit : Nat) : IO ChangesPage := do
  let head ← changesHead db
  let minRows ← queryAll db SeqRow "SELECT COALESCE(MIN(seq), 0) FROM issue_changes"
  let minSeq := ((minRows[0]?.map (·.n)).getD 0)
  -- `minSeq - 1` and not `minSeq`: a client sitting exactly on the row before the oldest one
  -- retained has missed nothing. An empty log makes `minSeq` 0 and this never fires, which is
  -- right — nothing has been recorded, so nothing has been forgotten either.
  if minSeq > 0 && since < minSeq - 1 then
    return { changes := #[], upTo := head, reset := true, more := false }

  let raw ← queryAll db ChangeRow
    s!"SELECT seq, issue_id FROM issue_changes WHERE seq > {since} ORDER BY seq LIMIT {Int64.ofNat (limit + 1)}"
  let more := raw.size > limit
  let taken := if more then raw.extract 0 limit else raw
  -- With nothing in the window the client is level with the log, so it may move its cursor to the
  -- head rather than staying where it was and re-asking the same question for ever.
  let upTo := match taken[taken.size - 1]? with
    | some r => r.seq
    | none => head

  let mut seen : Std.HashSet Int64 := {}
  let mut order : Array (Int64 × IssueId) := #[]
  for r in taken do
    unless seen.contains r.issueId.val do
      seen := seen.insert r.issueId.val
      order := order.push (r.seq, r.issueId)
  if order.isEmpty then
    return { changes := #[], upTo, reset := false, more }

  let ids := order.map (·.2)
  let rows ← listRowsByIds db ids
  let byId := rows.foldl
    (fun (m : Std.HashMap Int64 (IssueListRow × Array GroupId)) (row, vis) => m.insert row.id.val (row, vis))
    {}

  -- Who *used* to be able to see these. Only the two kinds that record it: a tombstone (the groups
  -- the issue carried when it was deleted) and a visibility change (the set it carried before).
  -- Everything else needs no such record — see the note on these triggers in `Schema.lean`.
  let access ← queryAll db AccessRow
    s!"SELECT issue_id, visibility FROM issue_changes
       WHERE seq > {since} AND seq <= {upTo} AND kind IN ('delete', 'visibility')
         AND issue_id IN {idTuple (ids.map (·.val))}"
  let hadAccess := access.foldl
    (fun (m : Std.HashMap Int64 Bool) r =>
      let ok := visibleToGroups actorGroups (parseGroups r.visibility)
      m.insert r.issueId.val (ok || m.getD r.issueId.val false))
    {}

  -- Issues that came into existence inside this window. Their access hints describe moments
  -- *within* their own creation — an issue created private is inserted public and restricted a
  -- statement later — and nobody can have been holding a copy of something that did not exist when
  -- they last asked. So a creation cancels the hints: this reader has nothing to drop.
  let born ← queryAll db ChangeRow
    s!"SELECT seq, issue_id FROM issue_changes
       WHERE seq > {since} AND seq <= {upTo} AND kind = 'create'
         AND issue_id IN {idTuple (ids.map (·.val))}"
  let newborn := born.foldl (fun (m : Std.HashSet Int64) r => m.insert r.issueId.val) {}
  let lostAccess (id : Int64) : Bool := hadAccess.getD id false && !newborn.contains id

  let mut changes : Array IssueChange := #[]
  for (seq, id) in order do
    match byId[id.val]? with
    | some (row, vis) =>
      if visibleToGroups actorGroups vis then
        changes := changes.push { seq, id, row := some row }
      else if lostAccess id.val then
        -- Still there, but no longer theirs to hold.
        changes := changes.push { seq, id, row := none }
      -- Otherwise: they could not see it before this change either, so this is not their news.
    | none =>
      if lostAccess id.val then
        changes := changes.push { seq, id, row := none }
  pure { changes, upTo, reset := false, more }

/-- How many change rows the log keeps. Past this a client that has been away long enough gets
    `reset` and reads the tracker again — the trade every replication log makes, and the reason the
    bound is generous: this is a handful of integers per row, and re-reading a large tracker is the
    expensive thing to make somebody do. -/
def changesRetained : Nat := 100_000

/-- Trim the log to its most recent `keep` rows. Returns how many went. -/
def pruneChanges (db : Conn) (keep : Nat := changesRetained) : IO Nat := do
  let counted ← queryAll db SeqRow "SELECT COUNT(*) FROM issue_changes"
  let counting : Int64 := (counted[0]?.map (·.n)).getD 0
  let total := counting.toNatClampNeg
  if total <= keep then return 0
  -- Strictly below the boundary row, which is the oldest one being kept rather than the newest
  -- one being dropped.
  db.exec s!"DELETE FROM issue_changes WHERE seq < (
    SELECT seq FROM issue_changes ORDER BY seq DESC LIMIT 1 OFFSET {Int64.ofNat (keep - 1)})"
  pure (total - keep)

end Taxis.Db
