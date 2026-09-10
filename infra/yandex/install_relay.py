#!/usr/bin/env python3
"""Add Kabanda to an existing Storage Relay installation. Dry-run is read-only."""

from __future__ import annotations

import argparse
import base64
import dataclasses
from datetime import datetime, timezone
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
from typing import Callable
import urllib.request


CONFIG = "/etc/kabanda-relay/relay.json"
LEDGER = "/var/lib/storage-relay-kit/kabanda.sqlite3"
PYTHON = "/opt/storage-relay-kit/current/.venv/bin/python"
RELAYCTL = "/opt/storage-relay-kit/current/cli/relayctl.py"
LISTENER = "storage-relay-event-listener.service"
BOOTSTRAP_SERVICE = "storage-relay-bootstrap.service"
BOOTSTRAP_URL = "https://storage.yandexcloud.net/mobile-whitelist-check-d4egfkd20koseppar0cp/transport/v1/apps/kabanda/bootstrap.json"
ORIGIN = "https://kabanda.website.yandexcloud.net"
MAX_REQUEST_BYTES = 262144
ENV_KEYS = {
    "event-listener.env": "STORAGE_RELAY_EVENT_CONFIGS",
    "bootstrap.env": "STORAGE_RELAY_BOOTSTRAP_CONFIGS",
    "maintenance.env": "STORAGE_RELAY_MAINTENANCE_CONFIGS",
}


@dataclasses.dataclass(frozen=True)
class FileState:
    path: Path
    data: bytes | None
    mode: int = 0
    uid: int = 0
    gid: int = 0

    def identity(self) -> dict:
        return {"path": str(self.path), "sha256": None if self.data is None else hashlib.sha256(self.data).hexdigest(),
                "mode": self.mode, "uid": self.uid, "gid": self.gid}


@dataclasses.dataclass(frozen=True)
class Layout:
    base: Path = Path("/etc/encounter-pwa/relay.json")
    env_directory: Path = Path("/etc/storage-relay-kit")
    target: Path = Path(CONFIG)


@dataclasses.dataclass(frozen=True)
class Plan:
    sources: tuple[FileState, ...]
    targets: tuple[FileState, ...]

    @property
    def digest(self) -> str:
        return hashlib.sha256(json.dumps({"sources": [item.identity() for item in self.sources],
                                         "targets": [item.identity() for item in self.targets]}, sort_keys=True).encode()).hexdigest()

    @property
    def changed(self) -> tuple[FileState, ...]:
        old = {item.path: item for item in self.sources}
        return tuple(item for item in self.targets if item != old[item.path])


def capture(path: Path, *, optional: bool = False) -> FileState:
    try:
        info = path.lstat()
    except FileNotFoundError:
        if optional:
            return FileState(path, None)
        raise ValueError("required Relay configuration file is missing") from None
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o007:
        raise ValueError("Relay configuration must be regular and not world-accessible")
    if info.st_size > 1024 * 1024:
        raise ValueError("Relay configuration exceeds 1 MiB")
    return FileState(path, path.read_bytes(), stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)


def append_config(data: bytes, key: str) -> bytes:
    lines = data.decode().splitlines(keepends=True)
    matched = []
    expression = re.compile(rf"^([ \t]*{re.escape(key)}[ \t]*=[ \t]*)(.*?)(\r?\n)?$")
    for index, line in enumerate(lines):
        match = expression.fullmatch(line)
        if match:
            matched.append((index, match))
    if len(matched) != 1:
        raise ValueError("Relay config-list key must occur exactly once")
    index, match = matched[0]
    value = match[2]
    quote = value[0] if value.startswith(("'", '"')) else ""
    if quote:
        if not value.endswith(quote) or len(value) < 2:
            raise ValueError("Relay config-list quoting is invalid")
        value = value[1:-1]
    if not value or re.search(r"[\s'\"\\$`#]", value):
        raise ValueError("Relay config-list must contain literal absolute paths")
    paths = value.split(":")
    if any(not item.startswith("/etc/") or not item.endswith(".json") or ".." in Path(item).parts for item in paths):
        raise ValueError("Relay config-list contains an unsafe path")
    if len(paths) != len(set(paths)):
        raise ValueError("Relay config-list contains duplicates")
    if CONFIG in paths:
        return data
    paths.append(CONFIG)
    lines[index] = f"{match[1]}{quote}{':'.join(paths)}{quote}{match[3] or ''}"
    return "".join(lines).encode()


