#!/usr/bin/env bash
#
# Datadog Database Monitoring for the prod MongoDB Atlas cluster — MONEY-1377.
#
#   scripts/ops/datadog/setup-dbm-host.sh [--dry-run] [--from=STAGE] [--only=STAGE]
#
#     0 vm       reserve a static IP and create the dedicated agent VM
#     1 agent    install the Datadog Agent from Datadog's apt repository
#     2 config   render mongo.d/conf.yaml — ONE INSTANCE BLOCK PER REPLICA MEMBER
#     3 verify   prove the check is collecting, and that the metrics ARRIVED
#
# ## Why a whole VM for one check
#
# Nothing else in this estate can host it. The agent must hold a long-lived
# connection to each replica-set member and delta counters between collection
# intervals, and Cloud Run — where every other workload here lives — is wrong on
# two independent counts. Its egress is a DYNAMIC IP POOL, so there is no `/32`
# to put on the Atlas access list without adding Direct VPC egress plus a Cloud
# NAT plus a reserved address (strictly more infrastructure than the VM it would
# be avoiding); and a service that scales to zero collects NOTHING for the whole
# window it is down, which is not an error, not a failed check, just a gap.
#
# It is also DEDICATED rather than a passenger on an existing box, and that is a
# deliberate reversal. Putting it on `usemoney-prod-redis` would have been one
# fewer VM and would have bought host metrics for a box we do not monitor — but
# it ties the lifetime of database monitoring to the lifetime of an unrelated
# workload. When that workload is retired the box goes with it, and the thing
# that dies is the monitoring, silently, at exactly the moment nobody is looking
# at it. `--deletion-protection` is on for the same reason.
#
# ## The defect this file exists to avoid
#
# `hosts:` takes a list and the cluster has an SRV record, so the obvious config
# is one instance block naming the SRV name, or one block listing all three
# members. BOTH ARE WRONG, and neither fails.
#
# Most MongoDB metrics are monotonic counters. The agent reports RATES by
# subtracting the previous collection's value from this one's. If the connection
# lands on a different member between two intervals — which is precisely what an
# SRV connection string is FOR — the agent subtracts node B's counter from node
# A's and publishes the difference. The check stays green, the dashboards keep
# drawing, and every rate is fiction. Datadog states this outright: "the Agent
# calculates the difference in statistics between two hosts, producing
# inaccurate metrics."
#
# So: three instance blocks, one member each, resolved from the SRV record at
# render time. Re-run this script after any Atlas topology change — a resize or
# a version upgrade can move the member hostnames, and a stale block connects to
# nothing while the other two keep reporting, which looks like a partial outage
# rather than a stale config.
#
# ## Credentials
#
# Two secrets, both from Secret Manager, neither ever on a command line — a
# remote `--command=` string is visible in `ps` on the target host for as long as
# it runs. Both are streamed over ssh's stdin into a single `install -m 0600`.
#
# The rendered conf.yaml holds the Mongo password in plaintext at 0600
# dd-agent:dd-agent, which is the standard Datadog posture.
# ponytail: file-permission secrecy, not an encrypted backend. If that ceiling
# ever matters, Datadog's `ENC[]` secret-backend hook takes an executable that
# could shell out to `gcloud secrets versions access` — about 15 lines. Not
# built, because it moves the secret from a 0600 file on a locked-down VM into a
# 0600 executable on the same VM.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- what we are pointing at --------------------------------------------------
# The cluster is named ONCE. `cluster_name` is a Datadog tag value and is
# silently normalised (lowercased, spaces to underscores), so a name that is
# already lowercase cannot drift between what we set and what we query.
CLUSTER_SRV="stockbook.lizbtx.mongodb.net"
CLUSTER_NAME="stockbook"
MONGO_USER="datadog_monitor"

VM_NAME="usemoney-prod-datadog-agent"
VM_ZONE="asia-south1-a"
VM_TYPE="e2-small"
IP_NAME="${VM_NAME}-ip"

GCP_PROJECT="stock-book-483718"
GCP_ACCOUNT="founder@disdigital.in"

