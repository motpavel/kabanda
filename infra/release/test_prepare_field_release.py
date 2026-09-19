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

    def test_prepare_builds_in_new_directory_without_runtime_env(self):
        from types import SimpleNamespace
        import os
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); repo = root / 'repo'; repo.mkdir()
            out = root / 'candidate'; calls = []
            args = SimpleNamespace(repo=str(repo), sha=SHA, run=123, public_config='public.json',
                                   node_image='node:22-bookworm-slim@sha256:' + 'b' * 64, output=str(out))
            def run(argv, **kwargs):
                calls.append((argv, kwargs))
                if argv == ['node', '--version']: return 'v22.16.0'
                if argv == ['pnpm', '--version']: return '11.19.0'
                if argv[:2] == ['git', 'clone']: Path(argv[-1]).mkdir()
                if argv[:3] == ['pnpm', '--filter', '@kabanda/pwa']:
                    dist = kwargs['cwd'] / 'apps/pwa/dist'; dist.mkdir(parents=True)
                    for name in ['index.html', 'sw.js', 'sw-build-' + SHA[:12] + '.js']:
                        (dist / name).write_text('synthetic build output')
                if argv[:3] == ['docker', 'image', 'inspect']: return 'sha256:' + 'c' * 64
                return ''
            with patch.object(kit, 'verify', return_value={'sourceSha': SHA}), patch.object(kit, 'settings', return_value=public()), \
                 patch.object(kit, 'run', side_effect=run), patch.dict(os.environ, {'DATABASE_URL': 'private', 'NODE_OPTIONS': 'private', 'KABANDA_E2E': 'true'}):
                report = kit.prepare(args)
            self.assertEqual(report['status'], 'PREPARED_NOT_DEPLOYED')
            self.assertEqual(len(report['pwaSha256']), 3)
            self.assertEqual(json.loads((out / 'api.override.json').read_text())['services']['api']['environment']['EXPECTED_MIGRATION'], kit.SCHEMA)
            self.assertEqual((out / 'candidate.json').stat().st_mode & 0o777, 0o600)
            for argv, options in calls:
                if argv[0] in ['python3', 'pnpm'] and 'env' in options:
                    self.assertNotIn('DATABASE_URL', options['env'])
                    self.assertNotIn('NODE_OPTIONS', options['env'])
                    self.assertNotIn('KABANDA_E2E', options['env'])
                    self.assertEqual(options['env']['PYTHONDONTWRITEBYTECODE'], '1')
            self.assertFalse(any(argv[:2] in [['docker', 'run'], ['docker', 'compose']] for argv, _ in calls))
            self.assertFalse(any('--apply' in argv for argv, _ in calls))

    def test_prepare_refuses_output_inside_original_worktree(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d)
            args = SimpleNamespace(repo=d, sha=SHA, run=123, public_config='public.json',
                node_image='node:22-bookworm-slim@sha256:' + 'b' * 64, output=str(repo / 'candidate'))
            def run(argv, **kwargs):
                return 'v22.16.0' if argv[0] == 'node' else '11.19.0' if argv[0] == 'pnpm' else ''
            with patch.object(kit, 'verify', return_value={}), patch.object(kit, 'settings', return_value=public()), \
                 patch.object(kit, 'run', side_effect=run), self.assertRaises(kit.Stop):
                kit.prepare(args)
            self.assertFalse((repo / 'candidate').exists())

if __name__ == '__main__': unittest.main()
