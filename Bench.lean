import Taxis

/-!
# Benchmark fixture generator

Builds a tracker of a given size, so the cost of reading one can be measured against how much is
in it rather than against whatever happens to be in the developer's database.

Everything here is deterministic: the generator is a fixed-seed LCG and every derived value comes
out of it, so the same size always produces byte-for-byte the same database. That is what lets the
harness (`bench/run.py`) treat payload sizes as a regression signal rather than as noise.

Proportions are taken from a real tracker rather than invented — measured over this project's own
database at 51 issues:

  descriptions   ~680 bytes each        goals          on about a third of issues
  events         ~3.5 per issue         comments       ~0.8 per issue
  parents        ~60% of issues         labels         0–3 of 12, dependencies 0–2

Usage: `lake exe bench-seed <db-path> <issue-count>`
-/

open Taxis Taxis.Db

namespace Taxis.Bench

/-- A 64-bit linear congruential generator. Not a good source of randomness and not meant to be —
    it is meant to give the same sequence on every machine and every run, which `IO.rand` would
    not. -/
structure Rng where
  state : UInt64
deriving Inhabited

namespace Rng

def next (r : Rng) : UInt64 × Rng :=
  let s := r.state * 6364136223846793005 + 1442695040888963407
  -- The high bits of an LCG are far better distributed than the low ones, so the value handed out
  -- is the top half rather than the raw state.
  (s >>> 33, ⟨s⟩)

/-- A number in `[0, n)`. -/
def upto (r : Rng) (n : Nat) : Nat × Rng :=
  let (v, r) := r.next
  (if n == 0 then 0 else v.toNat % n, r)

/-- True with probability `pct/100`. -/
def chance (r : Rng) (pct : Nat) : Bool × Rng :=
  let (v, r) := r.upto 100
  (v < pct, r)

end Rng

/-- Words to build filler prose from. A real description is English, not random bytes: it
    compresses, and how well it compresses is one of the things being measured. Random bytes would
    make the compression figures meaningless. -/
private def lexicon : Array String := #[
  "the", "issue", "tracker", "must", "resolve", "dependency", "before", "closing", "goal",
  "condition", "discharge", "obligation", "lemma", "theorem", "proof", "rewrite", "simp",
  "instance", "typeclass", "elaborator", "tactic", "monad", "parser", "syntax", "kernel",
  "universe", "inductive", "structure", "namespace", "import", "module", "definition",
  "equality", "congruence", "induction", "recursion", "termination", "unification", "metavariable"]

/-- `Nat` binds as a *blob* (`QueryParam Nat := QueryParam.asBlob`), which an INTEGER column
    rejects outright — so every number written below goes through here first. -/
private def i64 (n : Nat) : Int64 := Int64.ofNat n

