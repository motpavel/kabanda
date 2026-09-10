import contextlib
import copy
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import publish_static as publisher


SHA = "1234567890abcdef1234567890abcdef12345678"
OWNER = {"ID": "test-owner"}
OWNER_ACL = {"Owner": OWNER, "Grants": [{"Grantee": {"Type": "CanonicalUser", "ID": "test-owner"}, "Permission": "FULL_CONTROL"}]}
PUBLIC_ACL = {"Owner": OWNER, "Grants": OWNER_ACL["Grants"] + [{"Grantee": {"Type": "Group", "URI": "http://acs.amazonaws.com/groups/global/AllUsers"}, "Permission": "READ"}]}


class Missing(Exception):
    def __init__(self, code="NoSuchKey"):
        self.response = {"Error": {"Code": code}}


class FakeStorage:
    def __init__(self):
        self.objects = {}
        self.acls = {}
        self.bucket_acl = copy.deepcopy(OWNER_ACL)
        self.website = None
        self.writes = []
        self.fail_key = None
        self.foreign_on_failure = False
        self.inventory = {"Owner": {"ID": ""}, "Buckets": [
            {"Name": name, "CreationDate": datetime(2026, 8, 1, tzinfo=timezone.utc)}
            for name in sorted(publisher.ACCOUNT_ANCHORS)]}

    def list_buckets(self):
        return copy.deepcopy(self.inventory)

    def head_bucket(self, *, Bucket):
        return {"ResponseMetadata": {"HTTPStatusCode": 200}}

    def get_bucket_acl(self, **kwargs):
        return copy.deepcopy(self.bucket_acl)

    def get_object(self, *, Bucket, Key):
        if Key not in self.objects:
            raise Missing()
        item = self.objects[Key]
        return {**copy.deepcopy(item["headers"]), "Body": io.BytesIO(item["body"])}

    def get_object_acl(self, *, Bucket, Key):
        return copy.deepcopy(self.acls[Key])

    def put_object(self, *, Bucket, Key, Body, ACL=None, **headers):
        self.writes.append(("put", Key))
        self.objects[Key] = {"body": Body, "headers": copy.deepcopy(headers)}
        self.acls[Key] = copy.deepcopy(PUBLIC_ACL if ACL == "public-read" else OWNER_ACL)
        if Key == self.fail_key:
            self.fail_key = None
            if self.foreign_on_failure:
                self.objects[Key] = {"body": b"concurrent writer", "headers": {"Metadata": {"kabanda-release": "other"}}}
            raise TimeoutError("simulated write acknowledgement loss")

    def delete_object(self, *, Bucket, Key):
        self.writes.append(("delete", Key))
        self.objects.pop(Key, None)
        self.acls.pop(Key, None)

    def put_object_acl(self, *, Bucket, Key, AccessControlPolicy):
        self.acls[Key] = copy.deepcopy(AccessControlPolicy)

    def get_bucket_website(self, *, Bucket):
        if self.website is None:
            raise Missing("NoSuchWebsiteConfiguration")
        return copy.deepcopy(self.website)

    def put_bucket_website(self, *, Bucket, WebsiteConfiguration):
        self.writes.append(("website", Bucket))
        self.website = copy.deepcopy(WebsiteConfiguration)

    def delete_bucket_website(self, *, Bucket):
        self.website = None


class StaticPublisherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.dist = self.root / "dist"
        (self.dist / "assets").mkdir(parents=True)
        (self.dist / "lab").mkdir()
        self.write("assets/main-ABC12345.js", "export const build='test';")
        self.write("assets/main-ABC12345.css", "body { margin:0 }")
        self.write("kabanda-bike-192.png", b"synthetic image fixture")
        self.write("index.html", '<!doctype html><link rel="manifest" href="/manifest.webmanifest"><script src="/assets/main-ABC12345.js"></script>')
        self.write("lab/index.html", '<!doctype html><title>Кабанда GPS</title><link rel="manifest" href="/lab/manifest.webmanifest"><script src="/assets/main-ABC12345.js"></script>')
        self.write("manifest.webmanifest", json.dumps({"start_url": "/app", "scope": "/", "icons": [{"src": "kabanda-bike-192.png"}]}))
        self.write("lab/manifest.webmanifest", json.dumps({"id": "./", "start_url": "./index.html", "scope": "./", "icons": [{"src": "../kabanda-bike-192.png"}]}))
        self.write("sw.js", f'importScripts("sw-build-{SHA[:12]}.js");')
        self.write(f"sw-build-{SHA[:12]}.js", f'port.postMessage({{build:"{SHA[:12]}"}})')

    def write(self, key, value):
        path = self.dist / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value if isinstance(value, bytes) else value.encode())

    def prepare(self):
        return publisher.prepare(self.dist, SHA)

    def test_routes_keep_lab_installation_metadata_and_cache_boundaries(self):
        objects = self.prepare()
        by_key = {item.key: item for item in objects}
        self.assertEqual(by_key["app"].body, by_key["index.html"].body)
        self.assertEqual(by_key["lab/"].body, by_key["lab/index.html"].body)
        self.assertNotEqual(by_key["app/"].body, by_key["lab"].body)
        for key in ["app", "app/", "lab", "lab/", "index.html", "sw.js", "manifest.webmanifest", "lab/manifest.webmanifest"]:
            self.assertEqual(by_key[key].cache_control, "no-store")
        self.assertEqual(by_key["assets/main-ABC12345.css"].cache_control, publisher.IMMUTABLE)
        self.assertEqual(by_key["assets/main-ABC12345.css"].content_type, "text/css; charset=utf-8")
        self.assertEqual(by_key["lab"].content_type, "text/html; charset=utf-8")
        self.assertLess(objects.index(by_key["assets/main-ABC12345.js"]), objects.index(by_key["sw.js"]))
        self.assertFalse(any(item.key.startswith(("api/", "relay/")) for item in objects))

    def test_dry_run_uses_no_credentials_network_or_output_files(self):
        with patch.object(publisher, "s3_client", side_effect=AssertionError("network forbidden")) as connect:
            with contextlib.redirect_stdout(io.StringIO()) as output:
                result = publisher.main(["--directory", str(self.dist), "--release-sha", SHA,
                                         "--credentials", "/missing/credentials.json", "--snapshot-dir", str(self.root / "snapshots")])
        self.assertEqual(result, 0)
        self.assertFalse(json.loads(output.getvalue())["apply"])
        self.assertFalse((self.root / "snapshots").exists())
        connect.assert_not_called()

    def test_rejects_foreign_bucket_and_mixed_worker_build(self):
        with self.assertRaisesRegex(ValueError, "restricted"):
            publisher.prepare(self.dist, SHA, "encounter-pwa")
        self.write("sw.js", 'importScripts("sw-build-old.js");')
        with self.assertRaisesRegex(ValueError, "requested build"):
            self.prepare()

    def test_rejects_lab_using_main_manifest(self):
        self.write("lab/index.html", '<link rel="manifest" href="/manifest.webmanifest"><script src="/assets/main-ABC12345.js"></script>')
        with self.assertRaisesRegex(ValueError, "installation manifest"):
            self.prepare()

    def test_rejects_lab_reusing_main_installation_identity(self):
        manifest = json.loads((self.dist / "lab/manifest.webmanifest").read_text())
        manifest["id"] = "/"
        self.write("lab/manifest.webmanifest", json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "installation identity"):
            self.prepare()

    def test_rejects_private_files_source_maps_and_symlinks(self):
        for key in [".env", "backup.sql", "api/me.json", "assets/main-ABC12345.js.map"]:
            with self.subTest(key=key):
                self.write(key, "must not publish")
                with self.assertRaisesRegex(ValueError, "unexpected public"):
                    self.prepare()
                (self.dist / key).unlink()
        outside = self.root / "operator.txt"
        outside.write_text("not public")
        (self.dist / "brand").mkdir(exist_ok=True)
        (self.dist / "brand" / "outside.png").symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.prepare()

    def test_rejects_external_and_missing_asset_references(self):
        for source in ["https://foreign.example/asset.js", "/assets/missing-ABC12345.js", "/src/main.tsx"]:
            self.write("index.html", f'<link rel="manifest" href="/manifest.webmanifest"><script src="{source}"></script>')
            with self.subTest(source=source), self.assertRaises(ValueError):
                self.prepare()

    def test_success_publishes_read_only_known_files_and_preserves_other_keys(self):
        client = FakeStorage()
        client.objects["unmanaged.txt"] = {"body": b"leave intact", "headers": {}}
        snapshot = publisher.publish(client, self.prepare(), SHA, self.root / "snapshots", "test-owner")
        self.assertEqual(client.objects["unmanaged.txt"]["body"], b"leave intact")
        self.assertEqual(client.website, publisher.WEBSITE)
        self.assertEqual(snapshot.stat().st_mode & 0o777, 0o600)
        self.assertEqual(client.acls["app"], PUBLIC_ACL)
        self.assertEqual(client.bucket_acl, OWNER_ACL)
        self.assertEqual(client.objects["lab"]["body"], client.objects["lab/index.html"]["body"])

    def test_wrong_owner_or_public_listing_fails_before_cloud_writes(self):
        for public_listing in (False, True):
            client = FakeStorage()
            if public_listing:
                client.bucket_acl = copy.deepcopy(PUBLIC_ACL)
            with self.assertRaises(ValueError):
                publisher.publish(client, self.prepare(), SHA, self.root / "snapshots", "test-owner" if public_listing else "wrong-owner")
            self.assertEqual(client.writes, [])
        self.assertFalse((self.root / "snapshots").exists())

    def test_immutable_collision_fails_before_mutable_updates(self):
        client = FakeStorage()
        client.objects["assets/main-ABC12345.js"] = {"body": b"different bytes", "headers": {}}
        with self.assertRaisesRegex(ValueError, "immutable asset"):
            publisher.publish(client, self.prepare(), SHA, self.root / "snapshots", "test-owner")
        self.assertEqual(client.writes, [])

    def test_existing_foreign_website_is_not_reconfigured(self):
        client = FakeStorage()
        client.website = {"RedirectAllRequestsTo": {"HostName": "other.example"}}
        with self.assertRaisesRegex(ValueError, "website configuration"):
            publisher.publish(client, self.prepare(), SHA, self.root / "snapshots", "test-owner")
        self.assertEqual(client.writes, [])

    def test_lost_write_ack_rolls_back_mutable_objects_and_permissions(self):
        client = FakeStorage()
        previous = {"body": b"old service worker", "headers": {"ContentType": "text/javascript", "CacheControl": "no-store", "Metadata": {"old": "release"}}}
        client.objects["sw.js"] = copy.deepcopy(previous)
        client.acls["sw.js"] = copy.deepcopy(OWNER_ACL)
        client.fail_key = "sw.js"
        with self.assertRaisesRegex(RuntimeError, "publication rolled back"):
            publisher.publish(client, self.prepare(), SHA, self.root / "snapshots", "test-owner")
        self.assertEqual(client.objects["sw.js"], previous)
        self.assertEqual(client.acls["sw.js"], OWNER_ACL)
        self.assertNotIn("manifest.webmanifest", client.objects)
        self.assertIn("assets/main-ABC12345.js", client.objects)  # Immutable additions stay usable.
        self.assertIsNone(client.website)

    def test_concurrent_writer_is_not_overwritten_during_rollback(self):
        client = FakeStorage()
        client.fail_key = "sw.js"
        client.foreign_on_failure = True
        with self.assertRaisesRegex(RuntimeError, "rollback incomplete"):
            publisher.publish(client, self.prepare(), SHA, self.root / "snapshots", "test-owner")
        self.assertEqual(client.objects["sw.js"]["body"], b"concurrent writer")

    def account_baseline(self, client):
        path = self.root / "account-baseline.json"
        publisher.create_account_baseline(client, "a" * 64, path)
        return path

    def test_yandex_empty_owner_requires_account_proof_and_new_owned_bucket(self):
        client = FakeStorage()
        client.bucket_acl = {"Owner": {"ID": ""}, "Grants": []}
        baseline = self.account_baseline(client)
        self.assertEqual(baseline.stat().st_mode & 0o777, 0o600)
        self.assertEqual(client.writes, [])
        client.inventory["Buckets"].append({"Name": "kabanda", "CreationDate": datetime.now(timezone.utc)})
        publisher.publish(client, self.prepare(), SHA, self.root / "snapshots", account_baseline=baseline, credential_fingerprint="a" * 64)
        self.assertIn("app", client.objects)
        self.assertEqual(client.bucket_acl, {"Owner": {"ID": ""}, "Grants": []})

    def test_empty_owner_alone_or_changed_credential_cannot_bypass_ownership(self):
        client = FakeStorage()
        client.bucket_acl = {"Owner": {"ID": ""}, "Grants": []}
        baseline = self.account_baseline(client)
        client.inventory["Buckets"].append({"Name": "kabanda", "CreationDate": datetime.now(timezone.utc)})
        with self.assertRaisesRegex(ValueError, "ownership requires"):
            publisher.publish(client, self.prepare(), SHA, self.root / "snapshots")
        with self.assertRaisesRegex(ValueError, "credential"):
            publisher.publish(client, self.prepare(), SHA, self.root / "snapshots", account_baseline=baseline, credential_fingerprint="b" * 64)
        self.assertEqual(client.writes, [])

    def test_account_baseline_rejects_foreign_missing_or_recreated_anchor_and_old_target(self):
        for change in ("missing-target", "missing-anchor", "recreated-anchor", "target-predates-baseline", "public-listing"):
            with self.subTest(change=change):
                client = FakeStorage()
                client.bucket_acl = {"Owner": {"ID": ""}, "Grants": []}
                baseline = self.root / f"{change}.json"
                publisher.create_account_baseline(client, "a" * 64, baseline)
                if change != "missing-target":
                    client.inventory["Buckets"].append({"Name": "kabanda", "CreationDate": datetime.now(timezone.utc)})
                if change == "missing-anchor":
                    client.inventory["Buckets"].pop(0)
                if change == "recreated-anchor":
                    client.inventory["Buckets"][0]["CreationDate"] = datetime.now(timezone.utc)
                if change == "target-predates-baseline":
                    client.inventory["Buckets"][-1]["CreationDate"] = datetime.now(timezone.utc) - timedelta(days=1)
                if change == "public-listing":
                    client.bucket_acl["Grants"] = copy.deepcopy(PUBLIC_ACL["Grants"])
                with self.assertRaises(ValueError):
                    publisher.publish(client, self.prepare(), SHA, self.root / "snapshots", account_baseline=baseline, credential_fingerprint="a" * 64)
                self.assertEqual(client.writes, [])

    def test_account_baseline_capture_is_private_exclusive_and_does_not_print_inventory(self):
        client = FakeStorage()
        credentials = self.root / "credentials.json"
        credentials.write_text(json.dumps({"key_id": "fixture-key", "secret": "fixture-secret"}))
        credentials.chmod(0o600)
        baseline = self.root / "baseline.json"
        with patch.object(publisher, "s3_client", return_value=client), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(publisher.main(["--credentials", str(credentials), "--capture-account-baseline", str(baseline)]), 0)
        self.assertEqual(client.writes, [])
        self.assertNotIn("fixture-key", baseline.read_text())
        self.assertNotIn("fixture-secret", baseline.read_text())
        self.assertNotIn("mobile-whitelist", output.getvalue())
        self.assertFalse(json.loads(output.getvalue())["cloudMutations"])
        with self.assertRaises(FileExistsError):
            publisher.create_account_baseline(client, "a" * 64, baseline)

    def test_existing_owned_kabanda_baseline_remains_valid_for_later_publications(self):
        client = FakeStorage()
        client.bucket_acl = {"Owner": {"ID": ""}, "Grants": []}
        client.inventory["Buckets"].append({"Name": "kabanda", "CreationDate": datetime(2026, 8, 1, tzinfo=timezone.utc)})
        baseline = self.account_baseline(client)
        publisher.publish(client, self.prepare(), SHA, self.root / "snapshots", account_baseline=baseline, credential_fingerprint="a" * 64)
        self.assertIn("app", client.objects)

    def console_proof(self):
        timestamp = datetime.now(timezone.utc).isoformat()
        return {"version": 1, "verificationMethod": "yandex-console", "bucket": "kabanda",
                "folderId": publisher.VERIFIED_FOLDER, "endpoint": publisher.ENDPOINT, "region": publisher.REGION,
                "credentialKeyIdSha256": "a" * 64, "aclOwnerId": "",
                "resourceUrl": f"https://console.yandex.cloud/folders/{publisher.VERIFIED_FOLDER}/storage/buckets/kabanda/objects",
                "createdAt": timestamp, "verifiedAt": timestamp}

    def test_operator_console_proof_supports_scoped_key_without_list_buckets(self):
        client = FakeStorage()
        client.bucket_acl = {"Owner": {"ID": ""}, "Grants": []}
        path = self.root / "ownership.json"
        path.write_text(json.dumps(self.console_proof()))
        path.chmod(0o600)
        with patch.object(client, "list_buckets", side_effect=AssertionError("scoped key has no ListBuckets")):
            publisher.publish(client, self.prepare(), SHA, self.root / "snapshots",
                              console_ownership_proof=path, credential_fingerprint="a" * 64)
        self.assertIn("app", client.objects)

    def test_console_proof_rejects_wrong_folder_key_expiry_resource_and_unconfirmed_access(self):
        for field, value in (("folderId", "another-folder"), ("credentialKeyIdSha256", "b" * 64),
                             ("resourceUrl", "https://console.yandex.cloud/folders/other/storage/buckets/kabanda/objects"),
                             ("verifiedAt", (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()),
                             ("aclOwnerId", "unrelated")):
            with self.subTest(field=field):
                client = FakeStorage()
                client.bucket_acl = {"Owner": {"ID": ""}, "Grants": []}
                proof = dict(self.console_proof(), **{field: value})
                path = self.root / f"proof-{field}.json"
                path.write_text(json.dumps(proof))
                path.chmod(0o600)
                with self.assertRaises(ValueError):
                    publisher.publish(client, self.prepare(), SHA, self.root / "snapshots",
                                      console_ownership_proof=path, credential_fingerprint="a" * 64)
                self.assertEqual(client.writes, [])
        client = FakeStorage()
        path = self.root / "head-unconfirmed.json"
        path.write_text(json.dumps(self.console_proof()))
        path.chmod(0o600)
        with patch.object(client, "head_bucket", return_value={"ResponseMetadata": {"HTTPStatusCode": 403}}), self.assertRaises(ValueError):
            publisher.verify_console_ownership(client, path, "a" * 64, "")


if __name__ == "__main__":
    unittest.main()