DD_API_SECRET="DD_API_KEY_PROD"
DD_APP_SECRET="DD_APP_KEY_PROD"
MONGO_PW_SECRET="DD_MONGO_MONITOR_PASSWORD_PROD"

# Datadog requires 7.58.0+ for MongoDB DBM. Below it the check loads and runs
# and simply never emits the dbm payloads — a silent partial, not a failure.
MIN_AGENT_VERSION="7.58.0"

# How long `verify` waits before it looks. The mongo check collects every 15s,
# but a point also has to reach the intake and become queryable, so this is
# sized for ingest lag rather than for the collection interval.
VERIFY_WAIT_S=120

# How many replica members we expect to be reporting. Set from the SRV answer by
# `config`; `verify` resolves it itself when run alone (`--only=verify`) rather
# than assuming a number, because a cluster resize is exactly the case this
# stage exists to catch.
MEMBER_COUNT=""

DRY_RUN=false
STAGES=(vm agent config verify)
FROM=""
ONLY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --from=*)  FROM="${1#*=}"
               [[ -n "$FROM" ]] || { echo "--from= needs a stage (${STAGES[*]})" >&2; exit 2; } ;;
    --only=*)  ONLY="${1#*=}"
               # An EMPTY value used to fall through the validation loop below
               # and then past the `[[ -n "$ONLY" ]]` gate in run_stage, so
               # `--only=` ran every stage INCLUDING VM creation — the opposite
               # of what someone typing `--only=` is asking for.
               [[ -n "$ONLY" ]] || { echo "--only= needs a stage (${STAGES[*]})" >&2; exit 2; } ;;
    *) echo "unknown argument: $1" >&2
       echo "usage: $(basename "$0") [--dry-run] [--from=STAGE] [--only=STAGE]" >&2
       echo "       stages: ${STAGES[*]}" >&2
       exit 2 ;;
  esac
  shift
done

for s in ${FROM:+$FROM} ${ONLY:+$ONLY}; do
  # shellcheck disable=SC2076
  [[ " ${STAGES[*]} " == *" $s "* ]] || { echo "unknown stage: $s (want: ${STAGES[*]})" >&2; exit 2; }
done

# shellcheck source=./lib-datadog.sh
source "$HERE/lib-datadog.sh"
dd_resolve_api_host || exit 1

# Trailing-flag wrapper. Safe for every gcloud subcommand EXCEPT one with a
# `--` passthrough — there the appended flags land past the separator and are
# handed to the wrapped program instead of to gcloud. `compute ssh` is exactly
# that shape, which is why it has its own helper below rather than using this.
gc() { CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud "$@" --account="$GCP_ACCOUNT" --project="$GCP_PROJECT"; }

# `compute ssh`, with every gcloud flag BEFORE the `--` and only ssh's own
# options after it. Routing this through `gc` put `--account=…` past the
# separator, where ssh read it as one of its flags and refused to connect.
vm_ssh() {   # vm_ssh <remote command>   — anything on stdin is forwarded
  CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud compute ssh "$VM_NAME" \
    --zone="$VM_ZONE" --account="$GCP_ACCOUNT" --project="$GCP_PROJECT" \
    --command="$1" \
    -- -o ConnectTimeout=25 -o BatchMode=yes -o StrictHostKeyChecking=accept-new
}

# Run a script on the agent VM, ALWAYS over stdin, never as a `--command=`
# string.
#
# Two reasons, one of which is a bug this already hit. gcloud mangles a
# multi-line `--command` — it reaches ssh as separate words and ssh rejects the
# first one that looks like a flag ("illegal option -- -"), so a heredoc-shaped
# install script fails before it connects. Piping to `bash -s` is immune to
# quoting and newlines entirely.
#
# The second reason is why it stays this way even for one-liners: a remote
# `--command` string is visible in `ps` on the TARGET host for as long as it
# runs. Nothing here carries a secret in its command today, and routing every
# call through stdin means nothing can start to.
on_vm() { printf '%s\n' "$1" | vm_ssh 'bash -s'; }