/-- `n` words of filler, drawn from the lexicon. -/
private def words (r : Rng) (n : Nat) : String × Rng := Id.run do
  let mut out := ""
  let mut rng := r
  for i in [0:n] do
    let (k, r') := rng.upto lexicon.size
    rng := r'
    out := if i == 0 then lexicon[k]! else out ++ " " ++ lexicon[k]!
  return (out, rng)

/-- How many actors, groups and labels the fixture carries. Fixed rather than scaled: these are
    reference data, and a tracker with a hundred thousand issues still has a couple of dozen
    people and a couple of dozen labels. Keeping them fixed is also what makes the issue count the
    single variable the benchmark moves. -/
private def actorCount : Nat := 12
private def labelCount : Nat := 12
private def groupCount : Nat := 3

private def seedReference (db : Conn) : IO Unit := do
  for i in [0:groupCount] do
    db exec!"INSERT INTO groups (name, description) VALUES ({s!"group-{i}"}, {s!"visibility group {i}"})"
  for i in [0:actorCount] do
    -- Every fourth actor is a bot, and the first is an admin, so the fixture exercises both flags.
    let bot := i % 4 == 3
    let admin := i == 0
    db exec!"INSERT INTO actors (email, display_name, admin, bot)
      VALUES ({s!"actor{i}@example.invalid"}, {s!"Actor {i}"}, {admin}, {bot})"
  for i in [0:labelCount] do
    db exec!"INSERT INTO labels (name, description, color)
      VALUES ({s!"label-{i}"}, {s!"label number {i}"}, {"#6b7280"})"

/-- Populate `db` with `count` issues and their relations. -/
def seed (db : Conn) (count : Nat) : IO Unit := do
  withTransaction db do
    seedReference db
    let mut rng : Rng := ⟨0x9E3779B97F4A7C15⟩
    for i in [0:count] do
      let id := i + 1
      let (title, r) := words rng 7; rng := r
      -- ~680 bytes of prose, matching the real average (the lexicon averages ~8.4 bytes a word).
      let (description, r) := words rng 80; rng := r
      let (hasGoal, r) := rng.chance 33; rng := r
      let (goalText, r) := words rng 14; rng := r
      let goal := if hasGoal then goalText else ""
      -- Roughly the state mix of a working tracker: mostly open, a tail of finished work.
      let (stateRoll, r) := rng.upto 100; rng := r
      let state := if stateRoll < 60 then "open" else if stateRoll < 85 then "completed" else "closed"
      let (locked, r) := rng.chance 5; rng := r
      let (creator, r) := rng.upto actorCount; rng := r
      -- A parent somewhere earlier in the sequence, which yields a tree rather than a chain and
      -- can never cycle.
      let (hasParent, r) := rng.chance 60; rng := r
      let (parentPick, r) := rng.upto (max 1 i); rng := r
      let parent : Option Int64 := if hasParent && i > 0 then some (i64 (parentPick + 1)) else none
      let createdAt := i64 (1700000000 + i * 137)
      db exec!"INSERT INTO issues
        (id, title, description, goal, state, locked, parent_id, creator_id, created_at, updated_at)
        VALUES ({i64 id}, {title}, {description}, {goal}, {state}, {locked},
                {parent}, {i64 (creator + 1)}, {createdAt}, {createdAt})"

      let (labelN, r) := rng.upto 4; rng := r
      for _ in [0:labelN] do
        let (l, r') := rng.upto labelCount; rng := r'
        rng := r'
        db exec!"INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES ({i64 id}, {i64 (l + 1)})"

      let (depN, r) := rng.upto 3; rng := r
      for _ in [0:depN] do
        let (d, r') := rng.upto (max 1 i); rng := r'
        rng := r'
        if d + 1 != id then
          db exec!"INSERT OR IGNORE INTO issue_dependencies (issue_id, depends_on_id) VALUES ({i64 id}, {i64 (d + 1)})"

      let (assigneeN, r) := rng.upto 3; rng := r
      for _ in [0:assigneeN] do
        let (a, r') := rng.upto actorCount; rng := r'
        rng := r'
        db exec!"INSERT OR IGNORE INTO issue_assignees (issue_id, actor_id) VALUES ({i64 id}, {i64 (a + 1)})"

      -- A tenth of issues are restricted to a group, so the visibility filter has work to do.
      let (restricted, r) := rng.chance 10; rng := r
      if restricted then
        let (g, r') := rng.upto groupCount; rng := r'
        rng := r'
        db exec!"INSERT OR IGNORE INTO issue_visibility (issue_id, group_id) VALUES ({i64 id}, {i64 (g + 1)})"

      -- ~0.8 comments per issue.
      let (commentN, r) := rng.upto 3; rng := r
      for c in [0:commentN] do
        let (body, r') := words rng 70; rng := r'
        let (author, r'') := r'.upto actorCount; rng := r''
        db exec!"INSERT INTO comments (issue_id, author_id, body, created_at, updated_at)
          VALUES ({i64 id}, {i64 (author + 1)}, {body}, {createdAt + i64 (c * 60)}, {createdAt + i64 (c * 60)})"

      -- ~3.5 events per issue. Description edits carry both the old and the new text, which is
      -- what makes an issue's history the largest part of its detail response.
      let (eventN, r) := rng.upto 7; rng := r
      for e in [0:eventN] do
        let (from_, r') := words rng 40; rng := r'
        let (to_, r'') := r'.upto actorCount; rng := r''
        let (toText, r''') := words rng 40; rng := r'''
        let data := Lean.Json.mkObj [("from", from_), ("to", toText)] |>.compress
        db exec!"INSERT INTO events (issue_id, actor_id, kind, data, created_at)
          VALUES ({i64 id}, {i64 (to_ + 1)}, {"description"}, {data}, {createdAt + i64 (e * 30)})"

      -- Participants, so the notification queries have rows to scan.
      db exec!"INSERT OR IGNORE INTO issue_participants (issue_id, actor_id) VALUES ({i64 id}, {i64 (creator + 1)})"

end Taxis.Bench

def main (args : List String) : IO Unit := do
  match args with
  | [path, countStr] =>
    let some count := countStr.toNat?
      | throw (IO.userError s!"not a number: {countStr}")
    -- A fixture is generated, never updated: an existing file would be seeded a second time and
    -- collide on the explicit issue ids.
    for suffix in ["", "-wal", "-shm"] do
      try IO.FS.removeFile (path ++ suffix) catch _ => pure ()
    let db ← Taxis.Db.connect path
    Taxis.Db.migrate db
    Taxis.Bench.seed db count
    IO.println s!"seeded {count} issues into {path}"
  | _ => throw (IO.userError "usage: bench-seed <db-path> <issue-count>")
