import Taxis.Domain.Ids
import Taxis.Domain.Enums

/-!
# Checks

A check is a condition on an issue and its attached artifacts — for example, whether a CI run
passes on an attached branch. Like artifacts, checks are extensible: a check stores a `kind`
discriminator plus opaque JSON `config`, and the registered handler for that kind evaluates it
to a `CheckStatus`.
-/

open Lean

namespace Taxis

/-- A check attached to an issue. -/
structure Check where
  id : CheckId
  /-- Discriminator naming the registered check handler, e.g. `"github-ci"`. -/
  kind : String
  /-- Handler-specific configuration, validated by the handler for `kind`. -/
  config : Json := .null
  /-- Most recent evaluation outcome. -/
  status : CheckStatus := .pending
  /-- Human-readable detail from the last evaluation. -/
  detail : Option String := none
  /-- When the check was last evaluated. -/
  lastRun : Option Timestamp := none
deriving Inhabited, ToJson, FromJson

end Taxis