# Stream a local file to a remote path as root, 0600, without it ever appearing
# in argv or in a world-readable staging location.
push_file() {
  local src="$1" dest="$2" owner="$3"
  # ONE `install`, not tee-then-chown-then-chmod. The old chain created the file
  # through `tee` under root's umask (0644) and only narrowed it two links
  # later, so a failing `chown` stopped the `&&` chain with the Atlas password
  # sitting world-readable in /etc/datadog-agent. `install` sets owner and mode
  # as it creates, so the window does not exist and neither does the ordering.
  # `-d` on the parent no longer forces 0755 over a directory the package may
  # ship tighter.
  vm_ssh "sudo mkdir -p \"\$(dirname '$dest')\" && sudo install -m 0600 -o ${owner%%:*} -g ${owner##*:} /dev/stdin '$dest'" < "$src"
}

secret() {
  local name="$1"
  gc secrets versions access latest --secret="$name" 2>/dev/null
}

# How many DISTINCT replica members are reporting `metric` since `from_epoch`.
#
# Deliberately not `dd_metric_has_points`, on two counts, both of which let a
# dead check read as healthy:
#
#   THE WINDOW. That helper looks back 24 HOURS. This script's own header tells
#   you to re-run it after an Atlas topology change — so the run that is
#   supposed to catch a bad render is exactly the run whose "3/3 arriving" is
#   satisfied by YESTERDAY's points. The window here starts when this stage
#   started, so only what arrived since the restart can count.
#
#   THE GROUPING. A cluster-scoped query cannot see a stale member: three blocks
#   where one connects to nothing still leaves the series alive from the other
#   two. The header names that failure mode outright ("a stale block connects to
#   nothing while the other two keep reporting"). Counting distinct members is
#   what actually tests for it.
#
#   `database_instance`, NOT `host`. Measured against the live estate: `host`
#   carries ONE value, `usemoney-prod-datadog-agent` — the agent VM, because
#   that is the machine the check runs on. Grouping by it collapses all three
#   members into one series and can never reach 3/3, so the first version of
#   this reported PARTIAL 1/3 against a perfectly healthy cluster. The tags that
#   actually carry one value per member are `database_instance` (the resolved
#   Atlas hostname, DBM's own identifier), `replset_me` and `server`.
#
# Sets DBM_HOSTS to the count. Returns 2 when the query did NOT RUN, so "we
# could not measure" is never collapsed into "nothing arrived" — the same
# three-outcome rule `dd_events_exist` exists to enforce.
#
# It SETS A GLOBAL rather than echoing, and that is the whole point. Called as
# `n="$(dbm_reporting_hosts …)"` the function ran in a command-substitution
# SUBSHELL, so `dd_request`'s RESPONSE_STATUS and RESPONSE_BODY were assigned in
# a child and never reached the caller: the error line resolved
# `${RESPONSE_STATUS:-?}` to `?` in every weather. An expired app key (403), a
# malformed query (400) and a curl that never answered (000) all printed
# identically, on the one stage whose entire purpose is telling you which.
dbm_reporting_hosts() {   # dbm_reporting_hosts <metric> <from_epoch>  -> DBM_HOSTS
  local metric="$1" from="$2" now encoded
  DBM_HOSTS=0
  now=$(date +%s)
  encoded="$(QUERY="sum:${metric}{db_cluster:${CLUSTER_NAME}} by {database_instance}" \
    node -e 'process.stdout.write(encodeURIComponent(process.env.QUERY))')" || return 2
  dd_request GET "https://${DD_API_HOST}/api/v1/query?from=${from}&to=${now}&query=${encoded}" || return 2
  DBM_HOSTS="$(BODY="$RESPONSE_BODY" node -e '
    let series;
    try { series = JSON.parse(process.env.BODY).series; } catch { process.exit(3); }
    if (!Array.isArray(series)) process.exit(3);
    // A series with only null points is a group Datadog knows about and has no
    // data for — it must not count as a reporting member.
    const live = series.filter((s) => (s.pointlist || []).some((p) => p[1] !== null));
    process.stdout.write(String(live.length));
  ')" || return 2
}

