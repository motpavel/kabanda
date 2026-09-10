import argparse
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prepare_runtime', Path(__file__).with_name('prepare_runtime.py'))
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class PrepareRuntimeTests(unittest.TestCase):
    def fixture(self, root):
        folder = Path(root).resolve() / 'private'
        folder.mkdir(mode=0o700)
        for name in ['database-app-password', 'relay-session-secret', 'postgres-admin-password',
                     'relay-private-key.pem', 'relay-s3-credentials.json']:
            path = folder / name
            path.write_text('synthetic-test-secret-' * 3)
            path.chmod(0o400)
        source = folder / 'source-config.json'
        source.write_text(json.dumps({
            'ALPHA_ACCESS_MODE': 'enforced', 'ALPHA_ACCESS_SECRET': 'source-alpha-' * 4,
            'MEDIA_CAPABILITY_SECRET': 'source-media-' * 4, 'SESSION_TTL_DAYS': '30',
            'SMTP_HOST': '127.0.0.1', 'SMTP_PORT': '1025', 'SMTP_FROM': 'kabanda@example.test',
            'SMTP_PASSWORD': 'example$password', 'DATABASE_URL': 'postgresql://wrong-source:5432/old',
            'PWA_DIST_DIR': '/old-release/dist', 'APP_ORIGIN': 'https://old.example.test',
        }))
        source.chmod(0o600)
        return argparse.Namespace(
            config_dir=str(folder), source_config_json=str(source), apply=False,
            app_origin='https://kabanda.website.yandexcloud.net', blob_bucket='private-kabanda',
            build_id='3ea877e2f4d43b6b3004116056bf75a64d5bf16b',
            image='kabanda-api:yandex-preflight', database_user='kabanda_app', postgis_image='postgis/postgis:16-3.5',
        )

    def test_preserves_required_secrets_but_discards_source_database_and_frontend_location(self):
        with tempfile.TemporaryDirectory() as root:
            args = self.fixture(root)
            files, summary = runtime.prepare(args)
            api = files[Path(args.config_dir) / 'api.env']
            compose = files[Path(args.config_dir) / 'compose.env']
            self.assertIn('source-alpha-' * 4, api)
            self.assertIn('source-media-' * 4, api)
            self.assertIn("SMTP_PASSWORD='example$password'", api)
            self.assertNotIn('wrong-source', api + compose)
            self.assertNotIn('/old-release', api + compose)
            self.assertIn('@127.0.0.1:54329/kabanda', compose)
            self.assertNotIn('example$password', json.dumps(summary))
            self.assertTrue(summary['smtp_is_loopback'])
            self.assertFalse((Path(args.config_dir) / 'api.env').exists())
            self.assertFalse((Path(args.config_dir) / 'compose.env').exists())

    def test_refuses_incomplete_source_secrets_and_insecure_target_secret_file(self):
        with tempfile.TemporaryDirectory() as root:
            args = self.fixture(root)
            secret = Path(args.config_dir) / 'database-app-password'
            secret.chmod(0o644)
            with self.assertRaises(ValueError):
                runtime.prepare(args)
            secret.chmod(0o400)
            Path(args.source_config_json).write_text('{}')
            with self.assertRaises(ValueError):
                runtime.prepare(args)

    def test_never_evaluates_configuration_and_rejects_multiline_injection(self):
        self.assertEqual(runtime.env_line('SMTP_PASSWORD', '$(touch /tmp/unwanted)'), "SMTP_PASSWORD='$(touch /tmp/unwanted)'\n")
        self.assertEqual(runtime.env_line('SMTP_PASSWORD', "let's-test"), "SMTP_PASSWORD='let\\'s-test'\n")
        with self.assertRaises(ValueError):
            runtime.env_line('SMTP_PASSWORD', 'secret\nAPI_HOST=0.0.0.0')

    def test_refuses_noncanonical_origin_or_invalid_application_role(self):
        with tempfile.TemporaryDirectory() as root:
            args = self.fixture(root)
            args.app_origin = 'https://example.test/other'
            with self.assertRaises(ValueError):
                runtime.prepare(args)
            args.app_origin = 'https://kabanda.website.yandexcloud.net'
            args.database_user = 'postgres; DROP DATABASE kabanda'
            with self.assertRaises(ValueError):
                runtime.prepare(args)


if __name__ == '__main__':
    unittest.main()
