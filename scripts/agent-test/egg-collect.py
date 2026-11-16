# Runs ON a dev egg (piped over SSH: `ssh gremlinz-dev@IP sudo -n python3 - <hours>`), prints one JSON object.
# Reads the gremlin's files and the server's security state. Never prints secrets: hosting.json is reduced to a
# whitelist (its hosting key and shards stay on the egg), and the seed, keys and configs are never opened.
#   argv: [hours of ledger/actions to keep (default 48)] [GREMLIN_HOME] [HERMES_HOME]   (paths: for local tests)
import glob
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone

HOURS = float(sys.argv[1]) if len(sys.argv) > 1 else 48.0
HOME = sys.argv[2] if len(sys.argv) > 2 else "/var/lib/gremlin"
HERMES = sys.argv[3] if len(sys.argv) > 3 else "/var/lib/gremlin-hermes"
WAKE_JOB = "a0a0a0a0a0a1"
DEV_KEYS = "/etc/ssh/gremlinz_dev_keys"
SINCE = time.time() - HOURS * 3600


def run(cmd, timeout=60):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except Exception as e:  # missing binary, timeout
        return None, "", str(e)


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def ts(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def jsonl(path, recent=False, last=None, keep=None):
    out = []
    try:
        with open(path) as f:
            for line in f:
                if not line.startswith("{"):
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if recent:
                    t = ts(o.get("at"))
                    if t is None or t < SINCE:
                        continue
                if keep:
                    o = {k: o[k] for k in keep if k in o}
                out.append(o)
    except Exception:
        return []
    return out[-last:] if last else out


def hosting():
    h = read_json(os.path.join(HOME, "hosting.json"))
    if not isinstance(h, dict):
        return {"present": False}
    # Whitelist: everything else in this file (hostingKey, shards) is the gremlin's own key and stays here.
    cleanups = [{k: c.get(k) for k in ("at", "ok", "summary", "errors") if k in c} for c in (h.get("cleanups") or [])][-20:]
    return {
        "present": True,
        "provider": h.get("provider"),
        "vmId": h.get("vmId"),
        "address": h.get("address") or h.get("hostingAddress"),
        "receivedAt": h.get("receivedAt"),
        "nextCleanupAt": h.get("nextCleanupAt"),
        "keepVmIds": h.get("keepVmIds"),
        "cleanups": cleanups,
    }


def egg_state():
    s = read_json(os.path.join(HOME, "state.json"))
    if not isinstance(s, dict):
        return None
    return {k: s.get(k) for k in ("stage", "bootedAt", "pulseSeq", "lastPulseAt")} | {"log": (s.get("log") or [])[-20:]}


def cron():
    out = {}
    jobs = read_json(os.path.join(HERMES, "cron", "jobs.json"))
    if isinstance(jobs, dict):
        j = next((x for x in jobs.get("jobs") or [] if x.get("id") == WAKE_JOB), None)
        if j:
            out["job"] = {k: j.get(k) for k in ("last_status", "last_run_at", "next_run_at", "failure_streak", "enabled")}
            out["job"]["last_error"] = (j.get("last_error") or "")[:300] or None
    code, so, se = run(["docker", "exec", "-u", "gremlin", "-e", "HERMES_HOME=" + HERMES, "egg",
                        "/opt/hermes/venv/bin/hermes", "cron", "runs", WAKE_JOB, "--limit", "200"], timeout=90)
    if code == 0:
        out["runsText"] = so[-200_000:]
    else:
        out["error"] = (se or so or "hermes cron runs failed").strip()[:300]
    return out


def sshd_settings():
    code, so, se = run(["sshd", "-T", "-C", "user=gremlinz-dev,host=probe,addr=127.0.0.1"])
    if code != 0:
        code, so, se = run(["sshd", "-T"])
    want = ("authorizedkeysfile", "authorizedkeyscommand", "allowusers", "passwordauthentication", "permitrootlogin",
            "kbdinteractiveauthentication", "pubkeyauthentication")
    out = {}
    for line in so.splitlines():
        k, _, v = line.partition(" ")
        if k in want:
            out[k] = v.strip()
    return out


def key_lines(path):
    try:
        with open(path) as f:
            return [l.strip() for l in f if l.strip() and not l.strip().startswith("#")]
    except Exception:
        return []


def dev_keys():
    out = []
    for line in key_lines(DEV_KEYS):
        parts = line.split()
        fp = None
        try:
            p = subprocess.run(["ssh-keygen", "-lf", "/dev/stdin"], input=line + "\n", capture_output=True, text=True, timeout=10)
            fp = p.stdout.split()[1] if p.returncode == 0 and p.stdout.split() else None
        except Exception:
            pass
        out.append({"type": parts[0] if parts else "?", "comment": " ".join(parts[2:]) if len(parts) > 2 else "", "fingerprint": fp})
    return out


def security():
    files = set()
    for pat in ("/root/.ssh/authorized_keys*", "/home/*/.ssh/authorized_keys*", "/etc/ssh/*authorized_keys*", DEV_KEYS):
        files.update(glob.glob(pat))
    out = {
        "authorizedKeysFiles": [{"path": p, "keys": len(key_lines(p))} for p in sorted(files)],
        "sshd": sshd_settings(),
        "devKeys": dev_keys(),
        "cloudInitDisabled": os.path.exists("/etc/cloud/cloud-init.disabled"),
    }
    code, so, _ = run(["systemctl", "is-active", "gremlin-lockdown.service"])
    out["lockdown"] = so.strip() or None
    code, so, se = run(["apt-get", "-s", "-o", "Debug::NoLocking=1", "upgrade"], timeout=120)
    if code == 0:
        out["osSecurityPending"] = sum(1 for l in so.splitlines() if l.startswith("Inst ") and re.search(r"-security\b", l))
    else:
        out["osSecurityPending"] = None
        out["aptError"] = (se or "apt-get failed").strip()[:200]
    return out


def container():
    out = {}
    code, so, _ = run(["docker", "inspect", "-f", "{{.State.Status}}|{{.State.StartedAt}}|{{.Config.Image}}", "egg"])
    if code == 0 and so.strip():
        st, started, image = (so.strip().split("|") + ["", "", ""])[:3]
        out.update({"egg": st, "startedAt": started, "image": image})
    else:
        out["egg"] = "missing"
    code, so, _ = run(["systemctl", "is-active", "gremlin.service"])
    out["gremlinService"] = so.strip() or None
    try:
        with open("/proc/uptime") as f:
            out["uptimeHours"] = round(float(f.read().split()[0]) / 3600, 2)
    except Exception:
        pass
    return out


f = os.path.join
result = {
    "collectedAt": datetime.now(timezone.utc).isoformat(),
    "files": {
        "health": read_json(f(HOME, "health.json")),
        "status": read_json(f(HOME, "status.json")),
        "state": egg_state(),
        "hosting": hosting(),
        "ledger": jsonl(f(HOME, "inference-ledger.jsonl"), recent=True,
                        keep=("at", "alias", "provider", "model", "status", "usd", "priced", "refused", "incomplete", "ms")),
        "actions": jsonl(f(HOME, "health-actions.jsonl"), last=300),
        "issues": jsonl(f(HOME, "issues.jsonl"), last=100),
        "earnings": None,
    },
    "cron": cron(),
    "security": security(),
    "container": container(),
}
# earnings.jsonl is an event log folded by id (health/stores.ts earnings()): later fields win.
folded = {}
for e in jsonl(f(HOME, "earnings.jsonl")):
    i = e.get("id")
    if not i:
        continue
    if i not in folded:
        if e.get("what") and e.get("status"):
            folded[i] = dict(e)
        continue
    folded[i].update({k: v for k, v in e.items() if v is not None and k not in ("at", "note")})
result["files"]["earnings"] = [{k: v for k, v in e.items() if k in ("id", "what", "amountUsd", "counterparty", "status", "at")} for e in folded.values()]
print(json.dumps(result))