run_stage() {
  local want="$1"
  if [[ -n "$ONLY" ]]; then [[ "$ONLY" == "$want" ]] && return 0 || return 1; fi
  if [[ -n "$FROM" ]]; then
    local hit=false
    for s in "${STAGES[@]}"; do
      [[ "$s" == "$FROM" ]] && hit=true
      [[ "$s" == "$want" ]] && { $hit && return 0 || return 1; }
    done
  fi
  return 0
}

# CREDENTIALS, DEMANDED BEFORE ANY STAGE RUNS — but only by the stage that uses
# them.
#
# `verify` is the sole consumer of DD_API_KEY/DD_APP_KEY: `config` reads its
# agent key straight from Secret Manager (`secret "$DD_API_SECRET"`), and `vm`
# and `agent` touch no Datadog API at all. Requiring both on every invocation
# made `--only=vm` fail on a credential it never uses — and rebuilding a deleted
# host is the likeliest reason to reach for a single stage.
#
# Demanding them HERE rather than inside `verify` still matters. The check used
# to sit deep in the stage, behind `${DD_API_KEY:=$(secret …)}`, which quietly
# fetched a key from Secret Manager — so a credential-less run did not stop, it
# went and got them and provisioned.
#
# Note the DIRECTION, because the first version of this comment had it
# backwards: `datadog-scripts-portability.test.ts` builds its population by
# grepping for `${DD_API_KEY:?`, so the pre-fix script (which used `:=`) was
# never in that test at all. Adding `:?` is what ENROLS this script — and the
# bare, credential-less spawn that test performs is exactly what this guard
# makes safe.
if ! $DRY_RUN && run_stage verify; then
  : "${DD_API_KEY:?export DD_API_KEY first (GCP Secret Manager: DD_API_KEY_PROD)}"
  : "${DD_APP_KEY:?export DD_APP_KEY first (GCP Secret Manager: DD_APP_KEY_PROD)}"
fi

# ---- 0 vm ---------------------------------------------------------------------
stage_vm() {
  echo "── 0 vm ─────────────────────────────────────────────────────────────────"

  if gc compute addresses describe "$IP_NAME" --region="${VM_ZONE%-*}" --format="value(address)" >/dev/null 2>&1; then
    echo "  static IP ${IP_NAME} already reserved"
  elif $DRY_RUN; then
    echo "  would reserve static IP ${IP_NAME} in ${VM_ZONE%-*}"
  else
    gc compute addresses create "$IP_NAME" --region="${VM_ZONE%-*}" \
      --description="Atlas IP access-list entry for the Datadog DBM agent (MONEY-1377). Releasing this breaks database monitoring." >/dev/null
    echo "  reserved static IP ${IP_NAME}"
  fi

  if gc compute instances describe "$VM_NAME" --zone="$VM_ZONE" --format="value(name)" >/dev/null 2>&1; then
    echo "  VM ${VM_NAME} already exists"
  elif $DRY_RUN; then
    echo "  would create ${VM_TYPE} VM ${VM_NAME} in ${VM_ZONE} (ubuntu-2404-lts, deletion-protected)"
  else
    # No service account and no scopes: the box needs no GCP identity. Both
    # secrets are pushed to it at provision time, so an attacker on this host
    # reaches one Mongo READ role and one Datadog ingest key, not the project.
    gc compute instances create "$VM_NAME" \
      --zone="$VM_ZONE" \
      --machine-type="$VM_TYPE" \
      --image-family=ubuntu-2404-lts-amd64 \
      --image-project=ubuntu-os-cloud \
      --boot-disk-size=20GB \
      --boot-disk-type=pd-balanced \
      --address="$IP_NAME" \
      --no-service-account --no-scopes \
      --deletion-protection \
      --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
      --tags="$VM_NAME" \
      --labels=env=prod,component=observability,purpose=datadog-dbm,owner=usemoney,ticket=money-1377 \
      --description="Datadog Agent host for MongoDB Atlas Database Monitoring of the prod cluster ${CLUSTER_SRV} (MONEY-1377). DEDICATED — do not repurpose and do not delete: its static IP is on the Atlas access list and deleting this VM silently ends all database monitoring. Rebuild with scripts/ops/datadog/setup-dbm-host.sh." \
      >/dev/null
    echo "  created ${VM_NAME}"
  fi

  if ! $DRY_RUN; then
    # Read the address off the INSTANCE, not the reservation. `addresses
    # describe` answers whether the address is RESERVED or IN_USE, so a VM that
    # was rebuilt by hand and never attached to it would have us print an IP the
    # agent does not egress from — the operator allow-lists the wrong /32 and
    # `verify` then blames the access list for it.
    VM_IP="$(gc compute instances describe "$VM_NAME" --zone="$VM_ZONE" \
      --format="value(networkInterfaces[0].accessConfigs[0].natIP)")"
    [[ -n "$VM_IP" ]] || { echo "FATAL: ${VM_NAME} has no external IP to allow-list" >&2; exit 1; }
    echo ""
    echo "  Atlas IP access list must contain: ${VM_IP}/32"
  fi
}

