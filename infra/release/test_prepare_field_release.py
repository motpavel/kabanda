import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('kit', Path(__file__).with_name('prepare_field_release.py'))
kit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kit)
SHA = 'a' * 40

def public():
    return {'VITE_YANDEX_MAPS_API_KEY': 'synthetic-browser-key',
            'VITE_RELAY_BOOTSTRAP_URL': 'https://storage.yandexcloud.net/test-public/transport/v1/apps/kabanda/bootstrap.json',
            'VITE_RELAY_BLOB_BUCKET': 'test-private', 'VITE_DIRECT_RELAY_URL': '',
            'VITE_RELAY_PUBLIC_KEY': '-----BEGIN PUBLIC KEY-----\nsynthetic\n-----END PUBLIC KEY-----'}

class SafetyTests(unittest.TestCase):
    def settings(self, data):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / 'public.json'; f.write_text(json.dumps(data))
            return kit.settings(f)

    def test_exact_public_fields(self):
        self.assertEqual(self.settings(public()), public())
        for key in ['DATABASE_URL', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS']:
            with self.subTest(key=key), self.assertRaises(kit.Stop):
                self.settings({**public(), key: 'do-not-print'})

    def test_bad_urls_and_private_key(self):
        for key, value in [('VITE_DIRECT_RELAY_URL', 'https://user:password@example.test'),
                           ('VITE_RELAY_BOOTSTRAP_URL', 'https://evil.test/bootstrap.json'),
                           ('VITE_RELAY_PUBLIC_KEY', '-----BEGIN PRIVATE KEY-----\nsecret'),
                           ('VITE_RELAY_BLOB_BUCKET', '../other')]:
            with self.subTest(key=key), self.assertRaises(kit.Stop):
                self.settings({**public(), key: value})

    def test_write_is_private_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / 'report.json'; kit.write_new(f, {'first': True})
            self.assertEqual(f.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError): kit.write_new(f, {'first': False})
            self.assertTrue(json.loads(f.read_text())['first'])

    def test_run_failure_does_not_echo_credentials(self):
        fake = subprocess.CompletedProcess(['tool'], 1, 'secret-token', 'secret-password')
        with patch.object(kit.subprocess, 'run', return_value=fake), self.assertRaises(kit.Stop) as e:
            kit.run(['tool'])
        self.assertNotIn('secret', str(e.exception))

    def verified(self, ci_change=None, bad_job=False, changed_pr=False):
        ci = {'id': 123, 'repository': {'full_name': kit.REPO}, 'head_sha': SHA, 'status': 'completed',
              'conclusion': 'success', 'event': 'pull_request', **(ci_change or {})}
        jobs = {'total_count': 3, 'jobs': [{'name': name, 'run_id': 123,
                'conclusion': 'failure' if bad_job and name == 'e2e' else 'success'} for name in ['verify', 'postgres', 'e2e']]}
        pr = {'head': {'sha': 'b' * 40 if changed_pr else SHA}, 'base': {'sha': kit.BASE}}
        def run(args, **kwargs):
            if args[0] == 'git':
                if 'rev-parse' in args: return 'c' * 40
                if 'ls-tree' in args: return '\n'.join(f'infra/postgres/migrations/{i:04}_migration.sql' for i in range(1,20)) + '\ninfra/postgres/migrations/' + kit.SCHEMA
                return ''
            return json.dumps(jobs if '/jobs?' in args[-1] else pr if '/pulls/74' in args[-1] else ci)
        with patch.object(kit, 'run', side_effect=run): return kit.verify(Path('/repo'), SHA, 123)

    def test_ci_and_source_identity(self):
        self.assertEqual(self.verified()['sourceSha'], SHA)
        for change in [{'head_sha': 'b' * 40}, {'conclusion': 'failure'}, {'event': 'push'}, {'status': 'in_progress'}]:
            with self.subTest(change=change), self.assertRaises(kit.Stop): self.verified(change)

    def test_failed_browser_and_changed_pr_are_stops(self):
        with self.assertRaises(kit.Stop): self.verified(bad_job=True)
        with self.assertRaises(kit.Stop): self.verified(changed_pr=True)

    def test_symbolic_ref_rejected_before_external_commands(self):
        with patch.object(kit, 'run') as run, self.assertRaises(kit.Stop): kit.verify(Path('/repo'), 'latest', 123)
        run.assert_not_called()

    def test_runtime_script_is_read_only(self):
        text = Path(__file__).with_name('runtime_field_check.mjs').read_text()
        self.assertIn('BEGIN READ ONLY', text)
        for phrase in ['DELETE ', 'INSERT ', 'UPDATE ', 'CREATE ', 'DROP ', 'TRUNCATE ']: self.assertNotIn(phrase, text)
        self.assertNotIn('console.log(process.env', text)

if __name__ == '__main__': unittest.main()
