import Taxis.Domain.Ids
import Taxis.Domain.Enums
import Taxis.Domain.Actor
import Taxis.Domain.Label
import Taxis.Domain.Artifact
import Taxis.Domain.Check
import Taxis.Domain.Comment
import Taxis.Domain.Event
import Taxis.Domain.Token
import Taxis.Domain.Notification
import Taxis.Domain.ReviewRequest
import Taxis.Domain.Issue
import Taxis.Domain.Input

/-!
# Domain model

Aggregates the pure data types of the issue tracker: typed ids, status enumerations, and the
`Actor`, `Group`, `Artifact`, `Check`, and `Issue` entities together with their JSON
serialisation.
-/
