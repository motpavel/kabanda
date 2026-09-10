#!/usr/bin/env python3
"""Publish only Kabanda's public Vite build. Default mode is entirely local."""

from __future__ import annotations

import argparse
import base64
import dataclasses
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
from typing import Any
from urllib.parse import urljoin, urlsplit


BUCKET = "kabanda"
ORIGIN = "https://kabanda.website.yandexcloud.net"
NO_STORE = "no-store"
IMMUTABLE = "public, max-age=31536000, immutable"
ROOT_FILES = {
    "index.html", "manifest.webmanifest", "gps-lab.webmanifest", "sw.js", "registerSW.js",
    "icon.svg", "apple-touch-icon.png", "pwa-192x192.png", "pwa-512x512.png",
    "kabanda-bike-192.png", "kabanda-bike-512.png", "kabanda-bike-apple-180.png",
    "kabanda-bike-maskable-512.png",
}
MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".webmanifest": "application/manifest+json",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
    ".wasm": "application/wasm", ".woff": "font/woff", ".woff2": "font/woff2",
    ".ttf": "font/ttf",
}
HASHED = re.compile(r"[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$")
WEBSITE = {"IndexDocument": {"Suffix": "index.html"}, "ErrorDocument": {"Key": "index.html"}}
MISSING = {"NoSuchKey", "NotFound", "404", "NoSuchWebsiteConfiguration"}
RESTORE_HEADERS = ("ContentType", "CacheControl", "ContentDisposition", "ContentEncoding", "ContentLanguage", "Metadata")
ACCOUNT_ANCHORS = {"mobile-whitelist-check-d4egfkd20koseppar0cp", "mobile-whitelist-transport-d4egfkd20koseppar0cp"}
ENDPOINT = "https://storage.yandexcloud.net"
REGION = "ru-central1"
VERIFIED_FOLDER = "b1gep85v7qqh3r08v1v4"


@dataclasses.dataclass(frozen=True)
class PublicObject:
    key: str
    body: bytes
    content_type: str
    cache_control: str

    @property
    def digest(self) -> str:
        return hashlib.sha256(self.body).hexdigest()

    @property
    def immutable(self) -> bool:
        return self.cache_control == IMMUTABLE


