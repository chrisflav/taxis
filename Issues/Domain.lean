import Issues.Domain.Ids
import Issues.Domain.Enums
import Issues.Domain.Actor
import Issues.Domain.Label
import Issues.Domain.Artifact
import Issues.Domain.Check
import Issues.Domain.Comment
import Issues.Domain.Event
import Issues.Domain.Token
import Issues.Domain.Issue
import Issues.Domain.Input

/-!
# Domain model

Aggregates the pure data types of the issue tracker: typed ids, status enumerations, and the
`Actor`, `Group`, `Artifact`, `Check`, and `Issue` entities together with their JSON
serialisation.
-/
