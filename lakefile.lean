/-
Lake configuration.

In the DSL rather than `lakefile.toml` because the package builds a C source file — `bindings/gzip.c`,
which is the API's response compressor — and TOML configuration cannot express a C target or an
`extern_lib`. Everything else here is what the TOML said.
-/
import Lake

open System Lake DSL

package taxis where
  version := v!"0.1.0"
  testDriver := "test"
  -- zlib, for `bindings/gzip.c`. Present on every platform this runs on; the Docker build installs
  -- the headers explicitly (see docker/Dockerfile).
  moreLinkArgs := #["-lz"]

-- A pin of the `db` library (typed schema, queries and migrations); moved forward deliberately.
-- `db` pins `leansqlite` itself, so this package does not require it separately.
require db from git "https://github.com/chrisflav/db" @ "bb5d2bea0529382f2cdab41c757b84111d535b5d"

target gzip.o pkg : FilePath := do
  let oFile := pkg.buildDir / "gzip.o"
  let srcJob ← inputTextFile <| pkg.dir / "bindings" / "gzip.c"
  let weakArgs := #["-I", (← getLeanIncludeDir).toString]
  buildO oFile srcJob weakArgs (traceArgs := #["-fPIC"]) (extraDepTrace := getLeanTrace)

extern_lib taxisffi pkg := do
  let gzipObj ← gzip.o.fetch
  buildStaticLib (pkg.staticLibDir / nameToStaticLib "taxisffi") #[gzipObj]

@[default_target]
lean_lib Taxis where
  needs := #[taxisffi]

@[default_target]
lean_exe taxis where
  root := `Main

lean_exe test where
  root := `Tests

/-- Generates the benchmark fixtures `bench/run.py` measures against. Not a default target: it is
    build tooling, and nothing that ships depends on it. -/
lean_exe «bench-seed» where
  root := `Bench
