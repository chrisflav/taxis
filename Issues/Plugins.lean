import Issues.Plugins.Registry
import Issues.Plugins.Github

/-!
# Plugins

The plugin registry plus the built-in artifact and check handlers. Importing this module makes
all built-in kinds available (each plugin self-registers in an `initialize` block). To add a new
kind, create a module that registers a handler and import it here.
-/
