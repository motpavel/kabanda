import base64
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timezone, timedelta
from io import BytesIO

SPEC = importlib.util.spec_from_file_location('stages', Path(__file__).with_name('stages_1_5.py'))
kit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(kit)


def config():
    return {
        'VITE_YANDEX_MAPS_API_KEY': 'test-browser-key-only',
        'VITE_RELAY_BOOTSTRAP_URL': 'https://storage.yandexcloud.net/test-public/transport/v1/apps/kabanda/bootstrap.json',
        'VITE_RELAY_BLOB_BUCKET': 'test-private',
        'VITE_DIRECT_RELAY_URL': '',
        'VITE_RELAY_PUBLIC_KEY': '-----BEGIN PUBLIC KEY-----\n' + base64.b64encode(bytes(range(256))).decode() + '\n-----END PUBLIC KEY-----',
    }


class ReleaseKitTests(unittest.TestCase):
    def test_pins_exact_five_stage_candidate(self):
        self.assertEqual(kit.SOURCE, '4c17cce595167f98a21ab6b56e57b57ffe4badf7')
        self.assertEqual(kit.TREE, '1c991fe91ca62c72a727aebd6e533259df4c1551')
        self.assertEqual(len(kit.STAGES), 5)
        self.assertEqual(kit.STAGES[-1], kit.SOURCE)

    def test_five_public_settings_and_fingerprint(self):
        settings, fingerprint = kit.public_settings(config())
        self.assertEqual(set(settings), kit.PUBLIC_KEYS)
        self.assertEqual(len(fingerprint), 64)

    def test_real_public_key_validation_uses_no_private_material(self):
        pem = subprocess.check_output(['node', '--input-type=module', '-e',
            "import {generateKeyPairSync} from 'node:crypto'; console.log(generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'pem'}))"], text=True).strip()
        settings, fingerprint = kit.public_settings({**config(), 'VITE_RELAY_PUBLIC_KEY': pem})
        self.assertTrue(settings['VITE_RELAY_PUBLIC_KEY'].startswith('-----BEGIN PUBLIC KEY-----'))
        self.assertEqual(len(fingerprint), 64)

    def test_rejects_missing_and_extra_settings_including_credentials(self):
        for key in kit.PUBLIC_KEYS:
            with self.subTest(missing=key), self.assertRaises(kit.GateError):
                kit.public_settings({k: v for k, v in config().items() if k != key})
        for key in ['DATABASE_URL', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS', 'VITE_FAKE_TOKEN']:
            with self.subTest(extra=key), self.assertRaises(kit.GateError):
                kit.public_settings({**config(), key: 'synthetic-secret-never-print'})

    def test_private_key_is_never_accepted(self):
        with self.assertRaises(kit.GateError):
            kit.public_settings({**config(), 'VITE_RELAY_PUBLIC_KEY': '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----'})

    def test_bootstrap_scope_and_url_credentials(self):
        for value in ['http://storage.yandexcloud.net/x/transport/v1/apps/kabanda/bootstrap.json',
                      'https://storage.yandexcloud.net/x/transport/v1/apps/encounter/bootstrap.json',
                      config()['VITE_RELAY_BOOTSTRAP_URL'] + '?token=secret',
                      config()['VITE_RELAY_BOOTSTRAP_URL'].replace('storage.', 'user:password@storage.')]:
            with self.subTest(value=value), self.assertRaises(kit.GateError):
                kit.public_settings({**config(), 'VITE_RELAY_BOOTSTRAP_URL': value})

    def test_direct_connection_cannot_contain_credentials(self):
        for value in ['http://api.example.test', 'https://user:secret@api.example.test', 'https://api.example.test?token=secret']:
            with self.subTest(value=value), self.assertRaises(kit.GateError):
                kit.public_settings({**config(), 'VITE_DIRECT_RELAY_URL': value})

    def test_build_environment_drops_runtime_secrets_and_ci_mode(self):
        with patch.dict(os.environ, {'DATABASE_URL': 'secret', 'NODE_OPTIONS': '--require evil.js',
                                     'KABANDA_E2E': 'true', 'GITHUB_ACTIONS': 'true', 'GH_TOKEN': 'secret'}):
            env = kit.build_environment(config(), Path('/isolated-home'))
        self.assertEqual(env['GITHUB_SHA'], kit.SOURCE)
        self.assertEqual(env['VITE_APP_BASE'], '/')
        self.assertEqual(env['HOME'], '/isolated-home')
        for key in ['DATABASE_URL', 'NODE_OPTIONS', 'KABANDA_E2E', 'GITHUB_ACTIONS', 'GH_TOKEN']:
            self.assertNotIn(key, env)

    def test_build_checksums_detect_mutation_and_symlinks(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); dist = root / 'apps/pwa/dist'; dist.mkdir(parents=True)
            (dist / 'index.html').write_text('shell'); (dist / 'sw.js').write_text('worker')
            first = kit.build_hashes(root)
            (dist / 'sw.js').write_text('changed')
            self.assertNotEqual(first, kit.build_hashes(root))
            (dist / 'symlink').symlink_to(dist / 'sw.js')
            with self.assertRaises(kit.GateError):
                kit.build_hashes(root)

    def test_output_must_be_new_and_reports_private(self):
        with tempfile.TemporaryDirectory() as name:
            output = Path(name) / 'candidate'; kit.new_directory(output)
            self.assertEqual(output.stat().st_mode & 0o777, 0o700)
            with self.assertRaises(kit.GateError):
                kit.new_directory(output)
            target = output / 'record.json'; kit.write_new(target, {'ok': True})
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                kit.write_new(target, {'ok': False})
            self.assertEqual(kit.read_json(target), {'ok': True})

    def test_read_json_rejects_symlink_and_wrong_type(self):
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / 'data'; path.write_text('[]')
            with self.assertRaises(kit.GateError):
                kit.read_json(path)
            path.write_text('{}'); link = Path(name) / 'link'; link.symlink_to(path)
            with self.assertRaises(kit.GateError):
                kit.read_json(link)

    def test_subprocess_error_never_echoes_credentials(self):
        fake = subprocess.CompletedProcess(['docker'], 1, 'DATABASE_URL=secret', 'token=secret')
        with patch.object(kit.subprocess, 'run', return_value=fake):
            with self.assertRaises(kit.GateError) as caught:
                kit.run(['docker', 'inspect'])
        self.assertNotIn('secret', str(caught.exception))
        self.assertNotIn('token=', str(caught.exception))

    def test_ci_requires_exact_sha_repository_and_all_jobs(self):
        run = {'id': kit.CI_RUN, 'head_sha': kit.SOURCE, 'repository': {'full_name': kit.REPOSITORY},
               'event': 'pull_request', 'status': 'completed', 'conclusion': 'success'}
        jobs = {'total_count': 3, 'jobs': [{'name': name, 'run_id': kit.CI_RUN, 'status': 'completed', 'conclusion': 'success'}
                                         for name in ['verify', 'postgres', 'e2e']]}
        kit.validate_ci(run, jobs)
        for field, value in [('head_sha', 'a' * 40), ('conclusion', 'failure'), ('status', 'in_progress'),
                             ('event', 'push'), ('repository', {'full_name': 'other/repo'})]:
            with self.subTest(field=field), self.assertRaises(kit.GateError):
                kit.validate_ci({**run, field: value}, jobs)
        for invalid in [{'total_count': 4, 'jobs': jobs['jobs']}, {'total_count': 0, 'jobs': []}]:
            with self.assertRaises(kit.GateError):
                kit.validate_ci(run, invalid)
        bad = json.loads(json.dumps(jobs)); bad['jobs'][0]['conclusion'] = 'skipped'
        with self.assertRaises(kit.GateError):
            kit.validate_ci(run, bad)

    def test_runtime_gate_rejects_active_raids_migrations_and_transport_mismatch(self):
        candidate = {'migrations': ['0018_old.sql', kit.MIGRATION], 'publicKeySpkiSha256': 'a' * 64, 'blobBucket': 'test-private'}
        state = {**candidate, 'apiBuild': kit.BASE, 'origin': kit.ORIGIN, 'apiReady': True,
                 'inFlightRaids': 0, 'destinationDatabase': True, 'productionGuards': True}
        kit.validate_runtime(state, candidate)
        for field, value in [('origin', 'https://wrong.example.test'), ('apiReady', False), ('apiBuild', 'latest'),
                             ('migrations', [kit.MIGRATION]), ('inFlightRaids', 1), ('inFlightRaids', None),
                             ('publicKeySpkiSha256', 'b' * 64), ('blobBucket', 'other'),
                             ('destinationDatabase', False), ('productionGuards', False)]:
            with self.subTest(field=field), self.assertRaises(kit.GateError):
                kit.validate_runtime({**state, field: value}, candidate)

    def test_runtime_probe_has_read_only_transaction_and_no_writes(self):
        source = Path(__file__).with_name('runtime_readonly.mjs').read_text()
        self.assertIn('BEGIN READ ONLY', source)
        for sql in ['UPDATE ', 'DELETE ', 'INSERT ', 'CREATE ', 'TRUNCATE ', 'DROP ']:
            self.assertNotIn(sql, source)
        self.assertNotIn('console.log(process.env', source)

    def test_verify_source_uses_immutable_object_not_worktree(self):
        calls = []
        def fake(args, **kwargs):
            calls.append(args)
            if 'rev-parse' in args:
                return kit.TREE
            if 'ls-tree' in args:
                return 'infra/postgres/migrations/' + kit.MIGRATION
            return ''
        with patch.object(kit, 'run', side_effect=fake):
            result = kit.verify_source(Path('/repo'))
        self.assertEqual(result['migrations'], [kit.MIGRATION])
        self.assertEqual(sum('merge-base' in args for args in calls), 6)
        self.assertFalse(any('checkout' in args or 'reset' in args for args in calls))

    def test_prepare_refuses_existing_image_before_writing_output(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); settings = root / 'public.json'; settings.write_text(json.dumps(config()))
            args = type('Args', (), {'repo': name, 'output': str(root / 'new'), 'public_config': str(settings),
                                    'node_image': 'node:22-bookworm-slim@sha256:' + 'a' * 64})()
            def fake(cmd, **kwargs):
                return 'v22.1.0' if cmd[0] == 'node' else '11.19.0' if cmd[0] == 'pnpm' else 'sha256:existing'
            with patch.object(kit, 'verify_source', return_value={}), patch.object(kit, 'verify_ci', return_value={}), patch.object(kit, 'run', side_effect=fake):
                with self.assertRaises(kit.GateError):
                    kit.prepare(args)
            self.assertFalse((root / 'new').exists())

    def test_verify_real_git_snapshot_even_with_dirty_worktree(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            def git(*args):
                return subprocess.check_output(['git', '-C', name, *args], text=True, stderr=subprocess.DEVNULL).strip()
            git('init'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Test')
            directory = root / 'infra/postgres/migrations'; directory.mkdir(parents=True)
            (directory / kit.MIGRATION).write_text('-- fixed schema')
            git('add', '.'); git('commit', '-m', 'base')
            base = git('rev-parse', 'HEAD')
            (root / 'app.txt').write_text('candidate'); git('add', '.'); git('commit', '-m', 'candidate')
            source, tree = git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD^{tree}')
            (root / 'app.txt').write_text('unrelated unfinished work')
            with patch.object(kit, 'SOURCE', source), patch.object(kit, 'TREE', tree), patch.object(kit, 'BASE', base), patch.object(kit, 'STAGES', [base, source]):
                self.assertEqual(kit.verify_source(root)['sourceSha'], source)
            self.assertEqual((root / 'app.txt').read_text(), 'unrelated unfinished work')

    def render_fixture(self, root, expired=False):
        credentials, proof, preflight = [root / name for name in ['credentials.json', 'proof.json', 'preflight.json']]
        kit.write_new(credentials, {'key_id': 'synthetic', 'secret': 'DO-NOT-PRINT'})
        kit.write_new(proof, {'bucket': 'kabanda', 'verificationMethod': 'yandex-console',
            'publicAccess': {'read': True, 'list': True, 'configRead': False},
            'verifiedAt': (datetime.now(timezone.utc) - timedelta(hours=25 if expired else 1)).isoformat()})
        state = {'apiContainer': 'a' * 64, 'postgresContainer': 'b' * 64, 'previousImage': 'kabanda-api:previous',
            'previousImageId': 'sha256:' + 'c' * 64, 'previousBuild': kit.BASE,
            'composeEnv': '/etc/kabanda/compose.env', 'composeEnvSha256': 'd' * 64,
            'composeFiles': ['/var/lib/old release/compose.yaml'], 'composeHashes': {'file': 'e' * 64}}
        kit.write_new(preflight, state)
        return credentials, proof, preflight, state

    def test_render_only_writes_commands_with_api_only_scope_and_rollback(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); credentials, proof, preflight, state = self.render_fixture(root)
            with patch.object(kit, 'inspect_runtime', return_value=state), patch.object(kit, 'run') as run:
                kit.render_commands(root / 'candidate', preflight, credentials, proof, root / 'commands')
            run.assert_not_called()
            commands = kit.read_json(root / 'commands/commands.json')
            self.assertIn('--no-deps --no-build --pull never --wait', commands['activateApiOnly'])
            self.assertTrue(commands['activateApiOnly'].endswith('120 api'))
            self.assertIn("'/var/lib/old release/compose.yaml'", commands['activateApiOnly'])
            self.assertIn('smokeStatic', commands)
            self.assertNotIn('DO-NOT-PRINT', json.dumps(commands))
            override = kit.read_json(root / 'commands/api.rollback.json')
            self.assertEqual(set(override['services']), {'api'})
            self.assertEqual(override['services']['api']['environment']['API_BUILD_ID'], kit.BASE)

    def test_render_rejects_expired_proof(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); credentials, proof, preflight, state = self.render_fixture(root, expired=True)
            with patch.object(kit, 'inspect_runtime', return_value=state), self.assertRaises(kit.GateError):
                kit.render_commands(root, preflight, credentials, proof, root / 'commands')
            self.assertFalse((root / 'commands').exists())

    def test_render_rejects_concurrent_release_or_config_change(self):
        for field in ['apiContainer', 'postgresContainer', 'previousImageId', 'previousBuild', 'composeEnvSha256', 'composeHashes']:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as name:
                root = Path(name); credentials, proof, preflight, state = self.render_fixture(root)
                with patch.object(kit, 'inspect_runtime', return_value={**state, field: 'changed'}), self.assertRaises(kit.GateError):
                    kit.render_commands(root, preflight, credentials, proof, root / 'commands')
                self.assertFalse((root / 'commands').exists())

    def test_cli_does_not_offer_deploy_or_migrate(self):
        result = subprocess.run(['python3', str(Path(__file__).with_name('stages_1_5.py')), '--help'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn('{verify,prepare,inspect,render,smoke}', result.stdout)

    def test_static_smoke_matches_bytes_and_cache_without_api_requests(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); dist = root / 'source/apps/pwa/dist'; dist.mkdir(parents=True)
            html = '<script src="/assets/app-test.js"></script>'
            (dist / 'index.html').write_text(html)
            contents = {'index.html': html.encode(), 'assets/app-test.js': b'javascript',
                'manifest.webmanifest': b'{}', 'sw.js': b'worker', 'lab/index.html': b'lab',
                'sw-build-' + kit.SOURCE[:12] + '.js': b'build-marker'}
            report = {'pwaFiles': {key: kit.hashlib.sha256(body).hexdigest() for key, body in contents.items()}}
            paths = []
            class Response:
                status = 200
                headers = {'Cache-Control': 'no-store, immutable'}
                def __init__(self, body): self.body = body
                def read(self, limit): return self.body
                def __enter__(self): return self
                def __exit__(self, *args): pass
            class Opener:
                def open(self, request, timeout):
                    path = request.full_url.removeprefix(kit.ORIGIN)
                    paths.append(path)
                    return Response(contents['index.html' if path == '/app' else path.lstrip('/')])
            with patch.object(kit, 'verify_candidate', return_value=report), patch.object(kit, 'build_opener', return_value=Opener()):
                self.assertEqual(kit.static_smoke(root)['status'], 'STATIC_SMOKE_PASS')
                contents['sw.js'] = b'wrong-release'
                with self.assertRaises(kit.GateError): kit.static_smoke(root)
            self.assertFalse(any(path.startswith('/api') for path in paths))

    def test_static_smoke_refuses_redirects(self):
        with self.assertRaises(kit.GateError):
            kit.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://elsewhere.example.test')


if __name__ == '__main__':
    unittest.main()
