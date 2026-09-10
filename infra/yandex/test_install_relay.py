import base64
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import install_relay as installer


TEMPLATE = Path(__file__).parent / "templates/relay-config.template.json"
OLD_PATHS = "/etc/storage-relay-kit/config.json:/etc/livestock-flow/relay.json:/etc/encounter-pwa/relay.json"


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.env = self.root / "env"
        self.env.mkdir()
        self.base = self.root / "base.json"
        self.target = self.root / "kabanda-relay/relay.json"
        self.backups = self.root / "backups"
        self.layout = installer.Layout(self.base, self.env, self.target)
        self.base_data = {
            "version": 1,
            "storage": {
                "endpoint": "https://storage.yandexcloud.net", "region": "ru-central1",
                "transport_bucket": "mobile-whitelist-transport-d4egfkd20koseppar0cp",
                "public_bucket": "mobile-whitelist-check-d4egfkd20koseppar0cp",
                "credentials_path": "/etc/whitelist-relay/credentials.json",
                "delivery_mode": "object-trigger", "max_request_bytes": 65536,
                "inbox_prefix": "transport/v1/inbox", "outbox_prefix": "transport/v1/outbox",
                "bootstrap_prefix": "transport/v1/apps", "poll_seconds": 0.75,
                "bootstrap_ttl_seconds": 3600, "response_retention_seconds": 86400,
            },
            "state_database": "/var/lib/storage-relay-kit/encounter-pwa.sqlite3",
            "apps": {"encounter-pwa": {"test": "leave byte-for-byte unchanged"}},
        }
        self.write(self.base, json.dumps(self.base_data).encode())
        for name, key in installer.ENV_KEYS.items():
            self.write(self.env / name, f'# Keep this comment\n{key}="{OLD_PATHS}"\nUNRELATED_SECRET=fixture-never-print\n'.encode())

    def write(self, path, data, mode=0o640):
        path.write_bytes(data)
        path.chmod(mode)

    def prepare(self):
        return installer.prepare(TEMPLATE, os.getgid(), self.layout, os.getuid())

    def apply(self, plan=None, run=None, bootstrap=None):
        self.commands = []
        self.probes = []
        self.bootstrap_checks = []

        def command(arguments):
            self.commands.append(arguments)
            if run:
                run(arguments)

        def check_bootstrap():
            self.bootstrap_checks.append(True)
            if bootstrap:
                bootstrap()

        return installer.apply_plan(plan or self.prepare(), self.backups, run=command,
                                    probe=lambda: self.probes.append(True), check_bootstrap=check_bootstrap)

    def restarts(self):
        return [command for command in self.commands if command[:2] == ["systemctl", "restart"]]

    def test_plan_clones_storage_and_preserves_existing_apps_and_env_metadata(self):
        before = {path: installer.capture(path) for path in [self.base, *self.env.iterdir()]}
        plan = self.prepare()
        config = json.loads(plan.targets[0].data)
        self.assertEqual(set(config["apps"]), {"kabanda"})
        self.assertEqual(config["state_database"], installer.LEDGER)
        expected_storage = dict(self.base_data["storage"], max_request_bytes=262144)
        self.assertEqual(config["storage"], expected_storage)
        self.assertEqual((plan.targets[0].mode, plan.targets[0].uid, plan.targets[0].gid), (0o640, os.getuid(), os.getgid()))
        for desired in plan.targets[1:]:
            old = before[desired.path]
            self.assertEqual((desired.mode, desired.uid, desired.gid), (old.mode, old.uid, old.gid))
            self.assertEqual(desired.data, old.data.replace(OLD_PATHS.encode(), f"{OLD_PATHS}:{installer.CONFIG}".encode()))
        self.assertEqual(before, {path: installer.capture(path) for path in before})
        self.assertFalse(self.target.exists())
        self.assertFalse(self.backups.exists())

    def test_main_dry_run_never_mutates_or_calls_network_and_redacts_config(self):
        plan = self.prepare()
        output = io.StringIO()
        with patch.object(installer, "prepare", return_value=plan), patch.object(installer.grp, "getgrnam"), \
             patch.object(installer, "apply_plan", side_effect=AssertionError("apply forbidden")), \
             patch.object(installer, "checked_run", side_effect=AssertionError("subprocess forbidden")), \
             patch.object(installer, "read_json", side_effect=AssertionError("network forbidden")), \
             patch.object(installer.os, "open", side_effect=AssertionError("write forbidden")), redirect_stdout(output):
            self.assertEqual(installer.main([]), 0)
        report = json.loads(output.getvalue())
        self.assertEqual(report["planHash"], plan.digest)
        self.assertFalse(report["apply"])
        self.assertNotIn("fixture-never-print", output.getvalue())
        self.assertNotIn("storage", report)

    def test_literal_quoted_env_lists_preserve_style_and_are_idempotent(self):
        key = "STORAGE_RELAY_EVENT_CONFIGS"
        for quote in ('"', "'", ""):
            source = f"# Header\r\n  {key} = {quote}{OLD_PATHS}{quote}\r\nOTHER=unchanged\r\n".encode()
            result = installer.append_config(source, key)
            self.assertEqual(result, source.replace(OLD_PATHS.encode(), f"{OLD_PATHS}:{installer.CONFIG}".encode()))
            self.assertEqual(installer.append_config(result, key), result)

    def test_env_ambiguous_or_shell_interpolated_values_fail_closed(self):
        key = "STORAGE_RELAY_EVENT_CONFIGS"
        for value in ("", "/etc/a.json:/etc/a.json", "/etc/../a.json", "$CONFIGS", "`command`", '"/etc/a.json', "/etc/a.json # comment", "/tmp/a.json"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                installer.append_config(f"{key}={value}\n".encode(), key)
        with self.assertRaises(ValueError):
            installer.append_config(f"{key}=/etc/a.json\n{key}=/etc/b.json\n".encode(), key)
        with self.assertRaises(ValueError):
            installer.append_config(b"MISSING=1\n", key)

    def test_foreign_storage_or_existing_target_is_never_overwritten(self):
        self.base_data["storage"]["transport_bucket"] = "other-bucket"
        self.write(self.base, json.dumps(self.base_data).encode())
        with self.assertRaisesRegex(ValueError, "storage identity"):
            self.prepare()
        self.base_data["storage"]["transport_bucket"] = "mobile-whitelist-transport-d4egfkd20koseppar0cp"
        self.write(self.base, json.dumps(self.base_data).encode())
        self.target.parent.mkdir(mode=0o750)
        self.write(self.target, json.dumps(self.base_data).encode())
        with self.assertRaisesRegex(ValueError, "does not isolate"):
            self.prepare()

    def test_world_readable_config_and_symlink_are_rejected(self):
        self.base.chmod(0o644)
        with self.assertRaises(ValueError):
            self.prepare()
        self.base.chmod(0o640)
        destination = self.root / "real-base.json"
        self.base.rename(destination)
        self.base.symlink_to(destination)
        with self.assertRaises(ValueError):
            self.prepare()

    def test_apply_requires_exact_preimage_before_commands_or_backups(self):
        plan = self.prepare()
        self.write(self.env / "bootstrap.env", b"concurrent-update\n")
        with self.assertRaisesRegex(ValueError, "changed since"):
            self.apply(plan)
        self.assertEqual(self.commands, [])
        self.assertFalse(self.target.exists())
        self.assertFalse(self.backups.exists())

    def test_change_during_validation_aborts_before_install(self):
        plan = self.prepare()

        def command(arguments):
            if "validate" in arguments:
                self.write(self.env / "bootstrap.env", b"concurrent-update\n")

        with self.assertRaisesRegex(ValueError, "changed since"):
            self.apply(plan, run=command)
        self.assertFalse(self.target.exists())
        self.assertEqual(self.restarts(), [])
        self.assertEqual((self.env / "bootstrap.env").read_bytes(), b"concurrent-update\n")

    def test_validate_failure_leaves_existing_files_and_listener_untouched(self):
        plan = self.prepare()

        def command(arguments):
            if "validate" in arguments:
                raise RuntimeError("invalid candidate")

        with self.assertRaisesRegex(RuntimeError, "invalid candidate"):
            self.apply(plan, run=command)
        installer.assert_unchanged(plan.sources)
        self.assertEqual(self.restarts(), [])

    def test_apply_validates_health_then_restarts_listener_once_and_verifies_bootstrap(self):
        plan = self.prepare()
        snapshot = self.apply(plan)
        self.assertEqual(self.restarts(), [["systemctl", "restart", installer.LISTENER]])
        validation = next(i for i, command in enumerate(self.commands) if "validate" in command)
        health = next(i for i, command in enumerate(self.commands) if "health" in command)
        restart = self.commands.index(["systemctl", "restart", installer.LISTENER])
        bootstrap = self.commands.index(["systemctl", "start", installer.BOOTSTRAP_SERVICE])
        self.assertLess(validation, health)
        self.assertLess(health, restart)
        self.assertLess(restart, bootstrap)
        self.assertIn("--strict-permissions", self.commands[health])
        self.assertEqual(len(self.probes), 2)
        self.assertEqual(len(self.bootstrap_checks), 1)
        self.assertEqual(stat.S_IMODE(self.target.parent.stat().st_mode), 0o750)
        self.assertEqual(stat.S_IMODE(snapshot.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(snapshot.parent.stat().st_mode), 0o700)
        for desired in plan.targets:
            self.assertEqual(installer.capture(desired.path), desired)
        self.assertEqual(installer.capture(self.base), plan.sources[0])
        stored = json.loads(snapshot.read_bytes())
        self.assertEqual(stored["planHash"], plan.digest)
        self.assertEqual(len(stored["files"]), 4)

    def test_idempotent_reapply_does_not_restart_or_write_snapshots(self):
        self.apply()
        plan = self.prepare()
        self.assertEqual(plan.changed, ())
        before = sorted(self.backups.rglob("*"))
        self.assertIsNone(self.apply(plan))
        self.assertEqual(self.restarts(), [])
        self.assertEqual(sorted(self.backups.rglob("*")), before)
        self.assertEqual(len(self.bootstrap_checks), 1)

    def test_bootstrap_failure_restores_all_files_and_restarts_original_listener(self):
        plan = self.prepare()

        def fail_bootstrap():
            raise ValueError("bad bootstrap metadata")

        with self.assertRaisesRegex(RuntimeError, "configuration rolled back"):
            self.apply(plan, bootstrap=fail_bootstrap)
        installer.assert_unchanged(plan.sources)
        self.assertEqual(self.restarts(), [["systemctl", "restart", installer.LISTENER]] * 2)
        self.assertFalse(self.target.exists())

    def test_rollback_never_overwrites_concurrent_env_edit(self):
        def fail_bootstrap():
            self.write(self.env / "bootstrap.env", b"concurrent-after-install\n")
            raise ValueError("bad bootstrap")

        with self.assertRaisesRegex(RuntimeError, "rollback incomplete"):
            self.apply(bootstrap=fail_bootstrap)
        self.assertEqual((self.env / "bootstrap.env").read_bytes(), b"concurrent-after-install\n")
        self.assertFalse(self.target.exists())

    def test_backend_not_ready_prevents_writes(self):
        plan = self.prepare()
        with self.assertRaisesRegex(ValueError, "unhealthy"):
            installer.apply_plan(plan, self.backups, run=lambda command: self.fail("no service call"),
                                 probe=lambda: (_ for _ in ()).throw(ValueError("unhealthy")))
        installer.assert_unchanged(plan.sources)
        self.assertFalse(self.backups.exists())


class BootstrapTest(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
        self.document = {
            "app_id": "kabanda", "delivery_mode": "object-trigger",
            "expires_at": (self.now + timedelta(hours=1)).isoformat(),
            "outbox_base_url": "https://storage.yandexcloud.net/mobile-whitelist-check-d4egfkd20koseppar0cp/transport/v1/outbox/kabanda",
            "inbox_upload": {
                "url": "https://storage.yandexcloud.net/mobile-whitelist-transport-d4egfkd20koseppar0cp",
                "fields": {"key": "transport/v1/inbox/kabanda/${filename}", "policy": self.policy(262144)},
            },
        }

    def policy(self, maximum):
        return base64.b64encode(json.dumps({"conditions": [["content-length-range", 1, maximum]]}).encode()).decode()

    def test_valid_private_inbox_public_outbox_and_256k_limit(self):
        installer.verify_bootstrap(self.document, self.now)

    def test_expired_or_foreign_bootstrap_is_rejected(self):
        for key, value in (("expires_at", self.now.isoformat()), ("app_id", "encounter-pwa"),
                           ("delivery_mode", "polling"), ("outbox_base_url", "https://other.example/outbox"),
                           ("wakeup_upload", {})):
            with self.subTest(key=key), self.assertRaises(ValueError):
                installer.verify_bootstrap(dict(self.document, **{key: value}), self.now)

    def test_previous_64k_limit_is_not_accepted_for_kabanda(self):
        self.document["inbox_upload"]["fields"]["policy"] = self.policy(65536)
        with self.assertRaisesRegex(ValueError, "limit differs"):
            installer.verify_bootstrap(self.document, self.now)

    def test_malformed_capability_is_not_echoed(self):
        self.document["inbox_upload"]["fields"]["policy"] = "secret-value-not-valid-base64"
        with self.assertRaises(ValueError) as failure:
            installer.verify_bootstrap(self.document, self.now)
        self.assertNotIn("secret-value", str(failure.exception))
        self.document["inbox_upload"]["fields"]["policy"] = self.policy(True)
        with self.assertRaises(ValueError):
            installer.verify_bootstrap(self.document, self.now)


if __name__ == "__main__":
    unittest.main()
