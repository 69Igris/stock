"""The DEPLOYMENT contract, asserted against the files that carry it — MONEY-979.

Everything here reads YAML, a Dockerfile and two shell scripts as TEXT and
checks that they agree with each other and with ``app/settings.py``. Nothing in
this module imports the service, starts a server, or talks to GCP.

## Why a text test rather than a runtime one

Every defect this file guards is invisible at runtime until production, and then
invisible IN production too:

- an OIDC audience that differs from the subscription's by one character makes
  every Pub/Sub push 401, retry five times and dead-letter — and the DLQ entry
  reads as a job that keeps crashing, not as a misconfigured audience;
- a spec that sets ``DD_TRACE_ENABLED`` over a container that never imports
  ddtrace has a green Datadog service page (DogStatsD metrics DO arrive) and no
  traces at all;
- an env var the code reads and the spec omits resolves to the code's default,
  silently, which is how ``MF_METADATA_PROVIDER`` disabled a job for months;
- a Cloud Run JOB missing from the release's re-pin loop keeps its provisioning
  image forever and does not fail — it succeeds at running last release's code.

None of those produce an error anywhere. A file comparison does.

## The lists are DERIVED, never typed here

The required env names come from an AST walk of ``app/settings.py``; the arming
flags and their arming LITERALS come from the same walk; the Cloud Run job names
come from ``scripts/ops/setup-us-fundamentals-jobs.sh``. A hardcoded copy would
be a second source of truth that cannot fail when the first one moves — the
exact defect class the assertions below exist to catch, rebuilt one layer up.

``yaml`` is available wherever the service's own dependencies are installed:
``uvicorn[standard]`` (a pinned runtime dep) requires ``pyyaml>=5.1``. It is not
an extra this test adds.
"""

from __future__ import annotations

import ast
import json
import re
import shlex
from pathlib import Path
from typing import Any

import pytest
import yaml

# ── Paths ───────────────────────────────────────────────────────────────────

SERVICE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]

QA_SPEC = SERVICE_DIR / "cloudbuild.qa.yaml"
PROD_SPEC = SERVICE_DIR / "cloudbuild.prod.yaml"
DOCKERFILE = SERVICE_DIR / "Dockerfile"
PYPROJECT = SERVICE_DIR / "pyproject.toml"
SETTINGS_PY = SERVICE_DIR / "app" / "settings.py"

PUBSUB_SCRIPT = REPO_ROOT / "workers" / "scripts" / "setup-pubsub.sh"
JOBS_SCRIPT = REPO_ROOT / "scripts" / "ops" / "setup-us-fundamentals-jobs.sh"

#: Cloud Build's per-argument ceiling. `workers/cloudbuild.prod.yaml` hit it at
#: 11,600 characters and failed the whole build with
#: `invalid build: invalid .steps field: build step 2 arg 1 too long`.
CLOUD_BUILD_ARG_LIMIT = 10_000

SPECS = {"qa": QA_SPEC, "prod": PROD_SPEC}
SECRET_SUFFIX = {"qa": "QA", "prod": "PROD"}

#: Secrets shared across environments, and therefore carrying NO `_QA` / `_PROD`
#: suffix. EMPTY, and that is the correct state today.
#:
#: It held `GCP_SERVICE_ACCOUNT_KEY_BASE64` until a review showed the Python
#: service never reads it: `app/sec/archive.py` builds a bare `storage.Client()`
#: and authenticates as the RUNTIME service account via ADC. Mounting it gave
#: the QA service a long-lived prod-capable credential for no functional reason,
#: and `redact()` matches none of its name.
#:
#: The comment here also claimed the mounted key "OUTRANKS the runtime service
#: account". That is TRUE of the TypeScript `googleCredentials()` helper and
#: FALSE here, and it is the more expensive half of the mistake: an operator
#: following it grants bucket object-write to the wrong principal, and
#: `archive.write_bytes` then 403s inside `fetch_bundle` AFTER the SEC GET has
#: already been spent.
#:
#: Kept as an empty frozenset rather than deleted so a genuinely shared secret
#: has a documented home instead of an exemption bolted onto the assertion.
UNSUFFIXED_SECRETS: frozenset[str] = frozenset()

#: Settings that `app/settings.py` reads but the Cloud Run spec deliberately
#: does not set. EMPTY today, on purpose: every name the code looks up is in
#: both specs. It exists so that a future genuine exemption has a documented
#: home with a reason beside it, rather than being handled by deleting the
#: assertion. Adding a name here without a comment is the failure mode.
SPEC_EXEMPT_SETTINGS: frozenset[str] = frozenset()


# ── Cloud Build rendering ───────────────────────────────────────────────────


def _substitutions(doc: dict[str, Any]) -> dict[str, str]:
    """The spec's own `substitutions:` plus the two built-ins we rely on."""
    subs = {str(k): str(v) for k, v in (doc.get("substitutions") or {}).items()}
    subs.setdefault("PROJECT_ID", "stock-book-483718")
    subs.setdefault("COMMIT_SHA", "0123456789abcdef")
    return subs


def _render(text: str, subs: dict[str, str]) -> str:
    """Apply Cloud Build substitution the way Cloud Build does.

    `$$` is Cloud Build's escape for a LITERAL dollar, and it is what keeps
    `$${CLOUD_RUN_URL}` out of the substitution pass and available to bash. So
    the string is split on `$$` first, substituted piecewise, and rejoined with
    a single `$` — otherwise a bash variable would be substituted away and the
    test would be checking a string the deploy never sees.
    """
    parts = text.split("$$")
    rendered = []
    for part in parts:
        for name in sorted(subs, key=len, reverse=True):
            part = part.replace(f"${{{name}}}", subs[name]).replace("$" + name, subs[name])
        rendered.append(part)
    return "$".join(rendered)


