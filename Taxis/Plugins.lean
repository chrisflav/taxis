import Taxis.Plugins.Registry
import Taxis.Plugins.GithubForge
import Taxis.Plugins.Github
import Taxis.Plugins.LakeDeps
import Taxis.Plugins.Source
import Taxis.Plugins.JsonCheck
import Taxis.Plugins.Standard
import Taxis.Plugins.Session

/-!
# Plugins

The plugin registry plus the built-in artifact and check handlers. Importing this module makes
all built-in kinds available (each plugin self-registers in an `initialize` block). To add a new
kind, create a module that registers a handler and import it here.

The same applies to the repository dependency graph: `GithubForge` registers a `RepoForge` (how
to read files out of GitHub repositories) and `LakeDeps` a `RepoDepsProvider` (how to read
dependencies out of Lake manifests).
-/