class References(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.manifests: list[str] = []
        self.scripts: list[str] = []
        self.resources: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "link" and values.get("rel") == "manifest":
            self.manifests.append(values.get("href") or "")
        if tag == "script" and values.get("src"):
            self.scripts.append(values["src"] or "")
        if tag in {"script", "link"}:
            source = values.get("src") or values.get("href")
            if source:
                self.resources.append(source)


def local_reference(source: str, document: str) -> str:
    target = urlsplit(urljoin(f"{ORIGIN}/{document}", source))
    if target.scheme != "https" or target.netloc != urlsplit(ORIGIN).netloc or target.query or target.fragment:
        raise ValueError("build contains an external or decorated static reference")
    return target.path.lstrip("/")


def allowed_file(key: str, release_sha: str) -> bool:
    if key in ROOT_FILES or key in {"lab/index.html", "lab/manifest.webmanifest"}:
        return True
    if key == f"sw-build-{release_sha[:12]}.js" or re.fullmatch(r"workbox-[A-Za-z0-9_-]{6,}\.js", key):
        return True
    if key.startswith("assets/"):
        return bool(HASHED.fullmatch(key.removeprefix("assets/"))) and Path(key).suffix in MIME
    return bool(re.fullmatch(r"brand/[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\.(png|jpe?g|webp|svg)", key))


def prepare(directory: Path, release_sha: str, bucket: str = BUCKET) -> list[PublicObject]:
    if bucket != BUCKET:
        raise ValueError("publisher is restricted to bucket kabanda")
    if not re.fullmatch(r"[a-f0-9]{40}", release_sha):
        raise ValueError("release SHA must be exactly 40 lowercase hex characters")
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("dist must be a real directory")
    files: dict[str, bytes] = {}
    total = 0
    for path in sorted(directory.rglob("*")):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ValueError("dist contains a symlink")
        if stat.S_ISDIR(info.st_mode):
            continue
        key = path.relative_to(directory).as_posix()
        if not stat.S_ISREG(info.st_mode) or not allowed_file(key, release_sha):
            raise ValueError(f"unexpected public build file: {key}")
        if info.st_size > 32 * 1024 * 1024:
            raise ValueError("single static file exceeds 32 MiB")
        raw = path.read_bytes()
        total += len(raw)
        if len(files) >= 1000 or total > 128 * 1024 * 1024:
            raise ValueError("static build exceeds bounded publication limits")
        files[key] = raw
    required = {"index.html", "manifest.webmanifest", "sw.js", "lab/index.html", "lab/manifest.webmanifest", f"sw-build-{release_sha[:12]}.js"}
    if required - files.keys():
        raise ValueError("build is missing required app/lab/SW metadata")
    marker = f"sw-build-{release_sha[:12]}.js"
    if marker not in files["sw.js"].decode() or f'build:{json.dumps(release_sha[:12])}' not in files[marker].decode():
        raise ValueError("service worker does not identify the requested build")
    for document, manifest_name in (("index.html", "manifest.webmanifest"), ("lab/index.html", "lab/manifest.webmanifest")):
        parser = References()
        parser.feed(files[document].decode())
        if len(parser.manifests) != 1 or local_reference(parser.manifests[0], document) != manifest_name:
            raise ValueError("HTML must contain exactly its own installation manifest")
        if not parser.scripts or not all(local_reference(source, document).startswith("assets/") for source in parser.scripts):
            raise ValueError("HTML must load built assets rather than development scripts")
        if any(local_reference(source, document) not in files for source in parser.resources):
            raise ValueError("HTML references a missing static resource")
        manifest = json.loads(files[manifest_name])
        expected_start = "app" if document == "index.html" else "lab/index.html"
        expected_scope = "" if document == "index.html" else "lab/"
        if local_reference(manifest.get("start_url", ""), manifest_name) != expected_start:
            raise ValueError("manifest start_url does not match its app")
        if local_reference(manifest.get("scope", ""), manifest_name) != expected_scope:
            raise ValueError("manifest scope does not match its app")
        if document == "lab/index.html" and local_reference(manifest.get("id", ""), manifest_name) != "lab/":
            raise ValueError("lab manifest must keep its separate installation identity")
        if not manifest.get("icons") or any(local_reference(icon.get("src", ""), manifest_name) not in files for icon in manifest["icons"]):
            raise ValueError("manifest references missing icons")
    objects = []
    for key, body in files.items():
        immutable = key.startswith("assets/") or key == marker or key.startswith("workbox-")
        no_store = Path(key).suffix in {".html", ".webmanifest"} or key in {"sw.js", "registerSW.js"}
        objects.append(PublicObject(key, body, MIME[Path(key).suffix], IMMUTABLE if immutable else NO_STORE if no_store else "no-cache"))
    for key, document in {"app": "index.html", "app/": "index.html", "lab": "lab/index.html", "lab/": "lab/index.html"}.items():
        objects.append(PublicObject(key, files[document], MIME[".html"], NO_STORE))
    # All hashed assets precede mutable metadata; both canonical entry shells are last.
    entries = {"index.html", "app", "app/", "lab/index.html", "lab", "lab/"}
    return sorted(objects, key=lambda item: (0 if item.immutable else 2 if item.key in entries else 1, item.key))


def error_code(error: BaseException) -> str:
    return str(getattr(error, "response", {}).get("Error", {}).get("Code", type(error).__name__))


def get_object(client: Any, key: str) -> dict[str, Any] | None:
    try:
        result = client.get_object(Bucket=BUCKET, Key=key)
    except Exception as error:
        if error_code(error) in MISSING:
            return None
        raise
    try:
        body = result["Body"].read(32 * 1024 * 1024 + 1)
    finally:
        result["Body"].close()
    if len(body) > 32 * 1024 * 1024:
        raise ValueError("existing static object exceeds snapshot limit")
    return {"body": body, "headers": {name: result[name] for name in RESTORE_HEADERS if name in result}}


def same_object(value: dict[str, Any] | None, item: PublicObject) -> bool:
    return value is not None and value["body"] == item.body and value["headers"].get("ContentType") == item.content_type and value["headers"].get("CacheControl") == item.cache_control


def verify_public_read(client: Any, key: str) -> None:
    policy = client.get_object_acl(Bucket=BUCKET, Key=key)
    public = [grant for grant in policy["Grants"] if grant["Grantee"].get("URI") == "http://acs.amazonaws.com/groups/global/AllUsers"]
    if len(public) != 1 or public[0]["Permission"] != "READ":
        raise ValueError("static object must grant public read only")
    if any(grant["Grantee"].get("URI", "").startswith("http://acs.amazonaws.com/groups/") and grant["Permission"] != "READ" for grant in policy["Grants"]):
        raise ValueError("static object grants a public write permission")


def website_state(client: Any) -> dict[str, Any] | None:
    try:
        result = client.get_bucket_website(Bucket=BUCKET)
    except Exception as error:
        if error_code(error) in MISSING:
            return None
        raise
    return {key: value for key, value in result.items() if key != "ResponseMetadata"}


def safe_snapshot(directory: Path, payload: dict[str, Any]) -> Path:
    if directory.exists() and (directory.is_symlink() or not directory.is_dir()):
        raise ValueError("snapshot directory must be real")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.stat().st_mode & 0o077:
        raise ValueError("snapshot directory must have mode 0700")
    descriptor, name = tempfile.mkstemp(prefix="kabanda-static-", suffix=".json", dir=directory)
    with os.fdopen(descriptor, "w") as handle:
        json.dump(payload, handle, ensure_ascii=False)
        handle.flush()
        os.fsync(handle.fileno())
    return Path(name)


def account_inventory(client: Any) -> dict[str, Any]:
    """ListBuckets is an authenticated account operation, never ListObjects."""
    result = client.list_buckets()
    if result.get("ContinuationToken") or result.get("NextContinuationToken") or result.get("IsTruncated"):
        raise ValueError("account inventory is incomplete")
    buckets = {}
    for item in result.get("Buckets", []):
        name, created = item.get("Name"), item.get("CreationDate")
        if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", name) or name in buckets:
            raise ValueError("account inventory contains an invalid bucket identity")
        if not isinstance(created, datetime) or created.tzinfo is None:
            raise ValueError("account inventory has no verified creation timestamp")
        buckets[name] = created.astimezone(timezone.utc).isoformat()
    if not ACCOUNT_ANCHORS.issubset(buckets):
        raise ValueError("authenticated account inventory lacks the verified Kabanda migration anchors")
    owner = result.get("Owner", {}).get("ID", "")
    if not isinstance(owner, str):
        raise ValueError("account owner identity is malformed")
    return {"ownerId": owner, "buckets": buckets}


def create_account_baseline(client: Any, credential_fingerprint: str, destination: Path) -> str:
    inventory = account_inventory(client)
    if destination.parent.is_symlink() or not destination.parent.is_dir() or destination.parent.stat().st_mode & 0o077:
        raise ValueError("account baseline requires an existing private directory")
    document = {"version": 1, "endpoint": ENDPOINT, "region": REGION,
                "credentialKeyIdSha256": credential_fingerprint,
                "capturedAt": datetime.now(timezone.utc).isoformat(), **inventory}
    encoded = (json.dumps(document, sort_keys=True, indent=2) + "\n").encode()
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())
    return hashlib.sha256(encoded).hexdigest()


