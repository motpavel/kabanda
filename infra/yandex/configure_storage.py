#!/usr/bin/env python3
"""Merge only Kabanda CORS/lifecycle rules. Default mode reads cloud state without writes."""

from __future__ import annotations

import argparse
import copy
import dataclasses
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sys
from typing import Any

import publish_static as static


PUBLIC = "mobile-whitelist-check-d4egfkd20koseppar0cp"
PRIVATE = "mobile-whitelist-transport-d4egfkd20koseppar0cp"
TEMPLATES = Path(__file__).parent / "templates"
SPECIFICATIONS = (
    (PUBLIC, "cors", "public-bucket-cors.json", "kabanda-public-read-v1", None),
    (PRIVATE, "cors", "transport-bucket-cors.json", "kabanda-private-transport-v1", None),
    (static.BUCKET, "cors", "static-bucket-cors.json", "kabanda-static-read-v1", None),
    (PUBLIC, "lifecycle", "public-bucket-lifecycle-rule.json", "kabanda-outbox-expiration-v1", "transport/v1/outbox/kabanda/"),
    (PRIVATE, "lifecycle", "private-blob-lifecycle-rule.json", "kabanda-private-blob-expiration-v1", "transport/v1/blobs/kabanda/"),
)
MISSING = {"NoSuchCORSConfiguration", "NoSuchLifecycleConfiguration"}


def canonical(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: canonical(item) for key, item in sorted(value.items())}
    if isinstance(value, list):
        return sorted((canonical(item) for item in value), key=lambda item: json.dumps(item, sort_keys=True))
    return value


def same(left: Any, right: Any) -> bool:
    return canonical(left) == canonical(right)


@dataclasses.dataclass(frozen=True)
class Change:
    bucket: str
    kind: str
    before: dict | None
    after: dict

    @property
    def changed(self) -> bool:
        return not same(self.before, self.after)


def read_policy(client: Any, bucket: str, kind: str) -> dict | None:
    method = client.get_bucket_cors if kind == "cors" else client.get_bucket_lifecycle_configuration
    try:
        result = method(Bucket=bucket)
    except Exception as error:
        if static.error_code(error) in MISSING:
            return None
        raise
    result = {key: value for key, value in result.items() if key != "ResponseMetadata"}
    expected_key = "CORSRules" if kind == "cors" else "Rules"
    if set(result) != {expected_key} or not isinstance(result[expected_key], list):
        raise ValueError("existing policy contains unsupported fields; preserve and review them manually")
    return result


def merge_rule(before: dict | None, rule: dict, kind: str, identifier: str, prefix: str | None) -> dict:
    collection = "CORSRules" if kind == "cors" else "Rules"
    if rule.get("ID") != identifier:
        raise ValueError("template does not use its exact Kabanda rule ID")
    if kind == "cors":
        if rule.get("AllowedOrigins") != [static.ORIGIN]:
            raise ValueError("Kabanda CORS must use only the reviewed app origin")
        expected_methods = {"GET", "HEAD", "POST", "PUT"} if identifier == "kabanda-private-transport-v1" else {"GET", "HEAD"}
        if set(rule.get("AllowedMethods", [])) != expected_methods:
            raise ValueError("Kabanda CORS methods differ from the reviewed transport")
    elif rule.get("Filter") != {"Prefix": prefix} or rule.get("Status") != "Enabled" or rule.get("Expiration") != {"Days": 1} or set(rule) != {"ID", "Filter", "Status", "Expiration"}:
        raise ValueError("Kabanda lifecycle must expire only its exact temporary prefix after1 day")
    after = copy.deepcopy(before) if before else {collection: []}
    rules = after[collection]
    matches = [index for index, existing in enumerate(rules) if existing.get("ID") == identifier]
    if len(matches) > 1:
        raise ValueError("managed Kabanda rule ID is duplicated")
    if matches:
        old = rules[matches[0]]
        if kind == "cors" and old.get("AllowedOrigins") != [static.ORIGIN] or kind == "lifecycle" and old.get("Filter") != {"Prefix": prefix}:
            raise ValueError("existing managed ID points outside the Kabanda app scope")
        rules[matches[0]] = copy.deepcopy(rule)
    else:
        rules.append(copy.deepcopy(rule))
    return after