# ---- 1 agent ------------------------------------------------------------------
stage_agent() {
  echo "── 1 agent ──────────────────────────────────────────────────────────────"

  if $DRY_RUN; then
    echo "  would add Datadog's apt repository and install datadog-agent (>= ${MIN_AGENT_VERSION})"
    return 0
  fi

  # Datadog's documented apt path. Deliberately NOT `curl … | bash`: the install
  # script is a moving target executed as root on a box that holds a production
  # database credential, and the repository gives the same result auditably.
  on_vm '
    set -euo pipefail
    if command -v datadog-agent >/dev/null 2>&1; then echo "  agent already installed"; exit 0; fi
    sudo apt-get update -qq
    sudo apt-get install -y -qq apt-transport-https ca-certificates curl gnupg
    sudo install -m 0755 -d /usr/share/keyrings
    curl -fsSL https://keys.datadoghq.com/DATADOG_APT_KEY_CURRENT.public \
      | sudo gpg --dearmor --yes -o /usr/share/keyrings/datadog-archive-keyring.gpg
    echo "deb [signed-by=/usr/share/keyrings/datadog-archive-keyring.gpg] https://apt.datadoghq.com/ stable 7" \
      | sudo tee /etc/apt/sources.list.d/datadog.list >/dev/null
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq datadog-agent
  '

  local version
  version="$(on_vm 'datadog-agent version' | grep -oE '7\.[0-9]+\.[0-9]+' | head -1)"
  [[ -n "$version" ]] || { echo "FATAL: could not read the installed agent version" >&2; exit 1; }
  # Fail CLOSED on an old agent. Below 7.58.0 the mongo check still loads and
  # still reports, it just never emits a dbm payload — the exact shape of
  # failure this whole ticket is about.
  if [[ "$(printf '%s\n%s\n' "$MIN_AGENT_VERSION" "$version" | sort -V | head -1)" != "$MIN_AGENT_VERSION" ]]; then
    echo "FATAL: agent ${version} is below the ${MIN_AGENT_VERSION} MongoDB DBM floor" >&2
    exit 1
  fi
  echo "  datadog-agent ${version} (>= ${MIN_AGENT_VERSION})"
}

