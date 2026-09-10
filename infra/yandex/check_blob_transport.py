#!/usr/bin/env python3
"""Server-only test of Kabanda's private blob transport; --run creates one disposable object."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import sys
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
import urllib.request
from uuid import uuid4

import publish_static as static


BUCKET = "mobile-whitelist-transport-d4egfkd20koseppar0cp"
PREFIX = "transport/v1/blobs/kabanda/probes/"
CREDENTIALS = Path("/etc/kabanda/storage-publisher-credentials.json")
EXPIRY_SECONDS = 300


class ProbeError(Exception):
    pass


@dataclass(frozen=True)
class Response:
    status: int
    headers: dict[str, str]
    body: bytes


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        raise ProbeError("transport redirected; destination withheld")


def http(url: str, method: str, *, headers: dict[str, str] | None = None,
         body: bytes | None = None, limit: int = 4096) -> Response:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    try:
        result = opener.open(request, timeout=15)
    except HTTPError as error:
        result = error
    with result:
        payload = result.read(limit + 1)
        if len(payload) > limit:
            raise ProbeError("transport response exceeded probe size limit")
        return Response(result.status, {key.lower(): value for key, value in result.headers.items()}, payload)


def checked_url(url: str, key: str, *, signed: bool) -> str:
    value = urlsplit(url)
    if value.scheme != "https" or value.netloc != "storage.yandexcloud.net" or value.fragment or value.path != f"/{BUCKET}/{key}":
        raise ProbeError("transport URL is outside the exact private probe object")
    if signed:
        query = parse_qs(value.query)
        if query.get("X-Amz-Algorithm") != ["AWS4-HMAC-SHA256"] or query.get("X-Amz-Expires") != [str(EXPIRY_SECONDS)] or not query.get("X-Amz-Signature"):
            raise ProbeError("transport capability is not the expected short-lived SigV4 URL")
    elif value.query:
        raise ProbeError("anonymous transport request contains a capability query")
    return url


def check_cors(response: Response, method: str, required_headers: set[str]) -> None:
    origin = response.headers.get("access-control-allow-origin", "")
    methods = {value.strip().upper() for value in response.headers.get("access-control-allow-methods", "").split(",")}
    allowed = {value.strip().lower() for value in response.headers.get("access-control-allow-headers", "").split(",")}
    if response.status not in {200, 204} or origin not in {static.ORIGIN, "*"} or method not in methods and "*" not in methods:
        raise ProbeError("Kabanda CORS preflight denied the required method or origin")
    if "*" not in allowed and not required_headers.issubset(allowed):
        raise ProbeError("Kabanda CORS preflight denied required request headers")


def encrypted_fixture() -> tuple[bytes, Callable[[bytes], None]]:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    key, nonce = os.urandom(32), os.urandom(12)
    plaintext = b"Kabanda disposable transport probe v1\0" + os.urandom(256)
    cipher = AESGCM(key)
    ciphertext = nonce + cipher.encrypt(nonce, plaintext, b"kabanda-blob-probe-v1")

    def verify(value: bytes) -> None:
        if cipher.decrypt(value[:12], value[12:], b"kabanda-blob-probe-v1") != plaintext:
            raise ProbeError("probe decryption mismatch")

    return ciphertext, verify


def probe(client: Any, *, request: Callable = http,
          fixture: Callable = encrypted_fixture, probe_id: str | None = None) -> dict[str, Any]:
    probe_id = probe_id or str(uuid4())
    # IDs are generated locally; tests may supply a fixed UUID, never a remote key.
    from uuid import UUID
    if str(UUID(probe_id)) != probe_id:
        raise ProbeError("invalid probe ID")
    key = f"{PREFIX}{probe_id}.bin"
    unsigned = checked_url(f"{static.ENDPOINT}/{BUCKET}/{key}", key, signed=False)
    report: dict[str, Any] = {"probeId": probe_id, "bucket": BUCKET, "checks": {}, "cleanup": "not-needed"}
    attempted = False
    failure: Exception | None = None
    try:
        versioning = client.get_bucket_versioning(Bucket=BUCKET)
        if versioning.get("Status") not in {None, "Disabled"}:
            raise ProbeError("probe requires an unversioned bucket for complete disposable-object cleanup")
        for method, needed in (("PUT", {"content-type"}), ("GET", {"cache-control", "pragma"})):
            result = request(unsigned, "OPTIONS", headers={"Origin": static.ORIGIN,
                             "Access-Control-Request-Method": method,
                             "Access-Control-Request-Headers": ", ".join(sorted(needed))})
            check_cors(result, method, needed)
            report["checks"][f"cors{method.title()}"] = True
        ciphertext, verify_plaintext = fixture()
        if not isinstance(ciphertext, bytes) or not 28 < len(ciphertext) <= 4096:
            raise ProbeError("encrypted fixture is outside the disposable size bound")
        signed_put = checked_url(client.generate_presigned_url("put_object", Params={
            "Bucket": BUCKET, "Key": key, "ContentType": "application/octet-stream", "ContentLength": len(ciphertext),
        }, ExpiresIn=EXPIRY_SECONDS, HttpMethod="PUT"), key, signed=True)
        attempted = True  # A timed-out PUT may have committed; cleanup is mandatory.
        uploaded = request(signed_put, "PUT", headers={"Content-Type": "application/octet-stream"}, body=ciphertext)
        if uploaded.status not in {200, 201, 204}:
            raise ProbeError("signed probe PUT failed")
        report["checks"]["signedPut"] = True
        signed_get = checked_url(client.generate_presigned_url("get_object", Params={"Bucket": BUCKET, "Key": key},
                                                                ExpiresIn=EXPIRY_SECONDS, HttpMethod="GET"), key, signed=True)
        downloaded = request(signed_get, "GET", limit=len(ciphertext))
        if downloaded.status != 200 or downloaded.body != ciphertext:
            raise ProbeError("signed probe GET did not return the exact encrypted bytes")
        verify_plaintext(downloaded.body)
        report["checks"]["signedGetAndDecrypt"] = True
        anonymous = request(unsigned, "GET")
        if anonymous.status != 403:
            raise ProbeError("anonymous access to the existing private probe object was not denied with403")
        report["checks"]["anonymousGet403"] = True
    except Exception as error:
        failure = error
    finally:
        if attempted:
            try:
                deleted = client.delete_object(Bucket=BUCKET, Key=key)
                if deleted.get("ResponseMetadata", {}).get("HTTPStatusCode") not in {200, 204}:
                    raise ProbeError("probe deletion was not acknowledged")
                try:
                    client.head_object(Bucket=BUCKET, Key=key)
                except Exception as error:
                    if static.error_code(error) not in {"404", "NoSuchKey", "NotFound"}:
                        raise ProbeError("probe cleanup could not confirm absence") from None
                else:
                    raise ProbeError("probe object remained after deletion")
                report["cleanup"] = "confirmed"
            except Exception:
                report["cleanup"] = "failed"
    report["ok"] = failure is None and report["cleanup"] == "confirmed"
    if failure is not None:
        report["error"] = str(failure) if isinstance(failure, ProbeError) else f"{type(failure).__name__}; details withheld"
    if report["cleanup"] == "failed":
        report["cleanupPrefix"] = PREFIX
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="run the server-side disposable PUT/GET/CORS test and cleanup")
    args = parser.parse_args(argv)
    if not args.run:
        print(json.dumps({"run": False, "bucket": BUCKET, "prefix": PREFIX, "credentialsFile": str(CREDENTIALS),
                          "maxObjects": 1, "maxBytes": 4096, "cleanup": "finally", "signedUrlsPrinted": False}))
        return 0
    report = probe(static.s3_client(CREDENTIALS))
    print(json.dumps(report, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"ok": False, "error": f"{type(error).__name__}; details withheld"}))
        raise SystemExit(1)
