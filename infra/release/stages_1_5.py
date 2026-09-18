#!/usr/bin/env python3
"""Pinned Kabanda handoff. Prepare locally and render commands; NEVER deploy.

Only `prepare` writes a NEW output directory/builds an image. `inspect` performs
read-only Docker/SQL/health checks and writes a NEW private report. No command
updates services, secrets, buckets, users, schema, relay configuration or queues.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler

REPOSITORY = 'motpavel/kabanda'
SOURCE = '4c17cce595167f98a21ab6b56e57b57ffe4badf7'
TREE = '1c991fe91ca62c72a727aebd6e533259df4c1551'
BASE = 'ac2e2839cb83264b6489f537208108861e590fed'
STAGES = [
    '5018b63a6f32c776654f18897352af7ef8b5337d',
    'b667448d73fe0eaa6bac08490bb180551812217d',
    '45ac3ce934a8a134c97d4adb3f19702c5f1ee5fc',
    '1c6e25c4922ef780b8da83e21b397d0aed1e2263', SOURCE,
]
CI_RUN = 35365776986
ORIGIN = 'https://kabanda.website.yandexcloud.net'
MIGRATION = '0019_raid_template_description.sql'
API_IMAGE = 'kabanda-api:stages-1-5-' + SOURCE
PUBLIC_KEYS = {
    'VITE_YANDEX_MAPS_API_KEY', 'VITE_RELAY_BOOTSTRAP_URL',
    'VITE_RELAY_PUBLIC_KEY', 'VITE_RELAY_BLOB_BUCKET', 'VITE_DIRECT_RELAY_URL',
}
HERE = Path(__file__).resolve().parent


class GateError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise GateError(message)


def run(args: list[str], *, cwd: Path | None = None, env: dict | None = None,
        stdin: str | None = None, timeout: int = 60) -> str:
    # Never echo captured command output: Docker/env/SDK failures may contain secrets.
    try:
        result = subprocess.run(args, cwd=cwd, env=env, input=stdin, text=True,
                                capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GateError(f'{Path(args[0]).name}: command unavailable or timed out; inspect locally without exposing credentials') from exc
    require(result.returncode == 0,
            f'{Path(args[0]).name}: command failed; no automatic retry, deploy or cleanup was performed')
    return result.stdout.strip()


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def read_json(path: Path) -> dict:
    require(path.is_file() and not path.is_symlink(), 'Expected a regular JSON file, not a symlink')
    require(path.stat().st_size < 4 * 1024 * 1024, 'JSON input is too large')
    try:
        data = json.loads(path.read_text())
    except (ValueError, UnicodeError) as exc:
        raise GateError('Invalid JSON input (contents suppressed)') from exc
    require(isinstance(data, dict), 'Expected a JSON object')
    return data


def write_new(path: Path, data: dict | str) -> None:
    content = data if isinstance(data, str) else json.dumps(data, indent=2, ensure_ascii=False) + '\n'
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(content)


def new_directory(path: Path) -> None:
    require(not path.exists() and not path.is_symlink(), 'Output already exists; never overwrite a previous candidate/report')
    require(path.parent.is_dir(), 'Output parent must already exist')
    path.mkdir(mode=0o700)


def verify_source(repo: Path) -> dict:
    def git(*args: str) -> str:
        return run(['git', '-C', str(repo), *args])
    require(git('rev-parse', f'{SOURCE}^{{tree}}') == TREE, 'Pinned source tree mismatch')
    for sha in [BASE, *STAGES]:
        git('merge-base', '--is-ancestor', sha, SOURCE)
    git('diff', '--exit-code', BASE, SOURCE, '--', 'infra/postgres/migrations')
    migrations = git('ls-tree', '-r', '--name-only', SOURCE, '--', 'infra/postgres/migrations').splitlines()
    migrations = sorted(Path(name).name for name in migrations if name.endswith('.sql'))
    require(bool(migrations) and migrations[-1] == MIGRATION, 'Unexpected source migration set')
    return {'sourceSha': SOURCE, 'sourceTree': TREE, 'stages': STAGES,
            'migrationChange': False, 'requiredMigration': MIGRATION, 'migrations': migrations}


def validate_ci(run_data: dict, jobs: dict) -> None:
    require(run_data.get('id') == CI_RUN and run_data.get('head_sha') == SOURCE,
            'CI run does not identify the pinned application SHA')
    require(run_data.get('repository', {}).get('full_name') == REPOSITORY, 'CI repository mismatch')
    require(run_data.get('event') == 'pull_request' and run_data.get('status') == 'completed'
            and run_data.get('conclusion') == 'success', 'Pinned application CI is not successful')
    rows = jobs.get('jobs', [])
    require(len(rows) == jobs.get('total_count') and len(rows) <= 100, 'Incomplete CI job list')
    for name in ['verify', 'postgres', 'e2e']:
        matching = [row for row in rows if row.get('name') == name]
        require(len(matching) == 1 and matching[0].get('run_id') == CI_RUN
                and matching[0].get('status') == 'completed' and matching[0].get('conclusion') == 'success',
                f'CI job {name} is missing or unsuccessful')


def verify_ci() -> dict:
    prefix = f'repos/{REPOSITORY}/actions/runs/{CI_RUN}'
    data = json.loads(run(['gh', 'api', prefix]))
    jobs = json.loads(run(['gh', 'api', prefix + '/jobs?filter=latest&per_page=100']))
    validate_ci(data, jobs)
    return {'runId': CI_RUN, 'headSha': SOURCE, 'conclusion': 'success',
            'checkedAt': datetime.now(timezone.utc).isoformat()}


def public_settings(data: dict) -> tuple[dict, str]:
    require(set(data) == PUBLIC_KEYS, 'Public config must contain exactly the five documented VITE fields; never pass api.env or credentials')
    require(all(isinstance(value, str) and len(value) <= 8192 for value in data.values()), 'Public settings must be bounded strings')
    settings = {key: value.strip() for key, value in data.items()}
    require(re.fullmatch(r'[A-Za-z0-9_-]{8,256}', settings['VITE_YANDEX_MAPS_API_KEY']) is not None,
            'Reuse the existing browser Maps key; placeholders are not a build configuration')
    bootstrap = urlsplit(settings['VITE_RELAY_BOOTSTRAP_URL'])
    require(bootstrap.scheme == 'https' and bootstrap.netloc == 'storage.yandexcloud.net'
            and re.fullmatch(r'/[a-z0-9-]+/transport/v1/apps/kabanda/bootstrap\.json', bootstrap.path)
            and not bootstrap.query and not bootstrap.fragment, 'Invalid Kabanda bootstrap URL')
    require(re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', settings['VITE_RELAY_BLOB_BUCKET']) is not None,
            'Invalid private blob bucket setting')
    direct = settings['VITE_DIRECT_RELAY_URL']
    if direct:
        url = urlsplit(direct)
        require(url.scheme == 'https' and bool(url.hostname) and not url.username and not url.password
                and not url.query and not url.fragment, 'Direct Relay must be the existing credential-free HTTPS URL')
    pem = settings['VITE_RELAY_PUBLIC_KEY'].replace('\\n', '\n')
    require(pem.startswith('-----BEGIN PUBLIC KEY-----\n') and pem.endswith('\n-----END PUBLIC KEY-----'),
            'Only the existing SPKI PUBLIC key is allowed, never a private key')
    try:
        der = base64.b64decode(''.join(pem.splitlines()[1:-1]), validate=True)
    except ValueError as exc:
        raise GateError('Invalid public key encoding') from exc
    require(256 <= len(der) <= 4096, 'Invalid SPKI key size')
    settings['VITE_RELAY_PUBLIC_KEY'] = pem
    return settings, hashlib.sha256(der).hexdigest()


def build_environment(settings: dict, home: Path) -> dict:
    # No DATABASE_URL, API secrets, NODE_OPTIONS, npm hooks, E2E or GH_* variables.
    return {'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'),
            'HOME': str(home), 'LANG': 'C.UTF-8', 'CI': 'true',
            'GITHUB_SHA': SOURCE, 'VITE_APP_BASE': '/', **settings}


def build_hashes(source: Path) -> dict:
    dist = source / 'apps/pwa/dist'
    require(dist.is_dir() and not dist.is_symlink(), 'PWA build is missing')
    result = {}
    for path in sorted(dist.rglob('*')):
        require(not path.is_symlink(), 'A build output is a symlink')
        if path.is_file():
            result[path.relative_to(dist).as_posix()] = digest(path)
    require('index.html' in result and 'sw.js' in result, 'PWA shell/worker are missing')
    return result


def prepare(args: argparse.Namespace) -> dict:
    repo, output = Path(args.repo).resolve(), Path(args.output).absolute()
    source_info = verify_source(repo)
    ci = verify_ci()
    settings, fingerprint = public_settings(read_json(Path(args.public_config)))
    require(re.fullmatch(r'node:[a-zA-Z0-9._-]+@sha256:[0-9a-f]{64}', args.node_image) is not None,
            'Use a reviewed Node base image digest, not a moving tag')
    require(run(['node', '--version']).startswith('v22.'), 'Node 22 is required; do not upgrade the host automatically')
    require(run(['pnpm', '--version']) == '11.19.0', 'pnpm 11.19.0 is required')
    existing = run(['docker', 'image', 'ls', '--no-trunc', '--quiet', API_IMAGE])
    require(not existing, 'Candidate image tag already exists; do not overwrite it or prune images')
    new_directory(output)
    home = output / 'build-home'; home.mkdir(mode=0o700)
    source = output / 'source'
    run(['git', 'clone', '--no-hardlinks', '--no-checkout', '--', str(repo), str(source)], timeout=180)
    run(['git', '-C', str(source), 'checkout', '--detach', SOURCE])
    verify_source(source)
    env = build_environment(settings, home)
    print('Preparing isolated dependencies and PWA; no services or cloud objects are changed.', flush=True)
    run(['pnpm', 'install', '--frozen-lockfile'], cwd=source, env=env, timeout=900)
    run(['pnpm', '--filter', '@kabanda/pwa', 'build'], cwd=source,
        env={**env, 'NODE_ENV': 'production'}, timeout=900)
    run(['python3', 'infra/yandex/publish_static.py', '--directory', 'apps/pwa/dist', '--release-sha', SOURCE], cwd=source)
    print('Building the API image; no container will be started.', flush=True)
    run(['docker', 'build', '--platform', 'linux/amd64', '--build-arg', f'NODE_IMAGE={args.node_image}',
         '--label', f'org.opencontainers.image.revision={SOURCE}', '-f', 'infra/yandex/Dockerfile.api', '-t', API_IMAGE, '.'],
        cwd=source, timeout=1800)
    require(not run(['git', '-C', str(source), 'status', '--porcelain', '--untracked-files=all']),
            'Isolated source changed during build; do not publish')
    image_id = run(['docker', 'image', 'inspect', '--format', '{{.Id}}', API_IMAGE])
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', image_id) is not None, 'Invalid built image ID')
    report = {**source_info, 'ci': ci, 'origin': ORIGIN, 'apiImage': API_IMAGE, 'apiImageId': image_id,
              'nodeImage': args.node_image, 'publicKeySpkiSha256': fingerprint,
              'blobBucket': settings['VITE_RELAY_BLOB_BUCKET'],
              'publicSettingsSha256': hashlib.sha256(json.dumps(settings, sort_keys=True).encode()).hexdigest(),
              'pwaFiles': build_hashes(source), 'preparedAt': datetime.now(timezone.utc).isoformat()}
    write_new(output / 'public-build.json', settings)
    write_new(output / 'candidate.json', report)
    write_new(output / 'api.override.json', {'services': {'api': {'image': API_IMAGE, 'pull_policy': 'never',
        'environment': {'API_BUILD_ID': SOURCE, 'EXPECTED_MIGRATION': MIGRATION}}}})
    return {'status': 'PREPARED_NOT_DEPLOYED', 'sourceSha': SOURCE, 'output': str(output), 'apiImageId': image_id}


def verify_candidate(output: Path) -> dict:
    report = read_json(output / 'candidate.json')
    require(report.get('sourceSha') == SOURCE and report.get('sourceTree') == TREE, 'Candidate identity mismatch')
    source = output / 'source'
    expected_source = verify_source(source)
    require(report.get('migrations') == expected_source['migrations'], 'Candidate migration metadata changed')
    require(run(['git', '-C', str(source), 'rev-parse', 'HEAD']) == SOURCE, 'Candidate checkout moved')
    require(not run(['git', '-C', str(source), 'status', '--porcelain', '--untracked-files=all']), 'Candidate checkout is dirty')
    require(build_hashes(source) == report.get('pwaFiles'), 'Built frontend changed after preparation')
    settings, fingerprint = public_settings(read_json(output / 'public-build.json'))
    require(hashlib.sha256(json.dumps(settings, sort_keys=True).encode()).hexdigest() == report.get('publicSettingsSha256')
            and fingerprint == report.get('publicKeySpkiSha256'), 'Public build configuration changed')
    require(report.get('apiImage') == API_IMAGE and
            run(['docker', 'image', 'inspect', '--format', '{{.Id}}', API_IMAGE]) == report.get('apiImageId'), 'Candidate image tag changed')
    require(run(['docker', 'image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', API_IMAGE]) == SOURCE,
            'Image revision label mismatch')
    expected = {'services': {'api': {'image': API_IMAGE, 'pull_policy': 'never',
                'environment': {'API_BUILD_ID': SOURCE, 'EXPECTED_MIGRATION': MIGRATION}}}}
    require(read_json(output / 'api.override.json') == expected, 'API override changed or contains unexpected settings')
    return report


def one_container(service: str) -> str:
    ids = run(['docker', 'ps', '--quiet', '--no-trunc', '--filter', 'label=com.docker.compose.project=kabanda',
               '--filter', f'label=com.docker.compose.service={service}']).splitlines()
    require(len(ids) == 1 and re.fullmatch(r'[0-9a-f]{64}', ids[0]) is not None,
            f'Expected exactly one running Kabanda {service} container')
    return ids[0]


def inspect_runtime(candidate: Path, compose_env: Path) -> dict:
    report = verify_candidate(candidate)
    require(compose_env.is_file() and not compose_env.is_symlink()
            and compose_env.stat().st_mode & 0o077 == 0, 'Existing compose.env must be a private regular file')
    api, postgres = one_container('api'), one_container('postgres')
    fmt = lambda value: run(['docker', 'inspect', '--format', value, api])
    require(fmt('{{.State.Health.Status}}') == 'healthy', 'Current API is not healthy')
    raw = run(['docker', 'exec', '-i', api, 'node', '--input-type=module'],
              stdin=(HERE / 'runtime_readonly.mjs').read_text(), timeout=45)
    state = json.loads(raw)
    validate_runtime(state, report)
    run(['git', '-C', str(candidate / 'source'), 'merge-base', '--is-ancestor', state['apiBuild'], SOURCE])
    require(run(['docker', 'inspect', '--format', '{{.State.Health.Status}}', postgres]) == 'healthy', 'Current database is not healthy')
    mounts = json.loads(run(['docker', 'inspect', '--format', '{{json .Mounts}}', postgres]))
    require(any(mount.get('Type') == 'volume' and mount.get('Name') == 'kabanda_postgres_data'
                and mount.get('Destination') == '/var/lib/postgresql/data' for mount in mounts), 'Unexpected PostgreSQL data volume')
    files = fmt('{{index .Config.Labels "com.docker.compose.project.config_files"}}').split(',')
    require(files and len(files) <= 8, 'Unrecognized Compose configuration list')
    config_hashes = {}
    for name in files:
        path = Path(name)
        require(path.is_absolute() and path.is_file() and not path.is_symlink(), 'Live Compose source unavailable; do not substitute old templates')
        config_hashes[str(path)] = digest(path)
    previous_image = fmt('{{.Config.Image}}')
    previous_id = fmt('{{.Image}}')
    require(re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._/:@-]+', previous_image) is not None, 'Invalid previous image reference')
    require(run(['docker', 'image', 'inspect', '--format', '{{.Id}}', previous_image]) == previous_id,
            'Previous image tag moved; preserve the running image before proceeding')
    return {'status': 'PREFLIGHT_PASS_NOT_AUTHORIZATION', 'checkedAt': datetime.now(timezone.utc).isoformat(),
            'apiContainer': api, 'postgresContainer': postgres, 'previousImage': previous_image,
            'previousImageId': previous_id, 'previousBuild': state['apiBuild'],
            'composeFiles': files, 'composeHashes': config_hashes, 'composeEnv': str(compose_env),
            'composeEnvSha256': digest(compose_env), 'runtime': state}


def validate_runtime(state: dict, candidate: dict) -> None:
    require(state.get('origin') == ORIGIN and state.get('apiReady') is True, 'Wrong origin or failed readiness')
    require(re.fullmatch(r'[0-9a-f]{40}', state.get('apiBuild', '')) is not None, 'Current API build is not an exact SHA')
    require(state.get('migrations') == candidate.get('migrations'), 'Database migration set differs; NO automatic migration')
    require(state.get('inFlightRaids') == 0, 'A raid is active, paused or finalizing; do not interrupt it')
    require(state.get('publicKeySpkiSha256') == candidate.get('publicKeySpkiSha256'), 'Relay key differs from the prepared frontend')
    require(state.get('blobBucket') == candidate.get('blobBucket'), 'Relay blob bucket differs from frontend')
    require(state.get('destinationDatabase') is True and state.get('productionGuards') is True, 'Runtime configuration is not the expected protected Yandex installation')


def render_commands(candidate: Path, preflight_path: Path, credentials: Path, proof: Path, output: Path) -> dict:
    report = read_json(preflight_path)
    current = inspect_runtime(candidate, Path(report['composeEnv']))
    for key in ['apiContainer', 'postgresContainer', 'previousImageId', 'previousImage',
                'previousBuild', 'composeFiles', 'composeHashes', 'composeEnvSha256']:
        require(current.get(key) == report.get(key), 'Runtime/config changed since preflight; do not overwrite another release')
    for path in [credentials, proof]:
        require(path.is_absolute() and path.is_file() and not path.is_symlink()
                and path.stat().st_mode & 0o077 == 0, 'Use existing protected credential/proof files')
    ownership = read_json(proof)
    require(ownership.get('bucket') == 'kabanda' and ownership.get('verificationMethod') == 'yandex-console',
            'Expected the existing verified console ownership proof')
    require(ownership.get('publicAccess') == {'read': True, 'list': True, 'configRead': False},
            'Public static-only access proof is missing')
    try:
        verified = datetime.fromisoformat(ownership['verifiedAt'].replace('Z', '+00:00'))
        age = (datetime.now(timezone.utc) - verified).total_seconds()
    except (KeyError, ValueError, TypeError) as exc:
        raise GateError('Ownership proof timestamp is invalid') from exc
    require(0 <= age < 24 * 3600, 'Ownership proof expired; actual authorized console verification is required, not a date edit')
    new_directory(output)
    rollback = output / 'api.rollback.json'
    write_new(rollback, {'services': {'api': {'image': report['previousImage'], 'pull_policy': 'never',
        'environment': {'API_BUILD_ID': report['previousBuild'], 'EXPECTED_MIGRATION': MIGRATION}}}})
    compose = ['docker', 'compose', '--project-name', 'kabanda', '--env-file', report['composeEnv']]
    for name in report['composeFiles']:
        compose += ['-f', name]
    activate = [*compose, '-f', str(candidate / 'api.override.json')]
    undo = [*compose, '-f', str(rollback)]
    publication = ['python3', str(candidate / 'source/infra/yandex/publish_static.py'),
        '--directory', str(candidate / 'source/apps/pwa/dist'), '--release-sha', SOURCE,
        '--credentials', str(credentials), '--console-ownership-proof', str(proof),
        '--bucket-public-read', '--snapshot-dir', '/var/backups/kabanda/static', '--apply']
    q = shlex.join
    commands = {
        'status': 'COMMANDS_ONLY_NOT_EXECUTED', 'sourceSha': SOURCE,
        'recheck': q(['python3', str(HERE / 'stages_1_5.py'), 'inspect', '--candidate', str(candidate),
            '--compose-env', report['composeEnv'], '--report', str(output / 'immediately-before-apply.json')]),
        'validateCompose': q([*activate, 'config', '--quiet']),
        'activateApiOnly': q([*activate, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'api']),
        'probeApiAndRelay': q([*activate, 'exec', '-T', 'api', 'node', '--input-type=module'])
            + ' < ' + shlex.quote(str(candidate / 'source/infra/yandex/probe_runtime.mjs')),
        'publishStaticAfterApiPass': q(publication),
        'smokeStatic': q(['python3', str(HERE / 'stages_1_5.py'), 'smoke', '--candidate', str(candidate)]),
        'rollbackApiOnly': q([*undo, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'api']),
        'previousImageId': report['previousImageId'], 'previousBuild': report['previousBuild'],
        'warning': 'Owner authorization and one serialized operator required. Preserve old PWA dist before apply. API rollback is not frontend rollback. Never run fixtures/migrations or clear client data.',
    }
    write_new(output / 'commands.json', commands)
    write_new(output / 'COMMANDS.md', '# Generated commands (not executed)\n\n'
        + commands['warning'] + '\n\n'
        + '\n\n'.join('## ' + key + '\n```sh\n' + commands[key] + '\n```' for key in
            ['recheck', 'validateCompose', 'activateApiOnly', 'probeApiAndRelay', 'publishStaticAfterApiPass', 'smokeStatic', 'rollbackApiOnly']) + '\n')
    return {'status': 'COMMANDS_RENDERED_NOT_DEPLOYED', 'directory': str(output), 'sourceSha': SOURCE}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        raise GateError('Static smoke refused a redirect')


def static_smoke(candidate: Path) -> dict:
    report = verify_candidate(candidate)
    html = (candidate / 'source/apps/pwa/dist/index.html').read_text()
    assets = re.findall(r'(?:src|href)=["\'](/assets/[^"\']+\.(?:js|css))["\']', html)
    require(bool(assets), 'Frontend shell contains no hashed assets')
    requests = {'/app': ('index.html', 'no-store'),
                '/manifest.webmanifest': ('manifest.webmanifest', 'no-store'),
                '/sw.js': ('sw.js', 'no-store'),
                '/sw-build-' + SOURCE[:12] + '.js': ('sw-build-' + SOURCE[:12] + '.js', 'immutable'),
                '/lab/index.html': ('lab/index.html', 'no-store')}
    requests.update({path: (path.lstrip('/'), 'immutable') for path in assets})
    opener = build_opener(ProxyHandler({}), NoRedirect())
    for path, (file, cache) in requests.items():
        require(path.startswith(('/app', '/manifest.', '/sw', '/lab/', '/assets/'))
                and not any(char in path for char in ['?', '#', '%', '\\']) and '..' not in path, 'Unsafe static asset path')
        require(file in report['pwaFiles'], 'Unknown static artifact')
        request = Request(ORIGIN + path, headers={'Cache-Control': 'no-cache'})
        with opener.open(request, timeout=15) as response:
            require(response.status == 200, 'Static smoke returned an unexpected status')
            body = response.read(16 * 1024 * 1024 + 1)
            require(len(body) <= 16 * 1024 * 1024 and hashlib.sha256(body).hexdigest() == report['pwaFiles'][file],
                    'Published bytes differ from the prepared frontend')
            require(cache in response.headers.get('Cache-Control', ''), 'Unexpected public cache policy')
    return {'status': 'STATIC_SMOKE_PASS', 'origin': ORIGIN, 'sourceSha': SOURCE, 'objectsChecked': len(requests),
            'authenticatedScenarios': 'not checked by static smoke'}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    verify = commands.add_parser('verify'); verify.add_argument('--repo', required=True); verify.add_argument('--github', action='store_true')
    prep = commands.add_parser('prepare')
    for name in ['repo', 'output', 'public-config', 'node-image']:
        prep.add_argument('--' + name, required=True)
    check = commands.add_parser('inspect')
    check.add_argument('--candidate', required=True); check.add_argument('--compose-env', required=True); check.add_argument('--report', required=True)
    render = commands.add_parser('render')
    for name in ['candidate', 'preflight', 'credentials', 'ownership-proof', 'output']:
        render.add_argument('--' + name, required=True)
    smoke = commands.add_parser('smoke'); smoke.add_argument('--candidate', required=True)
    args = parser.parse_args()
    if args.command == 'verify':
        result = verify_source(Path(args.repo).resolve())
        if args.github:
            result['ci'] = verify_ci()
    elif args.command == 'prepare':
        result = prepare(args)
    elif args.command == 'smoke':
        result = static_smoke(Path(args.candidate).resolve())
    elif args.command == 'render':
        result = render_commands(Path(args.candidate).resolve(), Path(args.preflight).resolve(),
            Path(args.credentials).absolute(), Path(args.ownership_proof).absolute(), Path(args.output).absolute())
    else:
        result = inspect_runtime(Path(args.candidate).resolve(), Path(args.compose_env).absolute())
        write_new(Path(args.report), result)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except GateError as error:
        print('STOP: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, KeyError, TypeError):
        # Deliberately no raw exception/traceback: external tools can echo credentials.
        print('STOP: release gate failed. No deployment was performed. Check inputs and the failed step locally; do not bypass the gate or expose secrets.', file=sys.stderr)
        sys.exit(1)
