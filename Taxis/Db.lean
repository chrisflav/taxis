import Taxis.Db.Connection
import Taxis.Db.Schema
import Taxis.Db.Migrations
import Taxis.Db.Migrate
import Taxis.Db.Actors
import Taxis.Db.Groups
import Taxis.Db.Labels
import Taxis.Db.Artifacts
import Taxis.Db.Checks
import Taxis.Db.Notifications
import Taxis.Db.ReviewRequests
import Taxis.Db.Issues
import Taxis.Db.Comments
import Taxis.Db.Events
import Taxis.Db.Sessions
import Taxis.Db.Tokens

/-!
# Database layer

SQLite-backed persistence: connection management, the schema — declared in Lean with the
[`db`](https://github.com/chrisflav/db) library, built by the declarative migrations in
`Taxis.Db.Migrations` and applied by `Taxis.Db.migrate` — and a repository module per entity.
-/
