import Taxis.Client
import Taxis.Toml

/-!
# CLI configuration

Where the `taxis` client finds its server and its credential. In increasing precedence:

1. the config file — `$TAXIS_CONFIG`, else `$XDG_CONFIG_HOME/taxis/config.toml`, else
   `~/.config/taxis/config.toml` — with top-level keys `url` and `token`;
2. the environment: `TAXIS_URL`, `TAXIS_TOKEN`;
3. the command line: `--url`, `--token`, `--config`.

The token is sent as `Authorization: Bearer <token>` on every request whenever one is configured,
whatever its value. That matters behind a credential proxy, which replaces the header with the real
credential: the client's own token can be a placeholder, but the header still has to be there for
the proxy to have something to replace and for the request to read as authenticated.
-/

open Lean

namespace Taxis.Cli

/-- The resolved settings, and where each came from (for `taxis config`). -/
structure Settings where
  url : String
  token : Option String := none
  urlSource : String := ""
  tokenSource : String := ""
  configPath : Option System.FilePath := none
deriving Repr, Inhabited

def Settings.client (s : Settings) : Client.Config := { url := s.url, token := s.token }

/-- `url` without trailing slashes — the client appends `/api/...` to it. -/
def normaliseUrl (url : String) : String :=
  let rec strip (s : String) : Nat → String
    | 0 => s
    | n + 1 => if s.endsWith "/" then strip (s.dropEnd 1).toString n else s
  strip url.trimAscii.toString url.length

/-- The default config file path, from an environment lookup. -/
def defaultConfigPath (env : String → Option String) : Option System.FilePath :=
  let nonEmpty (k : String) := (env k).filter (!·.isEmpty)
  match nonEmpty "TAXIS_CONFIG" with
  | some p => some p
  | none => match nonEmpty "XDG_CONFIG_HOME" with
    | some x => some (System.FilePath.mk x / "taxis" / "config.toml")
    | none => (nonEmpty "HOME").map fun h => System.FilePath.mk h / ".config" / "taxis" / "config.toml"

/-- Combine the layers. `file` is the parsed config file, if one was read. Pure. -/
def resolveSettings (file : Option Json) (filePath : Option System.FilePath)
    (env : String → Option String) (flagUrl flagToken : Option String) :
    Except String Settings := do
  let fileStr (k : String) : Option String :=
    file.bind fun j => (j.getObjValAs? String k).toOption
  let nonEmpty (v : Option String) := v.filter (!·.isEmpty)
  let fileName := filePath.map (·.toString) |>.getD "config file"
  let pick (flag : Option String) (flagName envName key : String) : Option (String × String) :=
    match nonEmpty flag with
    | some v => some (v, flagName)
    | none => match nonEmpty (env envName) with
      | some v => some (v, envName)
      | none => (nonEmpty (fileStr key)).map (·, fileName)
  let some (url, urlSource) := pick flagUrl "--url" "TAXIS_URL" "url"
    | .error s!"no taxis server configured: set `url` in {fileName}, TAXIS_URL, or pass --url"
  let token := pick flagToken "--token" "TAXIS_TOKEN" "token"
  return { url := normaliseUrl url, token := token.map (·.1),
           urlSource, tokenSource := (token.map (·.2)).getD "none"
           configPath := filePath }

/-- Read the config file (when it exists) and resolve the settings. An explicitly named file
    (`--config`, `TAXIS_CONFIG`) must exist; the default location may be absent. -/
def loadSettings (configFlag flagUrl flagToken : Option String) : IO (Except String Settings) := do
  let envVars := ["TAXIS_CONFIG", "XDG_CONFIG_HOME", "HOME", "TAXIS_URL", "TAXIS_TOKEN"]
  let mut envMap : Array (String × String) := #[]
  for k in envVars do
    if let some v ← IO.getEnv k then envMap := envMap.push (k, v)
  let env (k : String) : Option String := (envMap.find? (·.1 == k)).map (·.2)
  let explicit := (configFlag.filter (!·.isEmpty)).isSome || ((env "TAXIS_CONFIG").filter (!·.isEmpty)).isSome
  let path : Option System.FilePath :=
    (configFlag.filter (!·.isEmpty)).map System.FilePath.mk <|> defaultConfigPath env
  let mut file : Option Json := none
  if let some p := path then
    if ← p.pathExists then
      match ← Taxis.Toml.load p with
      | .ok j => file := some j
      | .error e => return .error s!"{p}: {e}"
    else if explicit then
      return .error s!"config file {p} does not exist"
  return resolveSettings file path env flagUrl flagToken

end Taxis.Cli
