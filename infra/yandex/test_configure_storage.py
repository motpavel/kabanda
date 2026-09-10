import copy
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import configure_storage as policies


class Missing(Exception):
    def __init__(self, kind):
        self.response = {"Error": {"Code": "NoSuchCORSConfiguration" if kind == "cors" else "NoSuchLifecycleConfiguration"}}


class Storage:
    def __init__(self):
        self.state = {}
        self.writes = []
        self.fail = None
        self.concurrent = False
        for bucket in (policies.PUBLIC, policies.PRIVATE):
            self.state[bucket, "cors"] = {"CORSRules": [{"ID": "encounter-existing", "AllowedOrigins": ["https://en8.website.yandexcloud.net"], "AllowedMethods": ["GET", "POST"]}]}
            self.state[bucket, "lifecycle"] = {"Rules": [{"ID": "existing-expiration", "Status": "Enabled", "Filter": {"Prefix": "transport/v1/outbox/encounter-pwa/"}, "Expiration": {"Days": 1}}]}

    def get(self, bucket, kind):
        if (bucket, kind) not in self.state:
            raise Missing(kind)
        return copy.deepcopy(self.state[bucket, kind])

    def put(self, bucket, kind, value):
        self.writes.append((bucket, kind))
        self.state[bucket, kind] = copy.deepcopy(value)
        if self.fail == (bucket, kind):
            self.fail = None
            if self.concurrent:
                key = "CORSRules" if kind == "cors" else "Rules"
                self.state[bucket, kind][key].append({"ID": "concurrent-operator-change"})
            raise TimeoutError("lost put acknowledgement")

    def get_bucket_cors(self, *, Bucket):
        return self.get(Bucket, "cors")

    def get_bucket_lifecycle_configuration(self, *, Bucket):
        return self.get(Bucket, "lifecycle")

    def put_bucket_cors(self, *, Bucket, CORSConfiguration):
        self.put(Bucket, "cors", CORSConfiguration)

    def put_bucket_lifecycle_configuration(self, *, Bucket, LifecycleConfiguration):
        self.put(Bucket, "lifecycle", LifecycleConfiguration)

    def delete_bucket_cors(self, *, Bucket):
        self.writes.append((Bucket, "delete-cors"))
        self.state.pop((Bucket, "cors"), None)

    def delete_bucket_lifecycle(self, *, Bucket):
        self.writes.append((Bucket, "delete-lifecycle"))
        self.state.pop((Bucket, "lifecycle"), None)


class StoragePoliciesTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.client = Storage()

    def test_default_dry_run_uses_only_existing_scoped_buckets_and_never_writes(self):
        before = copy.deepcopy(self.client.state)
        with patch.object(policies.static, "s3_client", return_value=self.client), redirect_stdout(io.StringIO()) as output:
            self.assertEqual(policies.main(["--credentials", "/protected/credentials.json"]), 0)
        self.assertFalse(json.loads(output.getvalue())["apply"])
        self.assertEqual(len(json.loads(output.getvalue())["changedPolicies"]), 4)
        self.assertEqual(self.client.state, before)
        self.assertEqual(self.client.writes, [])
        self.assertFalse(list(self.root.iterdir()))

    def test_merge_preserves_all_other_apps_and_limits_rules_to_kabanda(self):
        before = copy.deepcopy(self.client.state)
        plan = policies.prepare(self.client)
        for item in plan:
            key = "CORSRules" if item.kind == "cors" else "Rules"
            self.assertEqual(item.after[key][:-1], before[item.bucket, item.kind][key])
            rule = item.after[key][-1]
            self.assertTrue(rule["ID"].startswith("kabanda-"))
            if item.kind == "cors":
                self.assertEqual(rule["AllowedOrigins"], [policies.static.ORIGIN])
            else:
                self.assertTrue(rule["Filter"]["Prefix"].endswith("/kabanda/"))
                self.assertEqual(rule["Expiration"], {"Days": 1})
        self.assertEqual(self.client.state, before)

    def test_apply_readback_and_idempotence(self):
        plan = policies.prepare(self.client)
        snapshot = policies.apply_plan(self.client, plan, self.root / "backup")
        self.assertEqual(snapshot.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(self.client.writes), 4)
        again = policies.prepare(self.client)
        self.assertFalse(any(item.changed for item in again))
        self.assertIsNone(policies.apply_plan(self.client, again, self.root / "backup"))
        self.assertEqual(len(self.client.writes), 4)

    def test_static_bucket_is_opt_in_and_has_no_lifecycle(self):
        plan = policies.prepare(self.client, include_static=True)
        static = [item for item in plan if item.bucket == "kabanda"]
        self.assertEqual(len(static), 1)
        self.assertEqual(static[0].kind, "cors")
        self.assertIsNone(static[0].before)

    def test_stale_preimage_stops_before_backups_or_cloud_writes(self):
        plan = policies.prepare(self.client)
        self.client.state[policies.PUBLIC, "cors"]["CORSRules"].append({"ID": "operator-addition"})
        with self.assertRaisesRegex(ValueError, "changed since"):
            policies.apply_plan(self.client, plan, self.root / "backup")
        self.assertEqual(self.client.writes, [])
        self.assertFalse((self.root / "backup").exists())

    def test_lost_acknowledgement_restores_original_policies(self):
        before = copy.deepcopy(self.client.state)
        self.client.fail = policies.PRIVATE, "lifecycle"
        with self.assertRaisesRegex(RuntimeError, "policies rolled back"):
            policies.apply_plan(self.client, policies.prepare(self.client), self.root / "backup")
        self.assertEqual(self.client.state, before)

    def test_rollback_does_not_overwrite_concurrent_changes(self):
        self.client.fail = policies.PRIVATE, "cors"
        self.client.concurrent = True
        with self.assertRaisesRegex(RuntimeError, "rollback incomplete"):
            policies.apply_plan(self.client, policies.prepare(self.client), self.root / "backup")
        self.assertEqual(self.client.state[policies.PRIVATE, "cors"]["CORSRules"][-1]["ID"], "concurrent-operator-change")

    def test_new_config_is_deleted_on_rollback_if_absent_before(self):
        self.client.fail = "kabanda", "cors"
        with self.assertRaisesRegex(RuntimeError, "policies rolled back"):
            policies.apply_plan(self.client, policies.prepare(self.client, include_static=True), self.root / "backup")
        self.assertNotIn(("kabanda", "cors"), self.client.state)

    def test_managed_id_with_foreign_origin_or_prefix_is_rejected(self):
        for kind in ("cors", "lifecycle"):
            client = Storage()
            if kind == "cors":
                client.state[policies.PUBLIC, kind]["CORSRules"].append({"ID": "kabanda-public-read-v1", "AllowedOrigins": ["*"]})
            else:
                client.state[policies.PUBLIC, kind]["Rules"].append({"ID": "kabanda-outbox-expiration-v1", "Filter": {"Prefix": "transport/"}})
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, "outside the Kabanda"):
                policies.prepare(client)
            self.assertEqual(client.writes, [])

    def test_unsupported_policy_fields_are_not_silently_discarded(self):
        self.client.state[policies.PUBLIC, "lifecycle"]["UnexpectedProviderSetting"] = "preserve-me"
        with self.assertRaisesRegex(ValueError, "unsupported fields"):
            policies.prepare(self.client)
        self.assertEqual(self.client.writes, [])

    def test_semantically_reordered_rule_arrays_are_equal(self):
        self.assertTrue(policies.same({"CORSRules": [{"AllowedMethods": ["GET", "HEAD"]}]},
                                      {"CORSRules": [{"AllowedMethods": ["HEAD", "GET"]}]}))


if __name__ == "__main__":
    unittest.main()
