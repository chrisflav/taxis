import Taxis.Server.Context
import Taxis.Server.Response
import Taxis.Server.Router
import Taxis.Server.Auth
import Taxis.Server.Handlers
import Taxis.Server.Serve

/-!
# Server layer

The REST API: application context, JSON response helpers, request routing, and the
`Std.Http`-based server itself.
-/