def read_private_json(path: Path) -> dict[str, Any]:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid not in {0, os.getuid()} or info.st_size > 1024 * 1024:
        raise ValueError("private input must be an operator-owned regular mode0600 file, at most1MiB")
    value = json.loads(path.read_bytes())
    if not isinstance(value, dict):
        raise ValueError("private input must be an object")
    return value


def credential_identity(credentials: Path) -> str:
    values = read_private_json(credentials)
    key = values.get("key_id")
    if not isinstance(key, str) or not key:
        raise ValueError("credentials file has no key identity")
    return hashlib.sha256(key.encode()).hexdigest()


def verify_account_baseline(client: Any, path: Path, credential_fingerprint: str, acl_owner: str) -> None:
    baseline = read_private_json(path)
    if baseline.get("version") != 1 or baseline.get("endpoint") != ENDPOINT or baseline.get("region") != REGION or not re.fullmatch(r"[a-f0-9]{64}", credential_fingerprint) or baseline.get("credentialKeyIdSha256") != credential_fingerprint:
        raise ValueError("account baseline does not match the authenticated credential and Yandex endpoint")
    expected = baseline.get("buckets", {})
    if not isinstance(expected, dict) or not ACCOUNT_ANCHORS.issubset(expected):
        raise ValueError("account baseline lacks verified migration anchors")
    inventory = account_inventory(client)
    if baseline.get("ownerId") != inventory["ownerId"] or acl_owner and acl_owner != inventory["ownerId"]:
        raise ValueError("bucket owner does not match the account baseline")
    if BUCKET not in inventory["buckets"] or any(inventory["buckets"].get(name) != created for name, created in expected.items()):
        raise ValueError("kabanda is not owned by the authenticated baseline account, or the baseline changed")
    if BUCKET not in expected:
        try:
            captured = datetime.fromisoformat(baseline["capturedAt"])
            created = datetime.fromisoformat(inventory["buckets"][BUCKET])
            if captured.tzinfo is None or created < captured - timedelta(minutes=5) or created > datetime.now(timezone.utc) + timedelta(minutes=5):
                raise ValueError()
        except (ValueError, TypeError, KeyError):
            raise ValueError("new Kabanda bucket creation does not match the pre-creation account baseline") from None


