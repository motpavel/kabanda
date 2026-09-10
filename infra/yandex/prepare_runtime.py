#!/usr/bin/env python3
"""Prepare private target-only Compose/API env files; never transfer data or start services."""

import argparse
import json
import os
from pathlib import Path
import re
import stat
import sys
from urllib.parse import quote, urlsplit

PRESERVED = {
    'ALPHA_ACCESS_MODE', 'ALPHA_ACCESS_SECRET', 'MEDIA_CAPABILITY_SECRET',
    'SESSION_TTL_DAYS', 'MAGIC_LINK_TTL_MINUTES', 'ALPHA_DIAGNOSTICS_ENABLED',
    'SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM', 'SMTP_SECURE', 'SMTP_REQUIRE_TLS',
    'SMTP_USER', 'SMTP_PASSWORD', 'NOMINATIM_BASE_URL',
}
REQUIRED = {
    'ALPHA_ACCESS_MODE', 'ALPHA_ACCESS_SECRET', 'MEDIA_CAPABILITY_SECRET',
    'SESSION_TTL_DAYS', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM',
}


def env_line(name, value):
    """Compose literal single quotes preserve dollar signs; no shell evaluation."""
    if not isinstance(value, str) or any(c in value for c in '\r\n\0'):
        raise ValueError(f'Invalid single-line value for {name}')
    # Reject the uncommon ambiguous trailing backslash instead of changing a secret.
    if value.endswith('\\'):
        raise ValueError(f'Trailing backslash requires explicit configuration for {name}')
    return name + "='" + value.replace("'", "\\'") + "'\n"


def read_secret(path):
    data = path.read_text().strip()
    if len(data) < 32 or any(c in data for c in '\r\n\0'):
        raise ValueError(f'Invalid prepared secret file: {path.name}')
    return data


def private_file(path):
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise ValueError(f'Expected an owner-only regular file: {path.name}')


def prepare(args):
    config_dir = Path(args.config_dir).resolve()
    info = config_dir.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077:
        raise ValueError('The target configuration directory must be private (0700)')
    source_path = Path(args.source_config_json)
    private_file(source_path)
    source = json.loads(source_path.read_text())
    if not isinstance(source, dict) or not REQUIRED.issubset(source):
        raise ValueError('Transferred source configuration is missing required preserved fields')
    source = {key: value for key, value in source.items() if key in PRESERVED}
    for key, value in source.items():
        env_line(key, value)
    if source['ALPHA_ACCESS_MODE'] != 'enforced':
        raise ValueError('The preserved closed-alpha access mode must remain enforced')
    if any(len(source[key]) < 32 for key in ['ALPHA_ACCESS_SECRET', 'MEDIA_CAPABILITY_SECRET']):
        raise ValueError('The preserved access/media secrets are incomplete')
    if not source['SESSION_TTL_DAYS'].isdigit() or not 1 <= int(source['SESSION_TTL_DAYS']) <= 90:
        raise ValueError('Invalid preserved session lifetime')
    origin = urlsplit(args.app_origin)
    if origin.scheme != 'https' or not origin.hostname or origin.path or origin.query or origin.fragment or origin.username:
        raise ValueError('Expected a canonical HTTPS application origin')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', args.blob_bucket):
        raise ValueError('Invalid relay blob bucket')
    if not re.fullmatch(r'[0-9a-f]{40}', args.build_id):
        raise ValueError('Expected the full committed source SHA')
    if not re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', args.database_user):
        raise ValueError('Invalid destination application role')
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._/:@-]+', args.image):
        raise ValueError('Invalid API image reference')

    for name in ['database-app-password', 'relay-session-secret', 'postgres-admin-password',
                 'relay-private-key.pem', 'relay-s3-credentials.json']:
        private_file(config_dir / name)
    password = read_secret(config_dir / 'database-app-password')
    session_secret = read_secret(config_dir / 'relay-session-secret')
    database_url = f'postgresql://{args.database_user}:{quote(password, safe="")}@127.0.0.1:54329/kabanda'
    api = {
        **source,
        'NODE_ENV': 'production',
        'APP_ORIGIN': args.app_origin,
        'APP_BASE_PATH': '/',
        'API_BUILD_ID': args.build_id,
        'EXPECTED_MIGRATION': '0018_raid_destination.sql',
        'RELAY_SESSION_SECRET': session_secret,
        'RELAY_BLOB_BUCKET': args.blob_bucket,
    }
    compose = {
        'KABANDA_API_IMAGE': args.image,
        'KABANDA_API_ENV_FILE': str(config_dir / 'api.env'),
        'KABANDA_DATABASE_URL': database_url,
        'KABANDA_POSTGRES_PASSWORD_FILE': str(config_dir / 'postgres-admin-password'),
        'KABANDA_RELAY_PRIVATE_KEY_FILE': str(config_dir / 'relay-private-key.pem'),
        'KABANDA_RELAY_S3_CREDENTIALS_FILE': str(config_dir / 'relay-s3-credentials.json'),
        'KABANDA_NODE_IMAGE': 'node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5',
        'KABANDA_POSTGIS_IMAGE': args.postgis_image,
    }
    files = {config_dir / 'api.env': api, config_dir / 'compose.env': compose}
    rendered = {path: ''.join(env_line(key, value) for key, value in values.items()) for path, values in files.items()}
    summary = {
        'mode': 'apply' if args.apply else 'dry-run',
        'files': [str(path) for path in rendered],
        'app_origin': args.app_origin,
        'build_id': args.build_id,
        'image': args.image,
        'database_endpoint': '127.0.0.1:54329/kabanda',
        'database_role': args.database_user,
        'smtp_is_loopback': source['SMTP_HOST'] in ['127.0.0.1', 'localhost', '::1'],
        'preserved_fields': sorted(source),
    }
    return rendered, summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-config-json', required=True, help='Already approved/transferred private JSON; never fetched by this script')
    parser.add_argument('--config-dir', default='/etc/kabanda')
    parser.add_argument('--app-origin', required=True)
    parser.add_argument('--blob-bucket', required=True)
    parser.add_argument('--build-id', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--database-user', default='kabanda_app')
    parser.add_argument('--postgis-image', default='postgis/postgis:16-3.5')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        files, summary = prepare(args)
        if args.apply:
            if os.geteuid() != 0:
                raise ValueError('Writing the target configuration requires root')
            if Path(args.config_dir).resolve().stat().st_uid != 0:
                raise ValueError('The target configuration directory must be owned by root')
            if any(path.exists() for path in files):
                raise ValueError('Target environment files already exist; refusing to overwrite them')
            created = []
            try:
                for path, contents in files.items():
                    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    created.append(path)
                    with os.fdopen(fd, 'w') as output:
                        output.write(contents)
                        output.flush()
                        os.fsync(output.fileno())
            except Exception:
                for path in created:
                    path.unlink(missing_ok=True)
                raise
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    except (ValueError, OSError, json.JSONDecodeError) as error:
        # No source values, passwords, database URLs or generated file contents.
        print(f'Runtime configuration not prepared: {type(error).__name__}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
