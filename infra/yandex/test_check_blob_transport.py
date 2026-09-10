from contextlib import redirect_stdout
import io
import json
import unittest
from unittest.mock import patch

import check_blob_transport as probe


IDENTIFIER = "04bbac05-0e3f-443e-99b3-4edc4fa9198c"
SECRET = "presigned-capability-must-never-be-printed"


class Missing(Exception):
    response = {"Error": {"Code": "404"}}


class Storage:
    def __init__(self):
        self.body = None
        self.signed = []
        self.deleted = []
        self.versioning = {}
        self.delete_failure = False

    def get_bucket_versioning(self, *, Bucket):
        assert Bucket == probe.BUCKET
        return self.versioning

    def generate_presigned_url(self, method, *, Params, ExpiresIn, HttpMethod):
        assert Params["Bucket"] == probe.BUCKET
        self.signed.append((method, Params, HttpMethod))
        return (f"https://storage.yandexcloud.net/{probe.BUCKET}/{Params['Key']}"
                f"?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires={ExpiresIn}&X-Amz-Signature={SECRET}")

    def delete_object(self, *, Bucket, Key):
        assert Bucket == probe.BUCKET
        self.deleted.append(Key)
        if self.delete_failure:
            raise RuntimeError(SECRET)
        self.body = None
        return {"ResponseMetadata": {"HTTPStatusCode": 204}}

    def head_object(self, *, Bucket, Key):
        assert Bucket == probe.BUCKET
        if self.body is None:
            raise Missing()
        return {"ContentLength": len(self.body)}


class PrivateBlobProbeTest(unittest.TestCase):
    def setUp(self):
        self.client = Storage()
        self.requests = []
        self.fail_put = False
        self.allow_anonymous = False
        self.cors_origin = probe.static.ORIGIN
        self.decrypted = []

    def request(self, url, method, *, headers=None, body=None, limit=4096):
        self.requests.append((url, method, headers or {}))
        if method == "OPTIONS":
            return probe.Response(200, {"access-control-allow-origin": self.cors_origin,
                                       "access-control-allow-methods": "GET, PUT, POST, HEAD",
                                       "access-control-allow-headers": "*"}, b"")
        if method == "PUT":
            self.client.body = body
            if self.fail_put:
                raise TimeoutError(SECRET)
            return probe.Response(200, {}, b"")
        if "X-Amz-Signature=" in url or self.allow_anonymous:
            return probe.Response(200, {}, self.client.body)
        return probe.Response(403, {}, b"AccessDenied")

    def run_probe(self):
        return probe.probe(self.client, request=self.request,
                           fixture=lambda: (b"encrypted-disposable-fixture" * 8, self.decrypted.append),
                           probe_id=IDENTIFIER)

    def test_single_put_signed_get_anonymous_denial_cors_and_confirmed_cleanup(self):
        report = self.run_probe()
        self.assertTrue(report["ok"])
        self.assertEqual(report["cleanup"], "confirmed")
        self.assertEqual(set(report["checks"]), {"corsPut", "corsGet", "signedPut", "signedGetAndDecrypt", "anonymousGet403"})
        self.assertEqual(len([request for request in self.requests if request[1] == "PUT"]), 1)
        self.assertEqual(len(self.decrypted), 1)
        self.assertEqual(self.client.deleted, [f"{probe.PREFIX}{IDENTIFIER}.bin"])
        self.assertIsNone(self.client.body)
        self.assertNotIn(SECRET, json.dumps(report))
        self.assertNotIn("https://", json.dumps(report))
        for url, method, headers in self.requests:
            self.assertNotIn("Authorization", headers)
            self.assertNotIn("Cookie", headers)
            if method == "OPTIONS":
                self.assertNotIn("?", url)
                self.assertEqual(headers["Origin"], probe.static.ORIGIN)

    def test_lost_put_acknowledgement_always_deletes_without_leaking_url(self):
        self.fail_put = True
        report = self.run_probe()
        self.assertFalse(report["ok"])
        self.assertEqual(report["cleanup"], "confirmed")
        self.assertEqual(len(self.client.deleted), 1)
        self.assertIsNone(self.client.body)
        self.assertNotIn(SECRET, json.dumps(report))

    def test_anonymous_access_is_a_failure_and_still_cleans_up(self):
        self.allow_anonymous = True
        report = self.run_probe()
        self.assertFalse(report["ok"])
        self.assertIn("not denied", report["error"])
        self.assertEqual(report["cleanup"], "confirmed")

    def test_failed_cleanup_is_reported_with_safe_probe_locator(self):
        self.client.delete_failure = True
        report = self.run_probe()
        self.assertFalse(report["ok"])
        self.assertEqual(report["cleanup"], "failed")
        self.assertEqual(report["cleanupPrefix"], probe.PREFIX)
        self.assertEqual(report["probeId"], IDENTIFIER)
        self.assertNotIn(SECRET, json.dumps(report))

    def test_wrong_cors_origin_stops_before_put(self):
        self.cors_origin = "https://other.example"
        report = self.run_probe()
        self.assertFalse(report["ok"])
        self.assertEqual(report["cleanup"], "not-needed")
        self.assertEqual(self.client.signed, [])
        self.assertEqual(self.client.deleted, [])

    def test_versioned_bucket_stops_before_object_write(self):
        for status in ("Enabled", "Suspended"):
            self.client.versioning = {"Status": status}
            with self.subTest(status=status):
                report = self.run_probe()
                self.assertFalse(report["ok"])
                self.assertEqual(self.client.deleted, [])
                self.assertEqual(self.client.signed, [])
                self.assertEqual(self.requests, [])

    def test_urls_cannot_escape_private_object_or_sign_anonymous_check(self):
        key = f"{probe.PREFIX}{IDENTIFIER}.bin"
        for url in (f"https://other.example/{probe.BUCKET}/{key}",
                    f"https://storage.yandexcloud.net/kabanda/{key}",
                    f"https://storage.yandexcloud.net/{probe.BUCKET}/transport/v1/inbox/kabanda/object",
                    f"https://storage.yandexcloud.net/{probe.BUCKET}/{key}?signature=bad"):
            with self.subTest(url=url), self.assertRaises(probe.ProbeError):
                probe.checked_url(url, key, signed=True)
        with self.assertRaises(probe.ProbeError):
            probe.checked_url(f"https://storage.yandexcloud.net/{probe.BUCKET}/{key}?secret=1", key, signed=False)

    def test_default_mode_does_not_read_credentials_or_call_cloud(self):
        with patch.object(probe.static, "s3_client", side_effect=AssertionError("no credentials/network")), redirect_stdout(io.StringIO()) as output:
            self.assertEqual(probe.main([]), 0)
        report = json.loads(output.getvalue())
        self.assertFalse(report["run"])
        self.assertEqual(report["maxObjects"], 1)
        self.assertEqual(report["credentialsFile"], "/etc/kabanda/storage-publisher-credentials.json")


if __name__ == "__main__":
    unittest.main()
