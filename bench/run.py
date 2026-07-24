#!/usr/bin/env python3
"""Measure what it costs to open each page of the tracker, against trackers of several sizes.

The question this answers is "how does opening a page scale with the number of issues in the
tracker", which is not something the developer's own database can answer -- it has fifty issues in
it and always will. So each size gets a freshly generated fixture (`lake exe bench-seed`, which is
deterministic), a server of its own, and a full set of measurements.

Three kinds of number come out, and they are not equally trustworthy:

  requests per route   Exactly reproducible. A change here means a view started or stopped making
                       a call, which is almost always either a bug or the fix for one.
  bytes per route      Exactly reproducible for a given fixture. This is the number that decides
                       what a page costs on a real link.
  server time          Noisy, especially on shared CI runners. Reported for information; never
                       used to pass or fail anything.

`--check` enforces the first two against `bench/budgets.json`. Timings are deliberately outside
that gate: a benchmark that fails because someone else's job was busy teaches people to ignore it.

Usage:
    bench/run.py                          # default sizes, human-readable
    bench/run.py --sizes 100,1000,10000
    bench/run.py --check                  # also enforce bench/budgets.json
    bench/run.py --json out.json          # machine-readable, for trend tracking
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import shutil
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SIZES = [100, 1000, 10000]

# The API calls each page makes on a cold open.
#
# This mirrors the frontend and is not derived from it, so the two can drift. It is written out
# rather than discovered by driving a browser because the browser adds a dependency and a source of
# flake to what is otherwise an exactly reproducible measurement -- and because being explicit is
# what makes an unexpected request count a failure rather than a shrug. `{id}` is filled in with a
# mid-tree issue.
#
# `#/repos` is deliberately absent: building that graph reads package manifests over the network,
# so it is neither reproducible nor available to a CI runner without egress.
ROUTES = {
    # What blocks the first row appearing. The list reads one page and draws it; further pages are
    # fetched only when the reader pages forward, and are measured separately under "feed".
    #
    # No naming index anywhere below. It used to be on every one of these routes and was 140 KB
    # gzipped of the 148 KB the issue list cost -- an index of every issue's title, to draw a
    # breadcrumb and fill a picker nobody had opened. Names are now asked for by id or searched for.
    "#/issues": [
        "/api/labels", "/api/actors",
        "/api/issues/page?limit=200&state=open", "/api/session",
    ],
    # `/plugins` and `/groups` are gone from here: they describe the attachment dialogues and the
    # visibility editor, neither of which is on the page until somebody opens one.
    "#/issues/{id}": [
        "/api/labels", "/api/actors",
        "/api/issues/{id}", "/api/issues/page?parent={id}&limit=100",
        "/api/session",
    ],
    "#/graph": [
        "/api/labels", "/api/actors", "/api/graph", "/api/session",
    ],
    "#/labels": [
        "/api/labels", "/api/actors", "/api/session",
    ],
}

# Endpoints timed individually, to show where a route's time goes.
# Must match `useIssueFeed.ts`: the benchmark is measuring what the application actually does.
FEED_PAGE_SIZE = 200
FEED_CAP = 5000
# How far the list pages ahead of what it shows -- `rowsNeeded` in IssueList.tsx, for the default
# page size of 25 on the first page. The feed stops there until the reader moves.
FEED_ROWS_WANTED = 2 * 25

TIMED = [
    "/api/issues/page?limit=200&state=open",
    "/api/issues/index",
    "/api/issues/index?q=proof&limit=50",
    "/api/issues/{id}",
    "/api/issues/{id}/ancestors",
    "/api/issues?summary=1",
    "/api/graph",
]

# Link profiles for the modelled figures. A model, not a measurement: it assumes the six parallel
# connections a browser opens per origin, and it ignores TLS setup, congestion window growth and
# server think-time between rounds. Useful for comparing routes and sizes to each other; not a
# prediction of anyone's wall clock.
PROFILES = {"4g": (10_000_000, 0.05), "slow": (1_000_000, 0.20)}
MAX_PARALLEL = 6


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    """A taxis server over one fixture, torn down on exit.

    Run from an empty working directory: `Config.fromEnv` reads `.env` and `config.toml` out of the
    current directory, and picking up the developer's would make the benchmark depend on which
    machine it ran on.
    """

    def __init__(self, binary: str, db: str, port: int):
        self.port, self.cwd = port, tempfile.mkdtemp(prefix="taxis-bench-")
        env = {
            **os.environ,
            "ISSUES_PORT": str(port), "ISSUES_HOST": "127.0.0.1", "ISSUES_DB": db,
            "ISSUES_FRONTEND_DIR": os.path.join(self.cwd, "nonexistent"),
            "ISSUES_CHECK_INTERVAL": "0",
        }
        for key in ("ISSUES_GOOGLE_CLIENT_ID", "ISSUES_GITHUB_CLIENT_ID", "ISSUES_CENTRAL_PASSWORD",
                    "ISSUES_ADMIN_EMAILS", "ISSUES_DEV_LOGIN"):
            env.pop(key, None)
        self.log = open(os.path.join(self.cwd, "server.log"), "w")
        self.proc = subprocess.Popen([binary], env=env, cwd=self.cwd,
                                     stdout=self.log, stderr=subprocess.STDOUT)

    def wait_ready(self, timeout: float = 30.0) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"server exited with {self.proc.returncode}; see {self.cwd}/server.log")
            try:
                c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=1)
                c.request("GET", "/api/health")
                if c.getresponse().status == 200:
                    c.close()
                    return
            except OSError:
                time.sleep(0.05)
        raise RuntimeError("server did not become ready")

    def close(self) -> None:
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.log.close()
        shutil.rmtree(self.cwd, ignore_errors=True)


def fetch(conn: http.client.HTTPConnection, path: str, gzip: bool) -> tuple[int, int]:
    """(status, body bytes on the wire) for one request."""
    conn.request("GET", path, headers={"Accept-Encoding": "gzip" if gzip else "identity"})
    r = conn.getresponse()
    return r.status, len(r.read())


def pick_issue(db: str) -> int:
    """The issue the detail route is measured against: publicly visible, with the most children.

    Read out of the fixture rather than assumed. A guessed id lands on a restricted issue about one
    time in ten — which the server correctly hides as a 404 from an anonymous reader — and picking
    the busiest container makes the detail page a fair test of the panel that lists them rather
    than of a leaf with nothing under it. Deterministic, because the fixture is.
    """
    import sqlite3
    conn = sqlite3.connect(db)
    try:
        row = conn.execute("""
            SELECT i.id, COUNT(c.id) AS children
            FROM issues i
            LEFT JOIN issues c ON c.parent_id = i.id
            WHERE i.id NOT IN (SELECT issue_id FROM issue_visibility)
            GROUP BY i.id
            ORDER BY children DESC, i.id ASC
            LIMIT 1
        """).fetchone()
    finally:
        conn.close()
    if row is None:
        raise RuntimeError(f"no publicly visible issue in {db}")
    return int(row[0])


def measure_size(binary: str, seeder: str, size: int, samples: int) -> dict:
    db = os.path.join(tempfile.mkdtemp(prefix="taxis-fixture-"), f"bench-{size}.sqlite")
    subprocess.run([seeder, db, str(size)], check=True, stdout=subprocess.DEVNULL)
    issue_id = pick_issue(db)
    server = Server(binary, db, free_port())
    try:
        server.wait_ready()
        conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=60)

        routes = {}
        for route, paths in ROUTES.items():
            plain = gz = 0
            for p in (p.replace("{id}", str(issue_id)) for p in paths):
                status, n = fetch(conn, p, gzip=False)
                # The benchmark runs signed out, which is a real way to open these pages -- `/api/me`
                # answering 401 is the expected response, not a failure. Anything else means the
                # route table below has drifted from the API, which is worth stopping for.
                if status not in (200, 401):
                    raise RuntimeError(f"{p} returned {status} (route {route})")
                plain += n
                gz += fetch(conn, p, gzip=True)[1]
            routes[route] = {"requests": len(paths), "plain": plain, "gzip": gz,
                             "modelled_ms": {
                                 name: round(model_ms(len(paths), gz, bw, rtt), 1)
                                 for name, (bw, rtt) in PROFILES.items()}}

        # The feed: how much the list pulls after its first page, and in how many requests.
        # Bounded by what the table is showing rather than by the size of the tracker -- the client
        # asks for the page it draws plus one page of slack, and stops.
        feed = {"requests": 1, "gzip": 0, "rows": 0}
        cur, rows = None, 0
        while True:
            path = f"/api/issues/page?limit={FEED_PAGE_SIZE}&state=open" + (f"&cursor={cur}" if cur else "")
            status, n = fetch(conn, path, gzip=True)
            if status != 200:
                raise RuntimeError(f"{path} returned {status}")
            conn.request("GET", path, headers={"Accept-Encoding": "identity"})
            body = json.loads(conn.getresponse().read())
            feed["gzip"] += n
            got = len(body["issues"])
            rows += got
            if not body["nextCursor"] or got == 0 or rows >= FEED_CAP or rows >= FEED_ROWS_WANTED:
                break
            cur, feed["requests"] = body["nextCursor"], feed["requests"] + 1
        feed["rows"] = rows

        timings = {}
        for raw in TIMED:
            p = raw.replace("{id}", str(issue_id))
            for _ in range(5):
                fetch(conn, p, gzip=True)
            ts = []
            for _ in range(samples):
                t0 = time.perf_counter()
                fetch(conn, p, gzip=True)
                ts.append((time.perf_counter() - t0) * 1000)
            ts.sort()
            timings[raw] = {"median_ms": round(statistics.median(ts), 2),
                            "p95_ms": round(ts[min(len(ts) - 1, int(len(ts) * 0.95))], 2)}
        conn.close()
        throughput = measure_throughput(server.port, "/api/issues?summary=1&state=open")
        return {"size": size, "routes": routes, "feed": feed, "timings": timings,
                "throughput_rps": throughput}
    finally:
        server.close()
        shutil.rmtree(os.path.dirname(db), ignore_errors=True)


def model_ms(requests: int, total_bytes: int, bandwidth_bps: float, rtt_s: float) -> float:
    """Transfer time for a route under one link profile. See the note on PROFILES."""
    rounds = -(-requests // MAX_PARALLEL)  # ceiling division
    return (rounds * rtt_s + total_bytes * 8 / bandwidth_bps) * 1000


def measure_throughput(port: int, path: str, clients: int = 8, per_client: int = 10) -> float:
    """Requests per second with several clients reading at once -- the read-pool behaviour.

    Deliberately few requests each: on the largest fixture this endpoint takes most of a second
    under load, so a longer run would spend more of the benchmark's wall clock here than on
    everything else together, to sharpen a number that is not gated anyway.
    """
    def worker():
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=60)
        for _ in range(per_client):
            fetch(c, path, gzip=True)
        c.close()
    threads = [threading.Thread(target=worker) for _ in range(clients)]
    t0 = time.perf_counter()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return round(clients * per_client / (time.perf_counter() - t0))


def report(results: list[dict]) -> None:
    for r in results:
        print(f"\n{'=' * 78}\n  tracker of {r['size']} issues\n{'=' * 78}")
        print(f"  {'route':<16} {'reqs':>5} {'plain':>10} {'gzip':>9} {'saved':>6} "
              f"{'4g*':>8} {'slow*':>9}")
        for route, m in r["routes"].items():
            saved = f"{100 - m['gzip'] * 100 // max(1, m['plain'])}%"
            print(f"  {route:<16} {m['requests']:>5} {m['plain']:>10,} {m['gzip']:>9,} {saved:>6} "
                  f"{m['modelled_ms']['4g']:>7.0f}ms {m['modelled_ms']['slow']:>8.0f}ms")
        print(f"\n  {'endpoint':<38} {'median':>9} {'p95':>9}")
        for ep, t in r["timings"].items():
            print(f"  {ep:<38} {t['median_ms']:>7.2f}ms {t['p95_ms']:>7.2f}ms")
        f = r["feed"]
        print(f"\n  feed after first paint: {f['requests']} requests, {f['gzip']:,} gzip bytes, "
              f"{f['rows']:,} rows held")
        print(f"  8 concurrent readers: {r['throughput_rps']:,} req/s")
    print("\n  * modelled transfer time, not measured -- see the note on PROFILES in run.py")


def check(results: list[dict], budgets: dict) -> int:
    """Enforce request counts and byte ceilings. Returns a process exit code."""
    failures = []
    for r in results:
        for route, m in r["routes"].items():
            expect = budgets.get("requests", {}).get(route)
            if expect is not None and m["requests"] != expect:
                failures.append(f"{route} at {r['size']}: {m['requests']} requests, expected {expect}"
                                " (a view started or stopped making a call)")
            ceiling = budgets.get("gzip_bytes", {}).get(str(r["size"]), {}).get(route)
            if ceiling is not None and m["gzip"] > ceiling:
                failures.append(f"{route} at {r['size']}: {m['gzip']:,} gzipped bytes exceeds "
                                f"budget {ceiling:,}")
        expect_feed = budgets.get("feed_requests", {}).get(str(r["size"]))
        if expect_feed is not None and r["feed"]["requests"] > expect_feed:
            failures.append(f"feed at {r['size']}: {r['feed']['requests']} pages, expected at most "
                            f"{expect_feed} (paging may not be advancing)")
    if failures:
        print("\nBUDGET FAILURES\n" + "\n".join(f"  - {f}" for f in failures))
        print("\n  If the change is intended, update bench/budgets.json in the same commit.")
        return 1
    print("\n  budgets: ok")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sizes", default=",".join(map(str, DEFAULT_SIZES)))
    ap.add_argument("--samples", type=int, default=40, help="timing samples per endpoint")
    ap.add_argument("--json", help="write machine-readable results here")
    ap.add_argument("--check", action="store_true", help="enforce bench/budgets.json")
    ap.add_argument("--budgets", default=os.path.join(REPO, "bench", "budgets.json"))
    ap.add_argument("--server", default=os.path.join(REPO, ".lake", "build", "bin", "taxis"))
    ap.add_argument("--seeder", default=os.path.join(REPO, ".lake", "build", "bin", "bench-seed"))
    args = ap.parse_args()

    for path, what in ((args.server, "server"), (args.seeder, "seeder")):
        if not os.path.exists(path):
            print(f"{what} not built: {path}\n  run: lake build taxis bench-seed", file=sys.stderr)
            return 2

    sizes = [int(s) for s in args.sizes.split(",") if s.strip()]
    results = []
    for size in sizes:
        print(f"  measuring {size} issues…", file=sys.stderr)
        results.append(measure_size(args.server, args.seeder, size, args.samples))

    report(results)
    if args.json:
        with open(args.json, "w") as f:
            json.dump({"results": results}, f, indent=2)
        print(f"\n  wrote {args.json}")
    if args.check:
        with open(args.budgets) as f:
            return check(results, json.load(f))
    return 0


if __name__ == "__main__":
    sys.exit(main())