def prepare(template: Path, service_gid: int, layout: Layout = Layout(), owner_uid: int = 0) -> Plan:
    source = capture(layout.base)
    base = json.loads(source.data)
    candidate = json.loads(template.read_bytes())
    storage = base.get("storage")
    if base.get("version") != 1 or not isinstance(storage, dict) or storage.get("delivery_mode") != "object-trigger":
        raise ValueError("base must be a version1 object-trigger Relay config")
    expected = {"endpoint": "https://storage.yandexcloud.net", "region": "ru-central1",
                "transport_bucket": "mobile-whitelist-transport-d4egfkd20koseppar0cp",
                "public_bucket": "mobile-whitelist-check-d4egfkd20koseppar0cp",
                "credentials_path": "/etc/whitelist-relay/credentials.json"}
    if any(storage.get(key) != value for key, value in expected.items()):
        raise ValueError("base storage identity differs from the verified installation")
    apps = candidate.get("apps", {})
    if candidate.get("version") != 1 or candidate.get("storage") or set(apps) != {"kabanda"} or candidate.get("state_database") != LEDGER:
        raise ValueError("template must isolate Kabanda and leave storage empty")
    app = apps["kabanda"]
    if app.get("backend_base_url") != "http://127.0.0.1:3099" or app.get("public_origins") != [ORIGIN] or app.get("routes") != [{"method": "POST", "path": "/relay/v1/request"}]:
        raise ValueError("Kabanda facade route/origin differs from the reviewed contract")
    candidate["storage"] = {**storage, "max_request_bytes": MAX_REQUEST_BYTES}
    encoded = (json.dumps(candidate, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()
    current = capture(layout.target, optional=True)
    if current.data is not None:
        installed = json.loads(current.data)
        if set(installed.get("apps", {})) != {"kabanda"} or installed.get("state_database") != LEDGER:
            raise ValueError("existing target does not isolate Kabanda")
    sources = [source, current]
    targets = [FileState(layout.target, encoded, 0o640, owner_uid, service_gid)]
    for name, key in ENV_KEYS.items():
        before = capture(layout.env_directory / name)
        sources.append(before)
        targets.append(dataclasses.replace(before, data=append_config(before.data, key)))
    return Plan(tuple(sources), tuple(targets))


def assert_unchanged(states: tuple[FileState, ...]) -> None:
    if any(capture(item.path, optional=item.data is None) != item for item in states):
        raise ValueError("configuration changed since the dry-run; prepare a fresh plan")


def write_atomic(item: FileState) -> None:
    if item.path.parent.is_symlink():
        raise ValueError("configuration parent must not be a symlink")
    if item.data is None:
        item.path.unlink(missing_ok=True)
        return
    descriptor, name = tempfile.mkstemp(prefix=f".{item.path.name}.", dir=item.path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            os.fchmod(handle.fileno(), item.mode)
            os.fchown(handle.fileno(), item.uid, item.gid)
            handle.write(item.data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, item.path)
        directory_fd = os.open(item.path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        Path(name).unlink(missing_ok=True)


def checked_run(arguments: list[str]) -> None:
    result = subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=60)
    if result.returncode:
        raise RuntimeError(f"required command failed: {Path(arguments[0]).name}; output withheld")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        raise ValueError("readiness must not redirect")


def read_json(url: str, limit: int) -> dict:
    with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(url, timeout=15) as response:
        if response.status != 200:
            raise ValueError("readiness returned an unexpected HTTP status")
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("readiness document exceeds its limit")
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError("readiness document must be an object")
    return value


def backend_ready() -> None:
    if read_json("http://127.0.0.1:3099/relay/v1/health", 1024).get("status") != "ok":
        raise ValueError("Kabanda facade is not healthy")


def verify_bootstrap(document: dict, now: datetime | None = None) -> None:
    now = now or datetime.now(timezone.utc)
    upload = document.get("inbox_upload", {})
    if not isinstance(upload, dict):
        raise ValueError("bootstrap upload must be an object")
    fields = upload.get("fields", {})
    if not isinstance(fields, dict):
        raise ValueError("bootstrap upload fields must be an object")
    if document.get("app_id") != "kabanda" or document.get("delivery_mode") != "object-trigger":
        raise ValueError("bootstrap app/delivery identity differs")
    if document.get("outbox_base_url") != "https://storage.yandexcloud.net/mobile-whitelist-check-d4egfkd20koseppar0cp/transport/v1/outbox/kabanda":
        raise ValueError("bootstrap outbox differs")
    if upload.get("url") != "https://storage.yandexcloud.net/mobile-whitelist-transport-d4egfkd20koseppar0cp" or not str(fields.get("key", "")).startswith("transport/v1/inbox/kabanda/"):
        raise ValueError("bootstrap private inbox differs")
    if "wakeup_upload" in document:
        raise ValueError("object-trigger bootstrap must not contain a polling wakeup form")
    try:
        expires = datetime.fromisoformat(str(document.get("expires_at", "")).replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("bootstrap expiry is invalid") from None
    if expires.tzinfo is None or expires <= now:
        raise ValueError("bootstrap expired")
    try:
        policy = json.loads(base64.b64decode(fields.get("policy", ""), validate=True))
        conditions = policy["conditions"]
        if not isinstance(conditions, list):
            raise ValueError()
    except (ValueError, TypeError, KeyError):
        raise ValueError("bootstrap upload policy is invalid") from None
    limits = [condition for condition in conditions if isinstance(condition, list) and condition and condition[0] == "content-length-range"]
    if len(limits) != 1 or len(limits[0]) != 3 or type(limits[0][1]) is not int or type(limits[0][2]) is not int or not 0 <= limits[0][1] < MAX_REQUEST_BYTES or limits[0][2] != MAX_REQUEST_BYTES:
        raise ValueError("bootstrap upload limit differs from the Kabanda envelope limit")


def bootstrap_ready() -> None:
    verify_bootstrap(read_json(BOOTSTRAP_URL, 512 * 1024))


def apply_plan(plan: Plan, backup_root: Path, run: Callable = checked_run,
               probe: Callable = backend_ready, check_bootstrap: Callable = bootstrap_ready) -> Path | None:
    assert_unchanged(plan.sources)
    probe()
    run(["systemctl", "is-active", "--quiet", LISTENER])
    if not plan.changed:
        check_bootstrap()
        return None
    if backup_root.is_symlink():
        raise ValueError("backup root must not be a symlink")
    backup_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if backup_root.stat().st_mode & 0o077:
        raise ValueError("backup root must have mode0700")
    backup = Path(tempfile.mkdtemp(prefix="kabanda-relay-", dir=backup_root))
    previous = {item.path: item for item in plan.sources}
    snapshot = {"version": 1, "planHash": plan.digest,
                "files": [{**previous[item.path].identity(), "dataBase64": None if previous[item.path].data is None else base64.b64encode(previous[item.path].data).decode()} for item in plan.changed]}
    snapshot_file = backup / "rollback.json"
    write_atomic(FileState(snapshot_file, json.dumps(snapshot).encode(), 0o600, os.getuid(), os.getgid()))
    candidate = backup / "candidate.json"
    write_atomic(FileState(candidate, plan.targets[0].data, 0o600, os.getuid(), os.getgid()))
    run([PYTHON, RELAYCTL, "validate", "--config", str(candidate)])
    assert_unchanged(plan.sources)
    target = plan.targets[0]
    if target.path.parent.exists():
        info = target.path.parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o750 or info.st_uid != target.uid or info.st_gid != target.gid:
            raise ValueError("Kabanda Relay directory must have its isolated owner/mode0750")
    else:
        target.path.parent.mkdir(mode=0o750)
        target.path.parent.chmod(0o750)
        os.chown(target.path.parent, target.uid, target.gid)
    touched: list[FileState] = []
    listener_restart_attempted = False
    try:
        for item in plan.changed:
            if capture(item.path, optional=previous[item.path].data is None) != previous[item.path]:
                raise ValueError("configuration changed while applying the plan")
            touched.append(item)
            write_atomic(item)
        run(["runuser", "--user", "whitelist-relay", "--", PYTHON, RELAYCTL, "health", "--config", str(target.path), "--strict-permissions", "--quiet"])
        probe()
        listener_restart_attempted = True
        run(["systemctl", "restart", LISTENER])
        run(["systemctl", "start", BOOTSTRAP_SERVICE])
        run(["systemctl", "is-active", "--quiet", LISTENER])
        check_bootstrap()
    except Exception as original:
        failed = False
        for item in reversed(touched):
            try:
                current = capture(item.path, optional=True)
                if current == previous[item.path]:
                    continue
                if current != item:
                    raise ValueError("concurrent configuration update prevents rollback")
                write_atomic(previous[item.path])
            except Exception:
                failed = True
        if listener_restart_attempted:
            try:
                run(["systemctl", "restart", LISTENER])
            except Exception:
                failed = True
        message = "rollback incomplete" if failed else "configuration rolled back"
        raise RuntimeError(f"{message}; protected snapshot: {snapshot_file}") from original
    return snapshot_file


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--template", type=Path, default=Path(__file__).parent / "templates/relay-config.template.json")
    parser.add_argument("--expected-plan-hash")
    parser.add_argument("--backup-dir", type=Path, default=Path("/var/backups/kabanda/relay"))
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    if args.apply and os.geteuid() != 0:
        raise ValueError("apply must run as root")
    service_gid = grp.getgrnam("whitelist-relay").gr_gid
    plan = prepare(args.template, service_gid)
    report = {"app": "kabanda", "apply": args.apply, "planHash": plan.digest,
              "changedPaths": [str(item.path) for item in plan.changed], "maxRequestBytes": MAX_REQUEST_BYTES}
    if args.apply:
        if args.expected_plan_hash != plan.digest:
            raise ValueError("apply requires the exact current dry-run plan hash")
        descriptor = os.open("/run/lock/storage-relay-config.lock", os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            snapshot = apply_plan(plan, args.backup_dir)
            report["snapshot"] = str(snapshot) if snapshot else None
        finally:
            os.close(descriptor)
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
    except Exception as error:
        print(f"Relay setup failed: {type(error).__name__}; details withheld", file=sys.stderr)
        raise SystemExit(1)