def prepare(client: Any, include_static: bool = False) -> tuple[Change, ...]:
    plan = []
    for bucket, kind, filename, identifier, prefix in SPECIFICATIONS:
        if bucket == static.BUCKET and not include_static:
            continue
        template = json.loads((TEMPLATES / filename).read_bytes())
        if kind == "cors":
            if set(template) != {"CORSRules"} or len(template["CORSRules"]) != 1:
                raise ValueError("CORS template must contain exactly one Kabanda rule")
            template = template["CORSRules"][0]
        before = read_policy(client, bucket, kind)
        plan.append(Change(bucket, kind, before, merge_rule(before, template, kind, identifier, prefix)))
    return tuple(plan)


def digest(plan: tuple[Change, ...]) -> str:
    return hashlib.sha256(json.dumps(canonical([dataclasses.asdict(item) for item in plan]), sort_keys=True).encode()).hexdigest()


def write_policy(client: Any, change: Change, value: dict | None) -> None:
    if value is None:
        method = client.delete_bucket_cors if change.kind == "cors" else client.delete_bucket_lifecycle
        method(Bucket=change.bucket)
    elif change.kind == "cors":
        client.put_bucket_cors(Bucket=change.bucket, CORSConfiguration=value)
    else:
        client.put_bucket_lifecycle_configuration(Bucket=change.bucket, LifecycleConfiguration=value)


def assert_current(client: Any, plan: tuple[Change, ...]) -> None:
    if any(not same(read_policy(client, item.bucket, item.kind), item.before) for item in plan):
        raise ValueError("storage policy changed since dry-run; prepare a fresh plan")


def apply_plan(client: Any, plan: tuple[Change, ...], backup_directory: Path) -> Path | None:
    assert_current(client, plan)
    changes = [item for item in plan if item.changed]
    if not changes:
        return None
    snapshot = static.safe_snapshot(backup_directory, {"version": 1, "planHash": digest(plan),
                                                      "changes": [dataclasses.asdict(item) for item in changes]})
    assert_current(client, plan)
    touched = []
    try:
        for item in changes:
            if not same(read_policy(client, item.bucket, item.kind), item.before):
                raise ValueError("storage policy changed during apply")
            touched.append(item)  # A lost acknowledgement can follow a successful PUT.
            write_policy(client, item, item.after)
            if not same(read_policy(client, item.bucket, item.kind), item.after):
                raise ValueError("storage policy failed readback verification")
    except Exception as original:
        failed = False
        for item in reversed(touched):
            try:
                current = read_policy(client, item.bucket, item.kind)
                if same(current, item.before):
                    continue
                if not same(current, item.after):
                    raise ValueError("concurrent policy update prevents rollback")
                write_policy(client, item, item.before)
                if not same(read_policy(client, item.bucket, item.kind), item.before):
                    raise ValueError("storage policy rollback failed verification")
            except Exception:
                failed = True
        message = "policy rollback incomplete" if failed else "storage policies rolled back"
        raise RuntimeError(f"{message}; protected snapshot: {snapshot}") from original
    return snapshot


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials", type=Path, required=True)
    parser.add_argument("--expected-plan-hash")
    parser.add_argument("--snapshot-dir", type=Path, default=Path("/var/backups/kabanda/storage-policies"))
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--include-static", action="store_true", help="also configure the separately created and verified Kabanda static bucket")
    args = parser.parse_args(argv)
    client = static.s3_client(args.credentials)
    plan = prepare(client, args.include_static)
    report = {"apply": args.apply, "planHash": digest(plan),
              "changedPolicies": [{"bucket": item.bucket, "kind": item.kind} for item in plan if item.changed]}
    if args.apply:
        if args.expected_plan_hash != digest(plan):
            raise ValueError("apply requires the exact current dry-run plan hash")
        descriptor = os.open("/run/lock/storage-relay-storage.lock", os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            snapshot = apply_plan(client, plan, args.snapshot_dir)
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
        print(f"storage policy setup failed: {static.error_code(error)}", file=sys.stderr)
        raise SystemExit(1)