# ---- 2 config -----------------------------------------------------------------
stage_config() {
  echo "── 2 config ─────────────────────────────────────────────────────────────"

  # Resolve the replica-set members. Fail closed on anything but a full answer:
  # rendering two blocks because DNS was slow leaves one member unmonitored, and
  # a member nobody watches is where the incident is.
  local members
  # `sort -u`: a duplicated SRV target would otherwise satisfy the >= 3 gate
  # having covered only two members — exactly the one-member-unmonitored state
  # the gate exists to refuse.
  members="$(dig +short SRV "_mongodb._tcp.${CLUSTER_SRV}" | awk '{print $4":"$3}' | sed 's/\.:/:/' | sort -u)"
  local count
  count="$(printf '%s\n' "$members" | grep -c . || true)"
  (( count >= 3 )) || { echo "FATAL: SRV resolved ${count} member(s), expected at least 3" >&2; exit 1; }
  MEMBER_COUNT="$count"
  echo "  resolved ${count} replica-set members:"
  printf '    %s\n' $members

  if $DRY_RUN; then
    echo "  would render ${count} instance blocks and restart the agent"
    return 0
  fi

  local api_key mongo_pw pw_yaml
  api_key="$(secret "$DD_API_SECRET")" || true
  [[ -n "${api_key:-}" ]] || { echo "FATAL: ${DD_API_SECRET} is empty or unreadable" >&2; exit 1; }

  mongo_pw="$(secret "$MONGO_PW_SECRET")" || true
  if [[ -z "${mongo_pw:-}" ]]; then
    echo "FATAL: secret ${MONGO_PW_SECRET} does not exist." >&2
    echo "" >&2
    echo "Create it from the Atlas monitoring user's password, reading from stdin so" >&2
    echo "it never lands in your shell history or in ps:" >&2
    echo "" >&2
    echo "  printf %s 'THE-PASSWORD' | CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud secrets create ${MONGO_PW_SECRET} \\" >&2
    echo "    --data-file=- --replication-policy=automatic \\" >&2
    echo "    --account=${GCP_ACCOUNT} --project=${GCP_PROJECT}" >&2
    exit 1
  fi

  # A single-quoted YAML scalar with every embedded quote doubled. Built via
  # `sq` rather than inline escapes so the quoting stays readable.
  # A newline cannot be represented in a single-quoted scalar on one line, and
  # `secret()` strips only TRAILING newlines. An embedded one splits
  # `password: 'line1` from `line2'` and the whole conf.yaml stops parsing —
  # which `--only=config` would not catch, because it exits 0 having pushed the
  # broken file and restarted the agent.
  if [[ "$mongo_pw" == *$'\n'* ]]; then
    echo "FATAL: ${MONGO_PW_SECRET} contains a newline; the agent config cannot represent it." >&2
    echo "Re-store it without one: printf %s 'PASSWORD' | gcloud secrets versions add ${MONGO_PW_SECRET} --data-file=-" >&2
    exit 1
  fi
  local sq="'"
  pw_yaml="${sq}${mongo_pw//${sq}/${sq}${sq}}${sq}"

  local tmp; tmp="$(mktemp -d)"; chmod 700 "$tmp"
  # EXIT INT TERM, not RETURN. A RETURN trap fires on neither `exit` nor a
  # signal, so the version that was here could only fire on the normal return —
  # the one path the explicit `rm -rf` below already covered. What was actually
  # unprotected is Ctrl-C during push_file's ssh, the longest wait in the script,
  # which left the plaintext Atlas password in $TMPDIR on the operator's laptop.
  TMP_DIR="$tmp"
  # Two traps, because one is not enough. On EXIT the handler only cleans up. On
  # INT/TERM it must ALSO exit: a handler with no `exit` returns control to the
  # line after the interrupted command, so `timeout 300 setup-dbm-host.sh`
  # firing during verify's wait deleted the temp dir and then carried on to
  # print "done." and exit 0 — a killed provisioning run reporting success.
  trap 'rm -rf "${TMP_DIR:-}"' EXIT
  trap 'rm -rf "${TMP_DIR:-}"; exit 130' INT TERM

  umask 077

  # The site is DERIVED from the one place it is spelled, never retyped.
  # `dd_resolve_api_host` reads packages/datadog/src/constants.ts and sets
  # DD_API_HOST=api.<site>; stripping the prefix is the site. A hardcoded
  # "us5.datadoghq.com" here would be a sixth spelling of the fact that already
  # cost this estate a silent 403-shaped outage across the us3 -> us5 move.
  local dd_site="${DD_API_HOST#api.}"
  [[ -n "$dd_site" && "$dd_site" != "$DD_API_HOST" ]] || {
    echo "FATAL: could not derive the Datadog site from '${DD_API_HOST}'" >&2; exit 1; }

  { echo "api_key: ${api_key}"
    echo "site: ${dd_site}"
    echo "hostname: ${VM_NAME}"
    echo "tags:"
    echo "  - env:production"
    echo "  - service:mongodb-atlas"
    echo "  - managed-by:setup-dbm-host.sh"
  } > "$tmp/datadog.yaml"

  # ONE BLOCK PER MEMBER. See the header — a shared block deltas counters across
  # nodes and publishes plausible nonsense.
  #
  # `reported_database_hostname` is deliberately NOT set, though Datadog's own
  # template shows it. The agent derives the hostname from `serverStatus.host`,
  # which already returns a distinct, stable name per member
  # (atlas-…-shard-00-00/01/02). Setting one value here would give all three
  # blocks the SAME identity and collapse three nodes into one.
  { echo "## Managed by scripts/ops/datadog/setup-dbm-host.sh (MONEY-1377)."
    echo "## Hand edits are overwritten on the next run. One block per replica member."
    echo "init_config:"
    echo ""
    echo "instances:"
    for m in $members; do
      echo "  - hosts:"
      echo "      - ${m}"
      echo "    username: ${MONGO_USER}"
      # SINGLE-quoted YAML with `'"'"'` doubled. A double-quoted scalar processes
      # escapes, so a password containing a backslash or a quote either fails to
      # parse (taking all three instances with it) or — worse — parses to a
      # DIFFERENT string: `tab\there` becomes a real tab, auth fails, and it
      # reads as an Atlas permissions problem. Atlas permits all of those
      # characters.
      echo "    password: ${pw_yaml}"
      echo "    options:"
      echo "      authSource: admin"
      echo "    tls: true"
      echo "    dbm: true"
      echo "    cluster_name: ${CLUSTER_NAME}"
      echo "    database_autodiscovery:"
      echo "      enabled: true"
      echo "    additional_metrics:"
      echo "      - metrics.commands"
      echo "      - tcmalloc"
      echo "      - top"
      echo "      - collection"
      echo "    tags:"
      echo "      - env:production"
      echo "      - db_cluster:${CLUSTER_NAME}"
    done
  } > "$tmp/conf.yaml"

  push_file "$tmp/datadog.yaml" /etc/datadog-agent/datadog.yaml dd-agent:dd-agent
  push_file "$tmp/conf.yaml"    /etc/datadog-agent/conf.d/mongo.d/conf.yaml dd-agent:dd-agent
  rm -rf "$tmp"; TMP_DIR=""

  on_vm 'sudo systemctl enable --now datadog-agent >/dev/null 2>&1; sudo systemctl restart datadog-agent'
  echo "  wrote ${count} instance blocks and restarted the agent"
}

