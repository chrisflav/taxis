# Build context is the repository root (see docker-compose.yaml's `build.context: ..`), so every
# COPY below is relative to the repo root, not this file's directory.

# ---- Frontend build ----
FROM node:22-slim AS frontend
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- Backend build ----
# No official Lean4 base image is used here: elan is installed directly so the toolchain pinned by
# lean-toolchain (currently v4.31.0) is fetched exactly as `lake` would locally.
FROM debian:bookworm-slim AS backend
# `build-essential` provides a `cc` for leansqlite's bundled SQLite amalgamation (C bindings) —
# the Lean toolchain's own bundled clang isn't wired up as `cc`.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git build-essential \
    && rm -rf /var/lib/apt/lists/*
ENV ELAN_HOME=/root/.elan
ENV PATH="${ELAN_HOME}/bin:${PATH}"
RUN curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf \
      | sh -s -- -y --no-modify-path --default-toolchain none
WORKDIR /src
COPY lean-toolchain lakefile.toml lake-manifest.json Taxis.lean Main.lean Tests.lean ./
COPY Taxis ./Taxis
# `lake build taxis` (not the default `lake build`) so this doesn't also compile the `test` exe.
RUN lake build taxis

# ---- Runtime ----
FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=backend /src/.lake/build/bin/taxis ./taxis
COPY --from=frontend /src/dist ./frontend/dist

# ISSUES_HOST must be 0.0.0.0 (not the default 127.0.0.1) to be reachable from outside the
# container. ISSUES_DB lives on the /data volume so the database survives container recreation.
ENV ISSUES_HOST=0.0.0.0 \
    ISSUES_PORT=8080 \
    ISSUES_DB=/data/issues.sqlite \
    ISSUES_FRONTEND_DIR=/app/frontend/dist

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD curl -sf http://127.0.0.1:${ISSUES_PORT}/api/health || exit 1

ENTRYPOINT ["./taxis"]
