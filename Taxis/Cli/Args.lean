/-!
# Command-line arguments

A small, pure option parser for the `taxis` command-line client. Each command declares the
options it takes (`Opt`); `parseArgs` splits an argument list into positional arguments and option
values against that declaration, and refuses anything it does not declare — a misspelt flag that
was silently ignored would be a command that did something other than what was asked.

Accepted spellings: `--name value`, `--name=value`, `-x value` for an option with a short name,
and `--` to end option parsing. Options may appear anywhere among the positional arguments.
-/

namespace Taxis.Cli

/-- One option a command accepts. -/
structure Opt where
  /-- Long name, without the leading `--`. -/
  name : String
  /-- Metavariable shown in help for an option that takes a value; `none` for a switch. -/
  metavar : Option String := none
  help : String
  short : Option Char := none
  /-- Shown in help as `(repeatable)`; every option may be given more than once, but only
      repeatable ones are read as a list. -/
  repeatable : Bool := false
deriving Repr, Inhabited

/-- The result of parsing: positional arguments in order, and every option occurrence in order
    (a switch is recorded with an empty value). -/
structure Parsed where
  positional : Array String := #[]
  options : Array (String × String) := #[]
deriving Repr, Inhabited, BEq

namespace Parsed

/-- The last value given for `name`, if any. -/
def get? (p : Parsed) (name : String) : Option String :=
  (p.options.filter (·.1 == name)).back?.map (·.2)

/-- Every value given for `name`, in order. -/
def getAll (p : Parsed) (name : String) : Array String :=
  (p.options.filter (·.1 == name)).map (·.2)

/-- Whether `name` was given at all. -/
def has (p : Parsed) (name : String) : Bool :=
  p.options.any (·.1 == name)

end Parsed

/-- Split `args` against the options `opts` declares. -/
def parseArgs (opts : Array Opt) (args : List String) : Except String Parsed := do
  let find (name : String) : Except String Opt :=
    match opts.find? (·.name == name) with
    | some o => .ok o
    | none => .error s!"unknown option --{name}"
  let findShort (c : Char) : Except String Opt :=
    match opts.find? (·.short == some c) with
    | some o => .ok o
    | none => .error s!"unknown option -{c}"
  let rec go (rest : List String) (acc : Parsed) (fuel : Nat) : Except String Parsed :=
    match fuel, rest with
    | 0, _ => .ok acc
    | _, [] => .ok acc
    | _ + 1, "--" :: more => .ok { acc with positional := acc.positional ++ more.toArray }
    | fuel + 1, arg :: more =>
      if arg.startsWith "--" && arg.length > 2 then do
        let body := (arg.drop 2).toString
        let (name, inline?) := match body.splitOn "=" with
          | [n] => (n, none)
          | n :: vs => (n, some ("=".intercalate vs))
          | [] => (body, none)
        let o ← find name
        match o.metavar, inline? with
        | none, none => go more { acc with options := acc.options.push (name, "") } fuel
        | none, some _ => .error s!"--{name} takes no value"
        | some _, some v => go more { acc with options := acc.options.push (name, v) } fuel
        | some mv, none =>
          match more with
          | v :: more' => go more' { acc with options := acc.options.push (name, v) } fuel
          | [] => .error s!"--{name} needs a value ({mv})"
      else if arg.startsWith "-" && arg.length == 2 && arg != "-" then do
        let c := arg.toList[1]!
        let o ← findShort c
        match o.metavar with
        | none => go more { acc with options := acc.options.push (o.name, "") } fuel
        | some mv =>
          match more with
          | v :: more' => go more' { acc with options := acc.options.push (o.name, v) } fuel
          | [] => .error s!"-{c} needs a value ({mv})"
      else
        go more { acc with positional := acc.positional.push arg } fuel
  go args {} (args.length + 1)

/-- One line of help per option, aligned. -/
def renderOpts (opts : Array Opt) : String :=
  let left (o : Opt) : String :=
    let short := o.short.map (fun c => s!"-{c}, ") |>.getD "    "
    let mv := o.metavar.map (" " ++ ·) |>.getD ""
    s!"  {short}--{o.name}{mv}"
  let width := opts.foldl (fun w o => max w (left o).length) 0
  "\n".intercalate (opts.toList.map fun o =>
    let l := left o
    let rep := if o.repeatable then " (repeatable)" else ""
    l ++ "".pushn ' ' (width - l.length + 2) ++ o.help ++ rep)

end Taxis.Cli