# ---- 3 verify -----------------------------------------------------------------
stage_verify() {
  echo "── 3 verify ─────────────────────────────────────────────────────────────"

  if $DRY_RUN; then
    echo "  would read the agent's mongo check status and query Datadog for arrived points"
    return 0
  fi

  if [[ -z "$MEMBER_COUNT" ]]; then
    MEMBER_COUNT="$(dig +short SRV "_mongodb._tcp.${CLUSTER_SRV}" \
      | awk '{print $4}' | sort -u | grep -c . || true)"
    (( MEMBER_COUNT >= 3 )) || {
      echo "FATAL: SRV resolved ${MEMBER_COUNT} member(s); cannot verify coverage" >&2; return 1; }
  fi

  # Everything the verification counts must arrive AFTER this instant.
  local t0; t0=$(date +%s)
  echo "  waiting ${VERIFY_WAIT_S}s for a collection interval and ingest lag…"
  sleep "$VERIFY_WAIT_S"

  local status
  status="$(on_vm 'sudo datadog-agent status 2>/dev/null | sed -n "/^    mongo /,/^    [a-z]/p"' || true)"
  # `sed -n 1,40p`, not `head -40`: head closes the pipe early, which under
  # `pipefail` surfaces as 141 now that errexit actually reaches this function.
  printf '%s\n' "$status" | sed 's/^/    /' | sed -n '1,40p'

  # FAIL CLOSED on an empty block. `grep -c` over an empty string is 0, so ssh
  # failing, the agent not running, `datadog-agent status` erroring, or the sed
  # range not matching all used to read as "the check reported no errors" —
  # every one of them indistinguishable from health.
  if ! printf '%s\n' "$status" | grep -qE 'Instance ID: mongo'; then
    echo "" >&2
    echo "  could not read the mongo check's status block from ${VM_NAME}." >&2
    echo "  That is NOT the same as the check being healthy — refusing to say it is." >&2
    return 1
  fi

  local errors
  errors="$(printf '%s\n' "$status" | grep -ciE 'Total Errors: [1-9]|Error:' || true)"
  if (( errors > 0 )); then
    echo ""
    echo "  the mongo check reported errors — NOT declaring this healthy" >&2
    return 1
  fi

  # The agent saying "OK" is not the claim that matters. The claim that matters
  # is that a point ARRIVED in the org, which is the exact link every previous
  # defect in this directory broke while every local indicator stayed green.
  # Both keys were required at the top of the script; nothing is resolved here.
  # A lazy fetch at this point is what let a credential-less run reach the live
  # estate at all.
  export DD_API_KEY DD_APP_KEY

  # These three names are OBSERVED, not guessed. The first draft of this list
  # said `mongodb.opcounters.query.count`, which is a plausible spelling and does
  # not exist — the real one is a per-second rate, `…queryps`. It reported "no
  # data" here, which is the whole reason this stage queries the API instead of
  # trusting the agent's own OK. Had that name gone into a monitor instead, it
  # would have sat in NO DATA forever and looked exactly like a quiet database.
  local want="${MEMBER_COUNT:-3}" bad=0
  for metric in mongodb.opcounters.queryps mongodb.connections.current mongodb.oplog.timediff; do
    local n rc=0
    dbm_reporting_hosts "$metric" "$t0" || rc=$?
    n="$DBM_HOSTS"
    if (( rc != 0 )); then
      echo "  ERROR    ${metric} — the query did not run (HTTP ${RESPONSE_STATUS:-?})" >&2
      # RESPONSE_BODY carries curl's own text on a transport failure ("curl
      # exited 7 without an HTTP response"), which is the half that says WHY.
      [[ -n "${RESPONSE_BODY:-}" ]] && echo "           ${RESPONSE_BODY:0:200}" >&2
      bad=$((bad + 1))
    elif (( n >= want )); then
      echo "  ARRIVED  ${metric}  (${n}/${want} members)"
    else
      # PARTIAL is its own outcome. It is what a stale member block looks like,
      # and it used to be indistinguishable from full health.
      echo "  PARTIAL  ${metric}  (${n}/${want} members reporting)" >&2
      bad=$((bad + 1))
    fi
  done

  echo ""
  if (( bad > 0 )); then
    echo "  ${bad} of 3 sampled metrics did not reach ${want}/${want} members since this stage began." >&2
    echo "  A member reporting nothing is usually a stale host in conf.yaml (re-run --only=config)" >&2
    echo "  or the Atlas IP access list; a blocked agent looks exactly like an idle one." >&2
    return 1
  fi
  echo "  all 3 sampled metrics are arriving from all ${want} members."
  echo ""
  echo "  Do NOT add MongoDB monitors until the series you intend to alert on have"
  echo "  been seen here. A monitor over a metric nobody emits renders NO DATA, and"
  echo "  once muted that is indistinguishable from health (MONEY-1238)."
}

# ---- run ----------------------------------------------------------------------
$DRY_RUN && echo "DRY RUN — nothing is created, installed or written." && echo ""

# `if run_stage X; then stage_X; fi`, NEVER `run_stage X && stage_X`.
#
# A function called as part of a `&&` list is exempt from `errexit`, and the
# exemption covers its whole dynamic extent — so `set -euo pipefail` on line 65
# was inert inside every stage body, and each stage's `return 1` was swallowed
# by the same rule. Measured on bash 3.2: a failed config push printed "wrote 3
# instance blocks and restarted the agent", verify then reported points from the
# PREVIOUS run, and the script exited 0. The stage whose entire job is proving
# arrival was the one stage that could not report a failure to its caller.
#
# In this form a non-zero return aborts the run, which is what every `FATAL`
# message in this file already assumes.
if run_stage vm;     then stage_vm;     echo ""; fi
if run_stage agent;  then stage_agent;  echo ""; fi
if run_stage config; then stage_config; echo ""; fi
if run_stage verify; then stage_verify; echo ""; fi

echo "done."
