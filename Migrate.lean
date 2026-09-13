import Taxis

/-!
# `taxis-migrate`: the migration command line

Four commands over the migrations in `Taxis.Db.Migrations` and the declaration in
`Taxis.Db.Schema`:

| command | what it does |
| --- | --- |
| `migrate` | applies the migrations the database has not recorded, printing each |
| `showmigrations` | `[X] name` for the ones the database records, `[ ] name` for the rest |
| `makemigrations <description>` | writes `Taxis/Db/Migrations/NNNN_<description>.lean` |
| `check` | exits 1, listing the missing steps, if the declaration is ahead of the migrations |

The server does the same as `migrate` at startup — `Taxis.Db.migrate` applies the pending
migrations before it opens a connection to anything — so this is not a step anybody has to run
before starting it. What it is for is the two commands the server cannot do (`makemigrations`,
which is how a schema change is written, and `check`, which is how CI and the test suite catch a
declaration that has run ahead of the migrations), and for migrating a database without starting
the server: a deployment that wants the schema change to land before the new binary serves a
request, or an operator looking at `showmigrations` to see where a database stands.

It reads the same configuration the server does — `--config <path>`, then `ISSUES_CONFIG`, then
`config.toml` in the working directory — because the database it has to act on is the one the
server will open, and a second way of naming it is a second thing to get wrong. `--config` is
taken out of the arguments before the rest are handed to the library's `main`, which expects the
command and nothing else.
-/

open Taxis

/-- The path given by `--config <path>`, or an error if the flag is there without one. -/
private def configArg (args : List String) : Except String (Option System.FilePath) :=
  match args.dropWhile (· != "--config") with
  | [] => .ok none
  | [_] => .error "--config needs a path"
  | _ :: path :: _ => .ok (some path)

/-- The arguments with `--config <path>` removed. -/
private def withoutConfigArg : List String → List String
  | [] => []
  | "--config" :: _ :: rest => withoutConfigArg rest
  | arg :: rest => arg :: withoutConfigArg rest

def main (args : List String) : IO UInt32 := do
  let configPath ← match configArg args with
    | .error e => do IO.eprintln s!"[taxis] {e}"; IO.Process.exit 1
    | .ok p => pure p
  let configPath ← match configPath with
    | some p => pure (some p)
    | none => pure ((← IO.getEnv "ISSUES_CONFIG").map System.FilePath.mk)
  let loaded ← try Config.load configPath catch e => do
    IO.eprintln s!"[taxis] configuration error: {e}"
    IO.Process.exit 1
  let path := loaded.config.dbPath
  let cfg : Db.Migration.Cli.Config Sqlite.M := {
    migrations := Taxis.Db.migrations
    target := Taxis.Db.Schema.schema
    directory := "Taxis" / "Db" / "Migrations"
    run x := do
      let db ← Taxis.Db.connect path
      x.run db }
  Db.Migration.Cli.main cfg (withoutConfigArg args)