def verify_console_ownership(client: Any, path: Path, credential_fingerprint: str, acl_owner: str) -> None:
    """Consume an operator's fresh control-plane attestation; never invent one."""
    proof = read_private_json(path)
    expected = {"version": 1, "verificationMethod": "yandex-console", "bucket": BUCKET,
                "folderId": VERIFIED_FOLDER, "endpoint": ENDPOINT, "region": REGION,
                "credentialKeyIdSha256": credential_fingerprint, "aclOwnerId": acl_owner}
    if not re.fullmatch(r"[a-f0-9]{64}", credential_fingerprint) or any(proof.get(key) != value for key, value in expected.items()):
        raise ValueError("console ownership proof does not match the verified folder, bucket and authenticated credential")
    resource = urlsplit(str(proof.get("resourceUrl", "")))
    prefix = f"/folders/{VERIFIED_FOLDER}/storage/buckets/{BUCKET}"
    if resource.scheme != "https" or resource.netloc != "console.yandex.cloud" or resource.query or resource.fragment or resource.path not in {prefix, prefix + "/", prefix + "/objects", prefix + "/settings"}:
        raise ValueError("console ownership proof has no exact reviewed bucket resource URL")
    try:
        created, verified = (datetime.fromisoformat(str(proof[key]).replace("Z", "+00:00")) for key in ("createdAt", "verifiedAt"))
        now = datetime.now(timezone.utc)
        if created.tzinfo is None or verified.tzinfo is None or created > verified + timedelta(minutes=5) or verified > now + timedelta(minutes=5) or verified < now - timedelta(hours=24):
            raise ValueError()
    except (ValueError, TypeError, KeyError):
        raise ValueError("console ownership proof must be a fresh UTC verification within24 hours") from None
    head = client.head_bucket(Bucket=BUCKET)
    if head.get("ResponseMetadata", {}).get("HTTPStatusCode") != 200:
        raise ValueError("authenticated Kabanda bucket access is not confirmed")


