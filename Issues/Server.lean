import Issues.Server.Context
import Issues.Server.Response
import Issues.Server.Router
import Issues.Server.Auth
import Issues.Server.Handlers
import Issues.Server.Serve

/-!
# Server layer

The REST API: application context, JSON response helpers, request routing, and the
`Std.Http`-based server itself.
-/