def _steps(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    doc = yaml.safe_load(path.read_text())
    return doc, list(doc["steps"])


def _deploy_arg(path: Path) -> str:
    """The single bash arg that resolves the URL, writes service.yaml and deploys."""
    _doc, steps = _steps(path)
    for step in steps:
        for arg in step.get("args", []):
            if isinstance(arg, str) and "cat > /tmp/service.yaml" in arg:
                return arg
    raise AssertionError(f"{path.name}: no step writes /tmp/service.yaml")


def _repin_arg(path: Path) -> str:
    _doc, steps = _steps(path)
    for step in steps:
        for arg in step.get("args", []):
            if isinstance(arg, str) and "gcloud run jobs update" in arg:
                return arg
    raise AssertionError(f"{path.name}: no step re-pins the Cloud Run jobs")


def _build_args(path: Path) -> list[str]:
    _doc, steps = _steps(path)
    for step in steps:
        args = step.get("args", [])
        if args and args[0] == "build":
            return [str(a) for a in args]
    raise AssertionError(f"{path.name}: no docker build step")


def _split_deploy_arg(path: Path) -> tuple[str, str, str]:
    """`(preamble, heredoc_body, epilogue)` of the deploy step.

    The split is what lets an assertion say WHERE something happens — resolving
    the URL before the heredoc and verifying it after are two different claims,
    and a substring search over the whole arg cannot tell them apart.
    """
    arg = _deploy_arg(path)
    lines = arg.splitlines()
    start = next(
        i for i, ln in enumerate(lines) if ln.strip().startswith("cat > /tmp/service.yaml")
    )
    end = next(i for i in range(start + 1, len(lines)) if lines[i].strip() == "EOF")
    return (
        "\n".join(lines[:start]),
        "\n".join(lines[start + 1 : end]),
        "\n".join(lines[end + 1 :]),
    )


def _service_doc(env: str) -> dict[str, Any]:
    """The embedded Knative Service, substituted and parsed."""
    path = SPECS[env]
    doc, _ = _steps(path)
    _pre, body, _post = _split_deploy_arg(path)
    rendered = _render(body, _substitutions(doc))
    # Whatever bash expansions survive are stand-ins for values only the deploy
    # knows. A URL-shaped placeholder keeps the document realistic.
    rendered = rendered.replace("${CLOUD_RUN_URL}", "https://svc-hash-el.a.run.app")
    rendered = re.sub(r"\$\{[A-Za-z_][A-Za-z0-9_]*\}", "PLACEHOLDER", rendered)
    return yaml.safe_load(rendered)


def _containers(env: str) -> dict[str, dict[str, Any]]:
    doc = _service_doc(env)
    return {c["name"]: c for c in doc["spec"]["template"]["spec"]["containers"]}


def _env_entries(env: str, container: str = "us-fundamentals") -> dict[str, dict[str, Any]]:
    return {e["name"]: e for e in _containers(env)[container].get("env", [])}


# ── Derivations (never a typed list) ────────────────────────────────────────


def _settings_tree() -> ast.Module:
    return ast.parse(SETTINGS_PY.read_text())


def settings_env_names() -> set[str]:
    """Every environment variable `app/settings.py` looks up by a literal name.

    Catches `_env("X")`, `_literal("X")` and `os.environ.get("X")`, including
    the one buried inside an f-string in `default_metric_tags`. That last case
    is why this is an AST walk and not a regex: `f"service:{_env('DD_SERVICE')}"`
    nests the call inside a JoinedStr, where a line-oriented pattern written for
    the common form does not look.
    """
    names: set[str] = set()
    for node in ast.walk(_settings_tree()):
        if not isinstance(node, ast.Call) or not node.args:
            continue
        first = node.args[0]
        if not isinstance(first, ast.Constant) or not isinstance(first.value, str):
            continue
        func = node.func
        if isinstance(func, ast.Name) and func.id in {"_env", "_literal"}:
            names.add(first.value)
        elif isinstance(func, ast.Attribute) and func.attr == "get":
            owner = func.value
            if isinstance(owner, ast.Attribute) and owner.attr == "environ":
                names.add(first.value)
    return names


def arming_flags() -> dict[str, str]:
    """`{FLAG_NAME: the literal that ARMS it}`, read out of `app/settings.py`.

    Shape matched: `return _literal("EDGAR_DETECT") == "on"`. Deriving the
    arming literal (rather than assuming "true") is what makes the
    present-and-off assertion correct for `EDGAR_DETECT`, which arms on `"on"`.
    """
    flags: dict[str, str] = {}
    for node in ast.walk(_settings_tree()):
        if not isinstance(node, ast.FunctionDef):
            continue
        for stmt in node.body:
            if not isinstance(stmt, ast.Return) or not isinstance(stmt.value, ast.Compare):
                continue
            cmp_node = stmt.value
            left, ops, comparators = cmp_node.left, cmp_node.ops, cmp_node.comparators
            if len(ops) != 1 or not isinstance(ops[0], ast.Eq):
                continue
            if not (isinstance(left, ast.Call) and isinstance(left.func, ast.Name)):
                continue
            if left.func.id != "_literal" or not left.args:
                continue
            name_arg, want = left.args[0], comparators[0]
            both_str = isinstance(name_arg, ast.Constant) and isinstance(want, ast.Constant)
            if both_str and isinstance(name_arg.value, str) and isinstance(want.value, str):
                flags[name_arg.value] = want.value
    return flags


def provisioned_job_bases() -> set[str]:
    """Every Cloud Run job `setup-us-fundamentals-jobs.sh` creates."""
    text = JOBS_SCRIPT.read_text()
    return set(re.findall(r'^\s*deploy_job\s+"([a-z0-9-]+)"', text, flags=re.MULTILINE))


def repinned_job_bases(env: str) -> set[str]:
    """Every job named in a spec's `for BASE in ...; do` re-pin loop."""
    arg = _repin_arg(SPECS[env])
    match = re.search(r"for BASE in ([^;]+); do", arg)
    assert match, f"{SPECS[env].name}: re-pin loop is not a `for BASE in ...; do`"
    return set(match.group(1).split())


def dockerfile_cmd() -> list[str]:
    """The exec-form CMD as a list of argv tokens."""
    for line in reversed(DOCKERFILE.read_text().splitlines()):
        stripped = line.strip()
        if stripped.startswith("CMD "):
            payload = stripped[len("CMD ") :].strip()
            assert payload.startswith("["), "CMD must stay exec-form (no shell wrapper)"
            return [str(x) for x in json.loads(payload)]
    raise AssertionError("Dockerfile has no CMD")


# ── 1. Every setting the code reads is in both specs ────────────────────────


def test_settings_derivation_is_not_vacuous():
    """The derivation must find real names, or every test built on it passes empty."""
    names = settings_env_names()
    assert len(names) >= 10, names
    # Spot-check the two shapes that are easy to break: the plain call and the
    # one nested inside an f-string.
    assert "CLOUD_RUN_URL" in names
    assert "DD_SERVICE" in names


@pytest.mark.parametrize("env", ["qa", "prod"])
def test_spec_sets_every_env_var_the_service_reads(env: str):
    declared = set(_env_entries(env))
    required = settings_env_names() - SPEC_EXEMPT_SETTINGS
    missing = sorted(required - declared)
    assert not missing, (
        f"cloudbuild.{env}.yaml does not set {missing}, which app/settings.py reads. "
        "An unset variable resolves to the code's default silently — 'absent' and "
        "'deliberately off' must never be the same state (MONEY-1214)."
    )


def test_both_specs_declare_the_same_env_names():
    """Names must match across environments; only VALUES may differ.

    Catches the half-applied change — a variable added to prod and forgotten in
    QA — which otherwise surfaces as QA behaving differently for a reason nobody
    can see in either file alone.
    """
    qa, prod = set(_env_entries("qa")), set(_env_entries("prod"))
    assert qa == prod, f"only in qa: {sorted(qa - prod)}; only in prod: {sorted(prod - qa)}"


# ── 2. Secret suffixes ──────────────────────────────────────────────────────


@pytest.mark.parametrize("env", ["qa", "prod"])
@pytest.mark.parametrize("container", ["us-fundamentals", "datadog-agent"])
def test_secret_refs_carry_the_right_suffix(env: str, container: str):
    suffix = SECRET_SUFFIX[env]
    entries = _env_entries(env, container)
    checked = 0
    for name, entry in entries.items():
        ref = (entry.get("valueFrom") or {}).get("secretKeyRef")
        if not ref:
            continue
        checked += 1
        actual = ref["name"]
        if name in UNSUFFIXED_SECRETS:
            assert actual == name, (
                f"{name} is ONE secret shared across environments and must carry no "
                f"suffix; cloudbuild.{env}.yaml reads {actual!r}."
            )
        else:
            assert actual == f"{name}_{suffix}", (
                f"cloudbuild.{env}.yaml mounts {actual!r} for {name}. A QA service "
                f"reading a _PROD secret is a cross-environment write with no error."
            )
        assert ref["key"] == "latest"
    assert checked > 0, f"{container} in cloudbuild.{env}.yaml references no secrets at all"


def test_the_shared_secret_is_the_only_unsuffixed_one():
    """Derived: no OTHER secret may quietly become environment-shared."""
    for env in SPECS:
        for container in ("us-fundamentals", "datadog-agent"):
            for name, entry in _env_entries(env, container).items():
                ref = (entry.get("valueFrom") or {}).get("secretKeyRef")
                if ref and ref["name"] == name:
                    assert name in UNSUFFIXED_SECRETS, (
                        f"{name} is mounted unsuffixed in cloudbuild.{env}.yaml but is "
                        "not declared as an environment-shared secret."
                    )


# ── 3. The three apply flags are PRESENT and OFF ────────────────────────────


def test_arming_flag_derivation_is_not_vacuous():
    flags = arming_flags()
    assert set(flags) == {"EDGAR_DETECT", "EDGAR_PARSE_APPLY", "EDGAR_EVICT_APPLY"}, flags
    # The arming literal is NOT uniform, which is the whole reason it is derived
    # rather than assumed.
    assert flags["EDGAR_DETECT"] == "on"
    assert flags["EDGAR_PARSE_APPLY"] == "true"


#: The posture each flag ships with, per environment.
#:
#: An INTENDED-STATE table, not "everything off". The engine ships RUNNING on
#: prod — the same way the Tiingo US price backbone shipped, with live schedules
#: and no apply flag at all. A feature behind an off switch is a feature that
#: does not exist, and nothing exercises its write path until weeks later.
#:
#: This pins BOTH directions, which the previous assertion did not: it only
#: checked that no flag was armed, so a silent DISARM of prod would have passed.
#: Now a change in either direction is a deliberate edit to this table.
#:
#: QA is off because it has NO SEC EGRESS — `SEC_EGRESS=off`, since SEC's
#: fair-access limit is per IP and Cloud Run shares egress addresses. An armed
#: detector there would raise on all 1,440 runs a day. It is forced, not chosen.
#:
#: EDGAR_EVICT_APPLY is off in BOTH: it is the only switch here that arms
#: DELETES, and the 13F cold tier it evicts into is registered but unreachable
#: (`getManagerHoldings` has zero callers), so eviction would delete readable
#: rows and answer "not yet ingested" for periods whose shards sit in GCS.
INTENDED_FLAG_STATE: dict[str, dict[str, str]] = {
    "prod": {
        "EDGAR_DETECT": "on",
        "EDGAR_PARSE_APPLY": "true",
        "EDGAR_EVICT_APPLY": "false",
    },
    "qa": {
        "EDGAR_DETECT": "off",
        "EDGAR_PARSE_APPLY": "false",
        "EDGAR_EVICT_APPLY": "false",
    },
}


#: The events transport, pinned in BOTH directions — MONEY-1520.
#:
#: It is a SEPARATE table from `INTENDED_FLAG_STATE` above, and that is forced
#: rather than chosen: that dict is machine-tied to `arming_flags()`, which
#: derives its members from the `return _literal("X") == "y"` shape in
#: `app/settings.py`. A non-arming name added to it fails
#: `test_the_intended_state_table_covers_every_arming_flag` on the spot.
#:
#: There is no arming flag for events and deliberately none. The old transport's
#: only switch was EVENTS_ENDPOINT_URL — "the URL IS the arm" — and a topic base
#: name is a compile-time constant with nothing to resolve, so there is no
#: value left that could ship empty. A new flag would be a knob nobody asked
#: for in front of a lane whose whole failure mode was that nobody was watching
#: it. QA emits nothing regardless, because EDGAR_DETECT ships "off" there.
EVENTS_TRANSPORT = {
    "topic_base": "us-filing-events",
    "removed_env": "EVENTS_ENDPOINT_URL",
}


def test_the_events_endpoint_variable_is_gone_from_both_specs():
    """MONEY-1520 — an env var the code no longer reads is live-looking config.

    The deployed value was CORRECT (`https://stockbook-workers-prod-…
    /internal/events`, resolved from the service's own `status.url`) and every
    POST to it answered 404, because `stockbook-workers-{env}` is
    `ingress: internal` and this service has no VPC egress. Leaving the variable
    behind would leave an operator debugging a URL that is no longer a
    destination.
    """
    for env in SPECS:
        entries = _env_entries(env)
        assert EVENTS_TRANSPORT["removed_env"] not in entries, (
            f"cloudbuild.{env}.yaml still sets {EVENTS_TRANSPORT['removed_env']}. "
            "The events hop is Pub/Sub now; nothing reads it."
        )


def test_settings_no_longer_reads_the_events_endpoint():
    """The other half. A spec that stopped setting it while the code still read
    it would resolve to the code's default — which is exactly how
    MF_METADATA_PROVIDER disabled a job for months.
    """
    assert EVENTS_TRANSPORT["removed_env"] not in settings_env_names()


@pytest.mark.parametrize("env", ["qa", "prod"])
def test_the_build_no_longer_resolves_the_workers_url(env: str):
    """The RESOLUTION is gone, not just the variable it fed.

    `gcloud run services describe stockbook-workers-{env}` ran in the deploy
    preamble and was allowed to fail SILENTLY (`|| WURL=""`), unlike
    CLOUD_RUN_URL which aborts the build. A topic name needs no lookup, so the
    whole fail-quietly-at-build-time path is removed rather than hardened.

    Read from the SHELL CODE, not the raw text: the spec now explains what it
    deleted, and a naive substring search would find the prose and report the
    very defect the prose describes being fixed.
    """
    pre, _body, _post = _split_deploy_arg(SPECS[env])
    code = "\n".join(ln for ln in pre.splitlines() if not ln.lstrip().startswith("#"))
    assert "stockbook-workers" not in code, (
        f"cloudbuild.{env}.yaml still resolves the workers service URL at build "
        "time. Nothing consumes it."
    )


def test_the_topic_base_is_the_one_the_producer_publishes_to():
    """The table above is a CLAIM; this joins it to the code.

    Without this the constant could be renamed in `app/events.py` and every
    assertion here would keep passing while describing a topic that no longer
    exists — a table that grades itself.
    """
    from app.events import EVENTS_TOPIC

    assert EVENTS_TOPIC == EVENTS_TRANSPORT["topic_base"]


def test_the_topic_is_created_and_subscribed_by_setup_pubsub():
    """A topic with no push subscription is the same silence the 404 produced:
    the publish succeeds, the message sits until retention expires, and no
    counter anywhere moves.

    Both arrays are read, because they answer different questions —
    `BASE_TOPICS` creates the topic and `BASE_WORKER_TOPICS` creates the
    subscription, and a topic in the first but not the second is a documented
    failure shape in `topic-list-agreement.test.ts`.
    """
    src = PUBSUB_SCRIPT.read_text()

    def entries(name: str) -> list[str]:
        marker = f"declare -a {name}=("
        start = src.index(marker)
        end = src.index("\n)", start)
        out = []
        for raw in src[start + len(marker) : end].split("\n"):
            line = raw.split("#", 1)[0]
            m = re.search(r'"([a-z0-9-]+)"', line)
            if m:
                out.append(m.group(1))
        return out

    base = entries("BASE_TOPICS")
    worker = entries("BASE_WORKER_TOPICS")
    # Floors first: a parser that stopped matching would make both `in` checks
    # below fail for the wrong reason, or an empty list pass one vacuously.
    assert len(base) >= 60, f"parsed {len(base)} BASE_TOPICS"
    assert len(worker) >= 60, f"parsed {len(worker)} BASE_WORKER_TOPICS"
    topic = EVENTS_TRANSPORT["topic_base"]
    assert topic in base, f"{topic} is never created"
    assert topic in worker, f"{topic} has no push subscription"


def test_the_intended_state_table_covers_every_arming_flag():
    """A new flag cannot be added without a per-environment DECISION.

    `arming_flags()` derives the real set from `app/settings.py`, so a fourth
    switch appearing there fails here until someone states what it ships as —
    rather than defaulting into whichever value the spec happened to get.
    """
    derived = set(arming_flags())
    assert derived, "premise: no arming flags found in settings.py"
    for env, table in INTENDED_FLAG_STATE.items():
        assert set(table) == derived, (
            f"INTENDED_FLAG_STATE[{env!r}] does not match the flags settings.py "
            f"reads: missing={sorted(derived - set(table))} "
            f"extra={sorted(set(table) - derived)}"
        )


@pytest.mark.parametrize("env", ["qa", "prod"])
def test_apply_flags_ship_present_and_at_their_intended_value(env: str):
    entries = _env_entries(env)
    arming = arming_flags()
    for flag, intended in INTENDED_FLAG_STATE[env].items():
        assert flag in entries, (
            f"cloudbuild.{env}.yaml omits {flag}. Absent and explicitly-set are "
            "different states and only one of them is visible to an operator."
        )
        entry = entries[flag]
        assert "valueFrom" not in entry, f"{flag} is a switch, not a secret"
        value = str(entry["value"]).strip()
        assert value, f"{flag} is set to the empty string, which reads as absent"
        assert value == intended, (
            f"cloudbuild.{env}.yaml ships {flag}={value!r}; the intended posture "
            f"is {intended!r}. If that is deliberate, change INTENDED_FLAG_STATE "
            "and say why — a flag that drifts silently is the whole reason this "
            "table exists."
        )
        # The armed value must be the literal settings.py compares against, or
        # the flag is set to something that reads as armed and behaves as off.
        if value == intended and intended.lower() == arming[flag].lower():
            assert value == arming[flag], (
                f"{flag}={value!r} is not byte-identical to the arming literal "
                f"{arming[flag]!r}; the comparison in settings.py is exact."
            )


def test_the_JOBS_SCRIPT_arms_the_same_way_the_service_does():
    """The Cloud Run JOBS must carry the same posture as the service.

    `setup-us-fundamentals-jobs.sh` hardcoded `EDGAR_PARSE_APPLY=false` for BOTH
    environments while the service specs were armed, and nothing compared the
    two. That is not a cosmetic mismatch: `submissions` and `companyfacts` take
    NO `--apply` flag, so the env is their only gate. A prod backfill would have
    walked the whole filer universe against a shared, per-IP rate-limited host
    and written NOTHING, reporting a clean run — the exact
    `selected > 0, written == 0` shape the outcome metric exists to catch,
    produced by the provisioning script rather than by any code path a unit test
    covers.

    Parsed statically from the per-env branch rather than by running the script,
    so this stays a contract check and needs no gcloud.
    """
    src = JOBS_SCRIPT.read_text()
    for env, table in INTENDED_FLAG_STATE.items():
        # The `<env>)` case arm, up to its `;;`.
        m = re.search(rf"^\s*{env}\)(.*?)^\s*;;", src, re.S | re.M)
        assert m, f"no `{env})` branch found in {JOBS_SCRIPT.name}"
        assign = re.search(r'PARSE_APPLY="([^"]*)"', m.group(1))
        assert assign, (
            f"the `{env})` branch does not set PARSE_APPLY; if the flag went back "
            "to a hardcoded literal, the jobs and the service can diverge again"
        )
        assert assign.group(1) == table["EDGAR_PARSE_APPLY"], (
            f"jobs script ships EDGAR_PARSE_APPLY={assign.group(1)!r} on {env} "
            f"but the service ships {table['EDGAR_PARSE_APPLY']!r}. `submissions` "
            "and `companyfacts` have no --apply override, so a disarmed job env "
            "means they fetch and store nothing."
        )
    # And the var must actually reach the deploy, not just be assigned.
    assert "EDGAR_PARSE_APPLY=${PARSE_APPLY}" in src, (
        "PARSE_APPLY is computed but the --set-env-vars line does not use it"
    )


def test_prod_ships_the_ingest_path_ARMED():
    """Named, so the posture is a claim someone can find and challenge.

    The generic table above would be satisfied by an all-off table too. This
    asserts the actual decision: prod detects and parses on deploy.
    """
    prod = INTENDED_FLAG_STATE["prod"]
    assert prod["EDGAR_DETECT"] == "on"
    assert prod["EDGAR_PARSE_APPLY"] == "true"
    assert prod["EDGAR_EVICT_APPLY"] == "false", (
        "eviction arms DELETES into a cold tier nothing reads yet — see "
        "docs/reference/edgar-engine.md section 11"
    )


# ── 4. Cloud Build's 10,000-character argument cap ──────────────────────────


@pytest.mark.parametrize("env", ["qa", "prod"])
def test_every_build_arg_is_under_the_cloud_build_cap(env: str):
    doc, steps = _steps(SPECS[env])
    subs = _substitutions(doc)
    for i, step in enumerate(steps):
        for j, arg in enumerate(step.get("args", [])):
            if not isinstance(arg, str):
                continue
            raw, rendered = len(arg), len(_render(arg, subs))
            assert max(raw, rendered) < CLOUD_BUILD_ARG_LIMIT, (
                f"cloudbuild.{env}.yaml step {i} arg {j} is {raw} chars raw / "
                f"{rendered} substituted, at or over Cloud Build's "
                f"{CLOUD_BUILD_ARG_LIMIT} cap. Move commentary OUTSIDE the heredoc: "
                "a comment in there costs exactly as much as configuration."
            )


@pytest.mark.parametrize("env", ["qa", "prod"])
def test_embedded_body_is_a_knative_service(env: str):
    doc = _service_doc(env)
    assert doc["apiVersion"] == "serving.knative.dev/v1"
    assert doc["kind"] == "Service"
    assert doc["metadata"]["name"] == f"us-fundamentals-{env}"
    spec = doc["spec"]["template"]["spec"]
    # timeoutSeconds MATCHES the Pub/Sub ack deadline exactly. Letting a handler
    # outlive the message it is answering buys nothing: Pub/Sub has already
    # redelivered and a second copy is running.
    assert spec["timeoutSeconds"] == 600
    assert spec["containerConcurrency"] == 4
    assert set(_containers(env)) == {"us-fundamentals", "datadog-agent"}


# ── 5. T15 — the OIDC audience is DERIVED, not predicted ────────────────────


@pytest.mark.parametrize("env", ["qa", "prod"])
def test_deploy_step_contains_no_hardcoded_cloud_run_hostname(env: str):
    """No `.run.app` literal may appear in the EXECUTED text.

    Asserted against the parsed step argument rather than the file, so the
    prose above it — which quotes the old predicted URL to explain why it went —
    is correctly out of scope. A comment cannot 401 a push.
    """
    arg = _deploy_arg(SPECS[env])
    assert ".run.app" not in arg, (
        f"cloudbuild.{env}.yaml hardcodes a Cloud Run hostname. The service's URL "
        "is minted by the first deploy; predicting it makes the OIDC audience a "
        "guess, and a wrong guess 401s every Pub/Sub push silently."
    )


def _raw_env_value(body: str, name: str) -> str:
    """The UNSUBSTITUTED `value:` line for one env var in the heredoc.

    Read from the raw text, because the whole question here is what the file
    says BEFORE Cloud Build and bash have had their turns — the parsed document
    has already resolved the expansion away.
    """
    lines = body.splitlines()
    for i, line in enumerate(lines):
        if line.strip() == f"- name: {name}":
            nxt = lines[i + 1].strip()
            assert nxt.startswith("value:"), f"{name} is not a plain value: {nxt!r}"
            return nxt[len("value:") :].strip().strip('"')
    raise AssertionError(f"{name} not found in the embedded service spec")


@pytest.mark.parametrize("env", ["qa", "prod"])
def test_cloud_run_url_is_a_shell_expansion_not_a_literal(env: str):
    _pre, body, _post = _split_deploy_arg(SPECS[env])
    value = _raw_env_value(body, "CLOUD_RUN_URL")
    assert value == "$${CLOUD_RUN_URL}", (
        f"cloudbuild.{env}.yaml sets CLOUD_RUN_URL to {value!r} instead of the shell "
        "variable `$${CLOUD_RUN_URL}`. `$$` is Cloud Build's escape for a literal "
        "dollar; a single `$` is eaten by the substitution pass before bash sees it, "
        "and a literal is a prediction of a URL only the first deploy can mint."
    )


@pytest.mark.parametrize("env", ["qa", "prod"])
def test_url_is_resolved_before_the_spec_is_written(env: str):
    pre, _body, _post = _split_deploy_arg(SPECS[env])
    assert "gcloud run services describe" in pre
    assert "status.url" in pre
    assert "CLOUD_RUN_URL=" in pre


@pytest.mark.parametrize("env", ["qa", "prod"])
def test_url_is_verified_and_corrected_after_the_replace(env: str):
    """The re-read is what turns a prediction into a measurement.

    On a first deploy the service does not exist, so the spec necessarily ships
    a value that is not yet true. What makes that safe is that the SAME step
    re-reads the URL Cloud Run actually minted and corrects the variable —
    `--update-env-vars`, which MERGES; `--set-env-vars` would drop every other
    variable including the secret-backed ones.
    """
    _pre, _body, post = _split_deploy_arg(SPECS[env])
    assert "gcloud run services replace" in post
    assert "gcloud run services describe" in post, "the deployed URL is never re-read"
    assert "gcloud run services update" in post
    assert "--update-env-vars" in post
    assert "CLOUD_RUN_URL=" in post
    assert "--set-env-vars" not in post, (
        "--set-env-vars REPLACES a service's env list rather than merging into it"
    )
    assert "exit 1" in post, "an unverifiable audience must fail the build, not ship"


@pytest.mark.parametrize("env", ["qa", "prod"])
def test_unresolvable_url_fails_the_build_rather_than_guessing(env: str):
    pre, _body, _post = _split_deploy_arg(SPECS[env])
    assert "exit 1" in pre, (
        "a describe failure that is NOT 'service missing' must stop the build. "
        "Deploying a sentinel over a LIVE service on a transient gcloud error "
        "would 401 the whole fleet."
    )


@pytest.mark.parametrize("env", ["qa", "prod"])
def test_first_deploy_sentinel_can_never_be_a_real_url(env: str):
    """The bootstrap value is `.invalid` (RFC 2606), not a plausible hostname.

    A plausible placeholder is the defect: it looks like a working configuration
    in `/health`, in the spec and in a log line. `.invalid` is reserved and can
    never resolve, so its presence anywhere downstream is unambiguous.
    """
    pre, _body, _post = _split_deploy_arg(SPECS[env])
    sentinels = re.findall(r'CLOUD_RUN_URL="([^"]+)"', pre)
    literals = [s for s in sentinels if s.startswith("http")]
    assert literals, "no bootstrap sentinel found"
    for value in literals:
        assert value.endswith(".invalid"), (
            f"the first-deploy sentinel is {value!r}. It must be unmistakably not a "
            "URL, or it is indistinguishable from a correctly configured audience."
        )


def _shell_code(path: Path) -> str:
    """`path` with whole-line `#` comments removed.

    The assertions below are about what the script DOES, and the script now
    explains the placeholder it deleted — so a naive substring search over the
    file finds the prose and reports the very defect the prose describes being
    fixed. Only full-line comments are stripped, never a trailing `#`, because
    a `#` inside a string is not a comment and guessing wrong would silently
    shorten the text these assertions read.
    """
    return "\n".join(
        line for line in path.read_text().splitlines() if not line.lstrip().startswith("#")
    )


def test_setup_pubsub_no_longer_invents_a_us_fundamentals_url():
    text = _shell_code(PUBSUB_SCRIPT)
    assert "us-fundamentals-${ENV}-placeholder" not in text, (
        "setup-pubsub.sh fabricates an audience for the EDGAR subscriptions. Seven "
        "subscriptions with a placeholder audience look PRESENT and healthy while "
        "401ing every delivery — strictly worse than not creating them."
    )


def test_setup_pubsub_refuses_and_exits_non_zero_when_the_service_is_absent():
    text = _shell_code(PUBSUB_SCRIPT)
    assert "EDGAR_PUSH_READY=0" in text
    assert "EDGAR_PUSH_READY=1" in text
    # The subscription loop must be gated.
    assert '[ "$EDGAR_PUSH_READY" = "1" ] || continue' in text, (
        "the EDGAR subscription loop is not gated on a resolved URL"
    )
    # And the run must be observable as incomplete from OUTSIDE the terminal.
    tail = text[text.rindex('EDGAR_PUSH_READY" != "1"') :]
    assert "exit 1" in tail, (
        "an incomplete run exits 0. The exit code is the only channel by which a "
        "CI step or a --dry-run ladder can learn the EDGAR subscriptions are missing."
    )


def test_setup_pubsub_still_sets_the_audience_from_the_described_url():
    """The refusal must not have removed the thing it protects."""
    text = _shell_code(PUBSUB_SCRIPT)
    assert text.count('--push-auth-token-audience="${US_FUNDAMENTALS_URL}"') >= 2, (
        "both the create and the update branch must set the EDGAR audience from the "
        "us-fundamentals URL; the update branch is what HEALS a first deploy"
    )


# ── 6. T19 — Datadog APM is started, not merely claimed ─────────────────────


def test_dockerfile_cmd_starts_tracing_under_ddtrace_run():
    cmd = dockerfile_cmd()
    assert cmd[0] == "ddtrace-run", (
        f"CMD is {cmd!r}. Without ddtrace-run no tracer is ever created, while the "
        "service spec sets DD_TRACE_ENABLED and runs the serverless-init sidecar — "
        "a spec claiming a capability the container does not have."
    )
    assert "uvicorn" in cmd and "app.main:app" in cmd
    # ONE worker: ddtrace-run's bootstrap needs no fork to survive, and a second
    # uvicorn worker would double this container's share of the SEC rate limit
    # without the fleet-wide Redis limiter knowing.
    assert cmd[cmd.index("--workers") + 1] == "1"


def test_dd_version_is_baked_into_the_image():
    text = DOCKERFILE.read_text()
    assert re.search(r"^ARG DD_VERSION", text, flags=re.MULTILINE), (
        "DD_VERSION is a property of the IMAGE. The five Cloud Run JOBS have their "
        "env written once at provision time and cannot carry a release SHA, so "
        "without the ARG they report 'unknown' forever."
    )
    assert re.search(r"^ENV DD_VERSION=\$\{DD_VERSION\}", text, flags=re.MULTILINE)


@pytest.mark.parametrize("env", ["qa", "prod"])
def test_build_step_passes_dd_version_as_a_build_arg(env: str):
    args = _build_args(SPECS[env])
    assert "--build-arg" in args, f"cloudbuild.{env}.yaml never passes a --build-arg"
    idx = args.index("--build-arg")
    assert args[idx + 1] == "DD_VERSION=$COMMIT_SHA", args[idx + 1]


@pytest.mark.parametrize("env", ["qa", "prod"])
def test_apm_claim_and_apm_capability_agree(env: str):
    """If the spec CLAIMS tracing, the image must start it — and vice versa.

    Written as a biconditional rather than two flat assertions so a future
    decision to drop APM stays expressible: removing the env and the CMD wrapper
    together keeps this green, removing either one alone does not.
    """
    entries = _env_entries(env)
    claims = str(entries.get("DD_TRACE_ENABLED", {}).get("value", "")).lower() == "true"
    starts = dockerfile_cmd()[0] == "ddtrace-run"
    assert claims == starts, (
        f"cloudbuild.{env}.yaml sets DD_TRACE_ENABLED={claims} while the Dockerfile "
        f"{'does' if starts else 'does not'} start ddtrace. DogStatsD metrics arrive "
        "either way, so the Datadog service page looks healthy with zero traces."
    )
    if claims:
        assert entries["DD_TRACE_AGENT_URL"]["value"] == "http://localhost:8126"
        assert "datadog-agent" in _containers(env), "no sidecar to receive the traces"


def test_ddtrace_is_a_declared_dependency():
    """The CMD's first token must be installed, or the container cannot start."""
    text = PYPROJECT.read_text()
    assert re.search(r'^\s*"ddtrace[><=~]', text, flags=re.MULTILINE), (
        "Dockerfile CMD runs `ddtrace-run` but ddtrace is not a declared dependency"
    )


# ── 7. Every provisioned job is re-pinned on every release ──────────────────


def test_job_derivation_is_not_vacuous():
    bases = provisioned_job_bases()
    assert len(bases) >= 5, bases
    assert "edgar-bulk-ftd" in bases


@pytest.mark.parametrize("env", ["qa", "prod"])
def test_every_provisioned_job_is_in_the_repin_loop(env: str):
    provisioned = provisioned_job_bases()
    repinned = repinned_job_bases(env)
    missing = sorted(provisioned - repinned)
    extra = sorted(repinned - provisioned)
    assert not missing, (
        f"cloudbuild.{env}.yaml does not re-pin {missing}. A Cloud Run JOB pins its "
        "image at provision time and `services replace` moves only the SERVICE, so "
        "an unnamed job keeps its provisioning image forever — and it does not "
        "fail, it succeeds at running last release's code (MONEY-1235)."
    )
    assert not extra, (
        f"cloudbuild.{env}.yaml re-pins {extra}, which "
        "setup-us-fundamentals-jobs.sh does not create."
    )


@pytest.mark.parametrize("env", ["qa", "prod"])
def test_repin_touches_only_the_image(env: str):
    """Two writers over one job's env is 'whichever ran last wins, silently'.

    `gcloud run jobs update --set-env-vars` REPLACES a job's env list, and that
    list is owned by setup-us-fundamentals-jobs.sh (SEC_EGRESS per environment,
    the bucket, the secrets). A re-pin that also rewrote env would reintroduce
    the conflict on EVERY release, with a whole environment's egress mode as the
    loser.
    """
    arg = _repin_arg(SPECS[env])
    for forbidden in ("--set-env-vars", "--update-env-vars", "--set-secrets", "DD_VERSION="):
        assert forbidden not in arg, f"the re-pin step passes {forbidden}"
    assert "--image=" in arg


# ── 8. The shell scripts stay parseable ─────────────────────────────────────


#: Cloud Build's built-in substitutions. A `${NAME}` that is neither declared in
#: the spec's own `substitutions:` block nor on this list fails the BUILD, before
#: any step runs — Cloud Build validates the template and rejects an unknown key.
CLOUD_BUILD_BUILTINS = frozenset(
    {
        "PROJECT_ID",
        "PROJECT_NUMBER",
        "BUILD_ID",
        "COMMIT_SHA",
        "SHORT_SHA",
        "REVISION_ID",
        "REPO_NAME",
        "REPO_FULL_NAME",
        "BRANCH_NAME",
        "TAG_NAME",
        "TRIGGER_NAME",
        "TRIGGER_BUILD_CONFIG_PATH",
        "LOCATION",
        "SERVICE_ACCOUNT",
        "SERVICE_ACCOUNT_EMAIL",
    }
)


@pytest.mark.parametrize("env", ["qa", "prod"])
def test_every_dollar_reference_is_escaped_or_declared(env: str):
    """A bash variable inside a build step MUST be written `$${NAME}`.

    Cloud Build substitutes before bash ever runs, and it VALIDATES the template
    while doing so: an undeclared `${SVC}` is rejected outright, so the release
    fails at the config-parse stage with a message about substitutions rather
    than about the shell. `$$` is the escape that hands the reference to bash
    instead.

    This is the assertion the `bash -n` test below cannot make. A single-dollar
    bash variable is still perfectly valid bash — it only stops being valid
    Cloud Build — so the syntax check stays green on exactly the mistake the
    `$$` discipline exists to prevent.
    """
    doc, steps = _steps(SPECS[env])
    allowed = set(doc.get("substitutions") or {}) | CLOUD_BUILD_BUILTINS
    for i, step in enumerate(steps):
        for j, arg in enumerate(step.get("args", [])):
            if not isinstance(arg, str):
                continue
            # Drop the escaped references; whatever is left is a real
            # substitution and must name something Cloud Build knows.
            for chunk in arg.split("$$"):
                for name in re.findall(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?", chunk):
                    assert name in allowed, (
                        f"cloudbuild.{env}.yaml step {i} arg {j} references ${name}, "
                        "which is neither a declared substitution nor a Cloud Build "
                        f"built-in. If it is a BASH variable, write it $${{{name}}}: "
                        "Cloud Build rejects an unknown substitution key and the "
                        "build never reaches the shell."
                    )


@pytest.mark.parametrize("env", ["qa", "prod"])
def test_cloud_build_bash_steps_parse_after_substitution(env: str):
    """`bash -n` every bash step, SUBSTITUTED the way Cloud Build substitutes it.

    The deploy step is a heredoc inside a YAML block scalar inside a shell
    argument. A mis-indented `EOF`, an unbalanced quote, or a `$` that should
    have been `$$` produces a file that parses fine as YAML and then fails at
    the only moment it runs — in a release, after the image has been pushed.
    Checking the RENDERED text (not the raw) is the point: `$$` -> `$` is part
    of what makes it valid, so the raw form would not tell us.
    """
    import subprocess

    doc, steps = _steps(SPECS[env])
    subs = _substitutions(doc)
    checked = 0
    for i, step in enumerate(steps):
        if step.get("entrypoint") != "bash":
            continue
        script = _render(str(step["args"][-1]), subs)
        result = subprocess.run(
            ["bash", "-n"], input=script, capture_output=True, text=True, check=False
        )
        checked += 1
        assert result.returncode == 0, (
            f"cloudbuild.{env}.yaml step {i} is not valid bash after substitution:\n{result.stderr}"
        )
    assert checked == 2, f"expected 2 bash steps in cloudbuild.{env}.yaml, found {checked}"


@pytest.mark.parametrize("script", [PUBSUB_SCRIPT, JOBS_SCRIPT])
def test_shell_scripts_are_syntactically_valid(script: Path):
    """A `bash -n` equivalent for the two scripts this contract reads.

    Cheap, and it is the failure this module could otherwise CAUSE: the
    assertions above read these files as text, so a broken edit to one of them
    shows up here as a confusing regex miss rather than as a syntax error.
    """
    import subprocess

    assert script.exists(), script
    result = subprocess.run(
        ["bash", "-n", str(script)], capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr


def test_pubsub_script_edgar_topics_match_the_service_routes():
    """The topic list and the route list are one fact spelled in two files.

    `setup-pubsub.sh` builds each push endpoint as `${URL}/jobs/${BASE_TOPIC}`,
    so a topic with no matching route answers 404 to every delivery — which
    Pub/Sub retries five times and dead-letters.
    """
    text = PUBSUB_SCRIPT.read_text()
    block = re.search(r"declare -a EDGAR_TOPICS=\((.*?)\n\)", text, flags=re.DOTALL)
    assert block, "EDGAR_TOPICS array not found in setup-pubsub.sh"
    topics = set(shlex.split(re.sub(r"#.*", "", block.group(1))))
    assert len(topics) == 7, sorted(topics)

    from app.main import JOB_ROUTES

    assert topics == set(JOB_ROUTES), (
        f"topics only: {sorted(topics - set(JOB_ROUTES))}; "
        f"routes only: {sorted(set(JOB_ROUTES) - topics)}"
    )


# ── the budget/timeout pairing ──────────────────────────────────────────────
#
# Two numbers in two files that must stay ordered. A budget LARGER than its
# job's task timeout is not a slow job — it is a job that can never stop itself,
# so Cloud Run hard-kills it and every checkpoint since the last flush is lost.
# That is precisely the failure the `finally` flushes were added to prevent.

#: job -> (shell timeout variable, the code constant that job actually reads).
#: Resolved from the modules rather than restated, so a changed constant moves
#: this test with it instead of leaving it asserting a stale literal.
BUDGET_PAIRS = {
    "edgar-bulk-submissions": ("TASK_TIMEOUT_SUBMISSIONS", "submissions"),
    "edgar-bulk-companyfacts": ("TASK_TIMEOUT_COMPANYFACTS", "companyfacts"),
    "edgar-xbrl-backfill": ("TASK_TIMEOUT_XBRL", "xbrl"),
    "edgar-ownership-backfill": ("TASK_TIMEOUT_OWNERSHIP", "ownership"),
    "edgar-bulk-ftd": ("TASK_TIMEOUT_FTD", "ftd"),
}

#: The budget is checked BETWEEN units, so the true wall is
#: ``budget + one worst unit``. One hour covers the largest filer with room for
#: the final checkpoint flush.
MIN_HEADROOM_SECONDS = 3600.0


def _shell_timeouts() -> dict[str, float]:
    """``TASK_TIMEOUT_X="NNN"`` assignments from the jobs script."""
    import re

    found = {}
    for name, value in re.findall(
        r'^(TASK_TIMEOUT_[A-Z]+)="(\d+)"', JOBS_SCRIPT.read_text(), re.M
    ):
        found[name] = float(value)
    return found


def _code_budget(feed: str) -> float:
    from app.bulk import backfill_logic, common

    if feed == "submissions":
        return common.DEFAULT_BUDGET_SECONDS[common.FEED_SUBMISSIONS]
    if feed == "companyfacts":
        return common.DEFAULT_BUDGET_SECONDS[common.FEED_COMPANYFACTS]
    return {
        "xbrl": backfill_logic.XBRL_BUDGET_SECONDS,
        "ownership": backfill_logic.OWNERSHIP_BUDGET_SECONDS,
        "ftd": backfill_logic.FTD_BUDGET_SECONDS,
    }[feed]


def test_the_budget_pairing_table_is_not_vacuous():
    """Without this the loop below can pass over an empty dict."""
    timeouts = _shell_timeouts()
    assert len(BUDGET_PAIRS) == 5
    for job, (var, feed) in BUDGET_PAIRS.items():
        assert var in timeouts, f"{job}: {var} no longer assigned in {JOBS_SCRIPT.name}"
        assert _code_budget(feed) > 0, f"{job}: budget for {feed!r} resolved to 0"


def test_every_job_budget_fits_inside_its_own_task_timeout():
    """A budget past its timeout means Cloud Run kills the job before the job
    can stop itself — no BUDGET_EXHAUSTED, no final flush, no clean resume."""
    timeouts = _shell_timeouts()
    for job, (var, feed) in BUDGET_PAIRS.items():
        timeout = timeouts[var]
        budget = _code_budget(feed)
        assert budget + MIN_HEADROOM_SECONDS <= timeout, (
            f"{job}: budget {budget:.0f}s + {MIN_HEADROOM_SECONDS:.0f}s headroom "
            f"exceeds {var}={timeout:.0f}s. The job cannot stop itself cleanly; "
            "Cloud Run will hard-kill it and discard the checkpoints since the "
            "last flush. Raise the timeout or lower the budget — together."
        )


def test_the_jobs_script_does_not_pin_one_budget_for_every_job():
    """`EDGAR_BULK_BUDGET_SECONDS` overrides EVERY feed, so putting it in the
    env string all five `deploy_job` calls share is not an override of one job
    but a flattening of all of them.

    It was there, at a uniform 82800, which companyfacts (timeout 21600) and ftd
    (timeout 7200) could never reach. Caught before it ran: prod still shows the
    variable on submissions ALONE, which is why the other four remain correct.
    """
    src = JOBS_SCRIPT.read_text()
    shared = [
        line for line in src.splitlines() if "--set-env-vars=" in line and "deploy_args" not in line
    ]
    for line in shared:
        assert "EDGAR_BULK_BUDGET_SECONDS" not in line, (
            "the shared deploy_job env string sets EDGAR_BULK_BUDGET_SECONDS, which "
            "overrides the per-feed budgets for ALL five jobs at once. Set it on a "
            "single job with --update-env-vars if one run needs a different budget."
        )


# ── The metrics transport (MONEY-1278) ──────────────────────────────────────
#
# The JOBS and the SERVICE ship DIFFERENT postures here, which is the opposite
# of every other flag in this file — and the difference is forced by the
# deployment shape rather than chosen. The service runs beside a
# `datadog-agent` sidecar and talks DogStatsD to it on localhost. The five
# Cloud Run JOBS have no sidecar at all, so their UDP packets were refused by a
# closed port and dropped in silence while `[job-outcome] {...}` kept logging
# perfectly. A metric that never arrives renders as NO DATA, not as an alert.
#
# Both directions are asserted. A job that loses `http` goes back to shouting
# into a closed port; a service that GAINS it bypasses a healthy sidecar and
# spends a billed request per emit.


def test_every_job_ships_the_http_transport_and_the_key_it_needs():
    src = JOBS_SCRIPT.read_text()

    env_flag = re.search(r'--set-env-vars="([^"]+)"', src)
    assert env_flag, "no --set-env-vars in the jobs script"
    assert "DD_METRICS_TRANSPORT=http" in env_flag.group(1), (
        "the jobs have no sidecar; without this they emit DogStatsD into a "
        "closed port and every counter is dropped in silence"
    )

    secrets = re.search(r'--set-secrets="([^"]+)"', src)
    assert secrets, "no --set-secrets in the jobs script"
    assert "DD_API_KEY=${DD_SECRET}:latest" in secrets.group(1), (
        "the HTTP transport is a no-op without DD_API_KEY, so the flag above "
        "would change the wire and still emit nothing"
    )

    # Per-env key names, from the same case arms that pick DATABASE_URL.
    for env in ("prod", "qa"):
        arm = re.search(rf"^\s*{env}\)(.*?)^\s*;;", src, re.S | re.M)
        assert arm, f"no `{env})` branch in {JOBS_SCRIPT.name}"
        assert re.search(rf'DD_SECRET="DD_API_KEY_{env.upper()}"', arm.group(1)), (
            f"the `{env})` branch does not name a Datadog key secret"
        )

    # One flag of each kind: both REPLACE rather than merge, and gcloud takes
    # the last, so a second flag silently drops everything the first supplied.
    assert len(re.findall(r"--set-env-vars=", src)) == 1
    assert len(re.findall(r"--set-secrets=", src)) == 1


@pytest.mark.parametrize("env", ["qa", "prod"])
def test_the_service_keeps_dogstatsd_and_the_sidecar_that_receives_it(env: str):
    entries = _env_entries(env)
    assert entries.get("DD_METRICS_TRANSPORT", {}).get("value") == "statsd", (
        "the service must stay on DogStatsD — it HAS a sidecar, and stating it "
        "explicitly is what keeps 'absent' and 'deliberately off' distinct "
        "(MONEY-1214)"
    )
    assert "datadog-agent" in _containers(env), (
        "DD_METRICS_TRANSPORT=statsd with no sidecar is the exact defect "
        "MONEY-1278 fixed for the jobs"
    )