def publish(client: Any, objects: list[PublicObject], release_sha: str, snapshot_directory: Path,
            expected_owner: str | None = None, account_baseline: Path | None = None, credential_fingerprint: str | None = None,
            console_ownership_proof: Path | None = None) -> Path:
    acl = client.get_bucket_acl(Bucket=BUCKET)
    owner = acl.get("Owner", {}).get("ID", "")
    if sum(map(bool, (expected_owner, account_baseline, console_ownership_proof))) != 1:
        raise ValueError("bucket ownership requires exactly one verified owner ID, authenticated account baseline or console ownership proof")
    if expected_owner:
        if owner != expected_owner:
            raise ValueError("bucket owner differs from the verified account")
    elif account_baseline and credential_fingerprint:
        verify_account_baseline(client, account_baseline, credential_fingerprint, owner)
    elif console_ownership_proof and credential_fingerprint:
        verify_console_ownership(client, console_ownership_proof, credential_fingerprint, owner)
    else:
        raise ValueError("bucket ownership requires a verified owner ID or authenticated account baseline")
    if any(grant["Grantee"].get("URI") in {"http://acs.amazonaws.com/groups/global/AllUsers", "http://acs.amazonaws.com/groups/global/AuthenticatedUsers"} for grant in acl["Grants"]):
        raise ValueError("bucket must not grant public listing or writing")
    previous_website = website_state(client)
    if previous_website and previous_website != WEBSITE:
        raise ValueError("existing website configuration is not managed by Kabanda")
    previous: dict[str, dict[str, Any] | None] = {}
    previous_acls: dict[str, Any] = {}
    for item in objects:
        existing = get_object(client, item.key)
        if item.immutable and existing is not None:
            if not same_object(existing, item):
                raise ValueError("immutable asset already exists with different bytes or headers")
            verify_public_read(client, item.key)
        if not item.immutable:
            previous[item.key] = existing
            if existing is not None:
                previous_acls[item.key] = client.get_object_acl(Bucket=BUCKET, Key=item.key)
    snapshot = safe_snapshot(snapshot_directory, {
        "schemaVersion": 1, "bucket": BUCKET, "releaseSha": release_sha,
        "website": previous_website,
        "objects": {key: None if value is None else {"bodyBase64": base64.b64encode(value["body"]).decode(), "headers": value["headers"], "acl": {part: previous_acls[key][part] for part in ("Owner", "Grants")}} for key, value in previous.items()},
        "candidate": {item.key: {"sha256": item.digest, "contentType": item.content_type, "cacheControl": item.cache_control} for item in objects if not item.immutable},
    })
    touched: list[PublicObject] = []
    website_touched = False
    try:
        for item in objects:
            if item.immutable:
                current = get_object(client, item.key)
                if current is not None:
                    if not same_object(current, item):
                        raise ValueError("immutable asset changed during publication")
                    verify_public_read(client, item.key)
                    continue
            if not item.immutable:
                if get_object(client, item.key) != previous[item.key]:
                    raise ValueError("mutable object changed after the snapshot")
                touched.append(item)  # A timed-out write may already have succeeded.
            client.put_object(Bucket=BUCKET, Key=item.key, Body=item.body, ContentType=item.content_type,
                              CacheControl=item.cache_control, ACL="public-read",
                              Metadata={"kabanda-sha256": item.digest, "kabanda-release": release_sha})
            if not same_object(get_object(client, item.key), item):
                raise ValueError("uploaded object failed readback verification")
            verify_public_read(client, item.key)
        website_touched = True
        client.put_bucket_website(Bucket=BUCKET, WebsiteConfiguration=WEBSITE)
        if website_state(client) != WEBSITE:
            raise ValueError("website configuration failed verification")
    except Exception as original:
        failed = False
        for item in reversed(touched):
            try:
                current = get_object(client, item.key)
                old = previous[item.key]
                if current == old:
                    continue
                if current is not None and (current["body"] != item.body or current["headers"].get("Metadata", {}).get("kabanda-release") != release_sha):
                    raise ValueError("concurrent object update prevents rollback")
                if old is None:
                    client.delete_object(Bucket=BUCKET, Key=item.key)
                else:
                    client.put_object(Bucket=BUCKET, Key=item.key, Body=old["body"], **old["headers"])
                    policy = {part: previous_acls[item.key][part] for part in ("Owner", "Grants")}
                    client.put_object_acl(Bucket=BUCKET, Key=item.key, AccessControlPolicy=policy)
                if get_object(client, item.key) != old:
                    raise ValueError("object rollback failed verification")
            except Exception:
                failed = True
        if website_touched:
            try:
                current = website_state(client)
                if current not in (previous_website, WEBSITE):
                    raise ValueError("concurrent website update prevents rollback")
                if previous_website is None:
                    client.delete_bucket_website(Bucket=BUCKET)
                else:
                    client.put_bucket_website(Bucket=BUCKET, WebsiteConfiguration=previous_website)
            except Exception:
                failed = True
        if failed:
            raise RuntimeError(f"rollback incomplete; protected snapshot: {snapshot}") from original
        raise RuntimeError(f"publication rolled back; protected snapshot: {snapshot}") from original
    return snapshot


