#!/usr/bin/env python3
"""Prepare an exact, green PR #74 release in a NEW directory. Never deploy/migrate."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit

REPO = 'motpavel/kabanda'
BASE = '1d4189fb846ad7a8ea7be38b66c99b413d726a4b'
SCHEMA = '0020_field_sync.sql'
PUBLIC = {'VITE_YANDEX_MAPS_API_KEY', 'VITE_RELAY_BOOTSTRAP_URL', 'VITE_RELAY_PUBLIC_KEY',
          'VITE_RELAY_BLOB_BUCKET', 'VITE_DIRECT_RELAY_URL'}

class Stop(RuntimeError):
    pass

def need(value, message):
    if not value:
        raise Stop(message)

def run(argv, cwd=None, env=None, timeout=60):
    try:
        r = subprocess.run(argv, cwd=cwd, env=env, text=True, capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise Stop(f'{Path(argv[0]).name}: unavailable or timed out; inspect privately') from e
    need(r.returncode == 0, f'{Path(argv[0]).name}: failed; details suppressed, no deployment performed')
    return r.stdout.strip()

def write_new(path, value):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
        f.write(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def settings(path):
    need(path.is_file() and not path.is_symlink() and path.stat().st_size < 32768, 'Invalid public settings file')
    data = json.loads(path.read_text())
    need(isinstance(data, dict) and set(data) == PUBLIC, 'Only the five public VITE settings are allowed; never use api.env')
    need(all(isinstance(v, str) and len(v) < 8192 for v in data.values()), 'Invalid public setting value')
    data = {k: v.strip() for k, v in data.items()}
    need(bool(data['VITE_YANDEX_MAPS_API_KEY']), 'Reuse the existing browser Maps key')
    u = urlsplit(data['VITE_RELAY_BOOTSTRAP_URL'])
    need(u.scheme == 'https' and u.netloc == 'storage.yandexcloud.net' and not u.query and not u.fragment
         and re.fullmatch(r'/[a-z0-9-]+/transport/v1/apps/kabanda/bootstrap\.json', u.path), 'Invalid Kabanda bootstrap URL')
    key = data['VITE_RELAY_PUBLIC_KEY'].replace('\\n', '\n')
    need(key.startswith('-----BEGIN PUBLIC KEY-----\n') and key.endswith('\n-----END PUBLIC KEY-----')
         and 'PRIVATE' not in key, 'Reuse the existing SPKI PUBLIC key, never a private key')
    data['VITE_RELAY_PUBLIC_KEY'] = key
    need(re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', data['VITE_RELAY_BLOB_BUCKET']), 'Invalid private blob bucket')
    if data['VITE_DIRECT_RELAY_URL']:
        u = urlsplit(data['VITE_DIRECT_RELAY_URL'])
        need(u.scheme == 'https' and u.hostname and not u.username and not u.password and not u.query and not u.fragment,
             'Direct Relay URL must not contain credentials')
    return data

def verify(repo, sha, run_id):
    need(re.fullmatch(r'[0-9a-f]{40}', sha), 'Use a full exact SHA, not a branch or latest')
    git = lambda *args: run(['git', '-C', str(repo), *args])
    tree = git('rev-parse', sha + '^{tree}')
    git('merge-base', '--is-ancestor', BASE, sha)
    git('diff', '--exit-code', BASE, sha, '--', 'infra/postgres/migrations')
    migrations = git('ls-tree', '-r', '--name-only', sha, '--', 'infra/postgres/migrations').splitlines()
    migrations = sorted(Path(x).name for x in migrations if x.endswith('.sql'))
    need(len(migrations) == 20 and migrations[-1] == SCHEMA, 'Unexpected schema set')
    prefix = f'repos/{REPO}/actions/runs/{run_id}'
    ci = json.loads(run(['gh', 'api', prefix]))
    jobs = json.loads(run(['gh', 'api', prefix + '/jobs?filter=latest&per_page=100']))
    need(ci.get('id') == run_id and ci.get('head_sha') == sha and ci.get('repository', {}).get('full_name') == REPO
         and ci.get('status') == 'completed' and ci.get('conclusion') == 'success' and ci.get('event') == 'pull_request',
         'CI is not green for this exact application SHA')
    rows = jobs.get('jobs', [])
    need(len(rows) == jobs.get('total_count'), 'Incomplete CI jobs')
    for name in ['verify', 'postgres', 'e2e']:
        match = [r for r in rows if r.get('name') == name]
        need(len(match) == 1 and match[0].get('conclusion') == 'success' and match[0].get('run_id') == run_id,
             f'Missing or unsuccessful CI job {name}')
    pr = json.loads(run(['gh', 'api', f'repos/{REPO}/pulls/74']))
    need(pr['head']['sha'] == sha and pr['base']['sha'] == BASE, 'PR changed since handoff; do not silently use another version')
    return {'repository': REPO, 'sourceSha': sha, 'sourceTree': tree, 'ciRun': run_id,
            'expectedMigration': SCHEMA, 'migrations': migrations}

def prepare(args):
    repo = Path(args.repo).resolve()
    report = verify(repo, args.sha, args.run)
    public = settings(Path(args.public_config))
    need(re.fullmatch(r'node:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}', args.node_image), 'Node base must be pinned by digest')
    need(run(['node', '--version']).startswith('v22.'), 'Node 22 required; do not change host packages automatically')
    need(run(['pnpm', '--version']) == '11.19.0', 'pnpm 11.19.0 required')
    image = 'kabanda-api:field-' + args.sha
    need(not run(['docker', 'image', 'ls', '--quiet', '--no-trunc', image]), 'Candidate image tag already exists; do not overwrite')
    out = Path(args.output).absolute()
    need(not out.exists() and not out.is_symlink() and out.parent.is_dir(), 'Use a NEW directory under an existing parent')
    out.mkdir(mode=0o700)
    home = out / 'build-home'; home.mkdir(mode=0o700)
    source = out / 'source'
    run(['git', 'clone', '--no-hardlinks', '--no-checkout', '--', str(repo), str(source)], timeout=180)
    run(['git', '-C', str(source), 'checkout', '--detach', args.sha])
    env = {'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'), 'HOME': str(home), 'CI': 'true',
           'LANG': 'C.UTF-8', 'GITHUB_SHA': args.sha, 'VITE_APP_BASE': '/', **public}
    print('Building isolated frontend and API image. No service/cloud changes.', flush=True)
    run(['pnpm', 'install', '--frozen-lockfile'], cwd=source, env=env, timeout=900)
    run(['pnpm', '--filter', '@kabanda/pwa', 'build'], cwd=source, env={**env, 'NODE_ENV': 'production'}, timeout=900)
    run(['python3', 'infra/yandex/publish_static.py', '--directory', 'apps/pwa/dist', '--release-sha', args.sha], cwd=source)
    run(['docker', 'build', '--platform', 'linux/amd64', '--build-arg', 'NODE_IMAGE=' + args.node_image,
         '--label', 'org.opencontainers.image.revision=' + args.sha,
         '-f', 'infra/yandex/Dockerfile.api', '-t', image, '.'], cwd=source, timeout=1800)
    need(not run(['git', '-C', str(source), 'status', '--porcelain', '--untracked-files=all']), 'Build changed tracked source')
    image_id = run(['docker', 'image', 'inspect', '--format', '{{.Id}}', image])
    need(re.fullmatch(r'sha256:[0-9a-f]{64}', image_id), 'Invalid candidate image ID')
    files = {}
    dist = source / 'apps/pwa/dist'
    for path in sorted(dist.rglob('*')):
        need(not path.is_symlink(), 'Symlink in build output')
        if path.is_file():
            files[path.relative_to(dist).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    need('index.html' in files and 'sw.js' in files and 'sw-build-' + args.sha[:12] + '.js' in files, 'Incomplete PWA')
    report.update({'status': 'PREPARED_NOT_DEPLOYED', 'apiImage': image, 'apiImageId': image_id,
                   'nodeImage': args.node_image, 'pwaSha256': files})
    write_new(out / 'public-build.json', public)
    write_new(out / 'candidate.json', report)
    write_new(out / 'api.override.json', {'services': {'api': {'image': image, 'pull_policy': 'never',
        'environment': {'API_BUILD_ID': args.sha, 'EXPECTED_MIGRATION': SCHEMA}}}})
    return report

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['verify', 'prepare'])
    p.add_argument('--repo', required=True); p.add_argument('--sha', required=True); p.add_argument('--run', type=int, required=True)
    p.add_argument('--output'); p.add_argument('--public-config'); p.add_argument('--node-image')
    args = p.parse_args()
    if args.command == 'prepare':
        need(all([args.output, args.public_config, args.node_image]), 'Prepare needs output, public-config and node-image')
        report = prepare(args)
    else:
        report = verify(Path(args.repo).resolve(), args.sha, args.run)
    print(json.dumps(report, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    try:
        main()
    except (Stop, OSError, ValueError, KeyError, TypeError) as e:
        print('STOP: ' + (str(e) if isinstance(e, Stop) else 'Invalid input; details suppressed to protect credentials'), file=sys.stderr)
        sys.exit(1)