def s3_client(credentials: Path) -> Any:
    values = read_private_json(credentials)
    if not isinstance(values, dict) or not values.get("key_id") or not values.get("secret"):
        raise ValueError("credentials file is incomplete")
    import boto3
    from botocore.config import Config
    return boto3.client("s3", endpoint_url=ENDPOINT, region_name=REGION,
                        aws_access_key_id=values["key_id"], aws_secret_access_key=values["secret"],
                        config=Config(signature_version="s3v4", s3={"addressing_style": "path"},
                                      retries={"max_attempts": 3, "mode": "standard"}, connect_timeout=5, read_timeout=30))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--release-sha")
    parser.add_argument("--bucket", default=BUCKET)
    parser.add_argument("--credentials", type=Path)
    parser.add_argument("--expected-owner-id")
    parser.add_argument("--account-baseline", type=Path)
    parser.add_argument("--console-ownership-proof", type=Path,
                        help="private fresh operator attestation from the verified Yandex console folder")
    parser.add_argument("--capture-account-baseline", type=Path,
                        help="authenticated read-only cloud preflight; writes a new private local account snapshot")
    parser.add_argument("--snapshot-dir", type=Path, default=Path("/var/backups/kabanda/static"))
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    if args.capture_account_baseline:
        if not args.credentials or args.apply or args.account_baseline or args.console_ownership_proof or args.expected_owner_id or args.directory or args.release_sha or args.bucket != BUCKET:
            raise ValueError("baseline capture requires only credentials and a new private output path")
        fingerprint = credential_identity(args.credentials)
        digest = create_account_baseline(s3_client(args.credentials), fingerprint, args.capture_account_baseline)
        print(json.dumps({"cloudMutations": False, "accountBaseline": str(args.capture_account_baseline), "sha256": digest}))
        return 0
    if not args.directory or not args.release_sha:
        raise ValueError("static publication requires directory and release SHA")
    objects = prepare(args.directory, args.release_sha, args.bucket)
    report = {"apply": args.apply, "bucket": BUCKET, "origin": ORIGIN, "releaseSha": args.release_sha,
              "objects": len(objects), "bytes": sum(len(item.body) for item in objects),
              "aliases": ["app", "app/", "lab", "lab/"], "website": WEBSITE}
    if args.apply:
        if not args.credentials or sum(map(bool, (args.expected_owner_id, args.account_baseline, args.console_ownership_proof))) != 1:
            raise ValueError("apply requires credentials and exactly one ownership proof: owner ID, account baseline or console proof")
        if args.snapshot_dir.is_symlink():
            raise ValueError("snapshot directory must be real")
        args.snapshot_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = os.open(args.snapshot_dir / ".publish.lock", os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fingerprint = credential_identity(args.credentials)
            snapshot = publish(s3_client(args.credentials), objects, args.release_sha, args.snapshot_dir,
                               args.expected_owner_id, args.account_baseline, fingerprint, args.console_ownership_proof)
            report["snapshot"] = str(snapshot)
        finally:
            os.close(descriptor)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
    except Exception as error:
        print(f"publication failed: {error_code(error)}", file=sys.stderr)
        raise SystemExit(1)
