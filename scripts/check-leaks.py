#!/usr/bin/env python3
"""Busca secretos filtrados en los archivos del repo. Nunca imprime un valor.

Dos chequeos:
  1. Valores EXACTOS de tus secretos: los lee del Llavero (los NOMBRES salen de
     secrets.manifest) y, con --env-from-stdin, también de líneas NOMBRE=valor
     que le pases por stdin (por ejemplo el .dev.vars de la Pi por ssh).
  2. Patrones de credenciales conocidas (keys de OpenRouter, Google, Notion,
     GitHub, claves privadas, asignaciones tipo TOKEN="...").

Uso:
  python3 -I scripts/check-leaks.py                 # todo el repo (archivos de git, o todos si no hay git)
  python3 -I scripts/check-leaks.py --staged        # solo lo que está en stage (hook pre-commit)
  ssh pi 'cat ~/apollo-server/.dev.vars' | python3 -I scripts/check-leaks.py --env-from-stdin

Sale con 1 si encuentra algo.
"""
import base64
import binascii
import os
import pathlib
import re
import subprocess
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
SERVICE = os.environ.get('JARVIS_KEYCHAIN_SERVICE', 'jarvis')
MIN_SECRET_LENGTH = 8

# Valores de configuración que no son secretos aunque vengan en un .env.
NOT_SECRET_PREFIXES = ('OPENROUTER_', 'TTS_', 'PIPER_', 'ROUTER_', 'SPEAKER_URL', 'SPEAKER_ROUTE',
                       'AZURE_SPEECH_REGION', 'AZURE_SPEECH_VOICE', 'CONVERSATION_MODE', 'PERSONAJES',
                       'APOLLO_DEVICE_NAME', 'WAHA_URL', 'WAHA_SESSION', 'ELEVENLABS_TTS_MODEL')
NOT_SECRET_EXCEPTIONS = ('OPENROUTER_API_KEY', 'ROUTER_JEV_API_KEY')

PATTERNS = [
    ('key de OpenRouter', re.compile(rb'sk-or-v1-[0-9a-f]{20,}')),
    ('key de Google', re.compile(rb'AIza[0-9A-Za-z_-]{35}')),
    ('token de Notion', re.compile(rb'\b(ntn|secret)_[0-9A-Za-z]{30,}')),
    ('token de GitHub', re.compile(rb'\bgh[pousr]_[0-9A-Za-z]{30,}')),
    ('key de Slack', re.compile(rb'\bxox[abposr]-[0-9A-Za-z-]{10,}')),
    ('clave privada', re.compile(rb'-----BEGIN [A-Z ]*PRIVATE KEY-----\s*\n\s*[A-Za-z0-9+/]{20,}')),
    ('secreto de cliente OAuth', re.compile(rb'GOCSPX-[0-9A-Za-z_-]{20,}')),
    ('asignación de secreto', re.compile(
        rb'''\b[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|API_KEY|_KEY)[A-Z0-9_]*\s*[=:]\s*["']?(?P<value>[A-Za-z0-9+/_.-]{20,})''')),
]

# Un valor hecho solo de palabras o de números ("lastTelemetrySnapshot",
# "token-de-prueba-123456") es un nombre o un valor de prueba, no una key. Las
# keys reales mezclan letras y dígitos dentro del mismo tramo.
WORDS_ONLY = re.compile(rb'(?:[A-Za-z]+|[0-9]+)(?:[-_./](?:[A-Za-z]+|[0-9]+))*')


def looks_like_key(match: re.Match) -> bool:
    value = match.groupdict().get('value')
    return value is None or WORDS_ONLY.fullmatch(value) is None


def list_files(staged: bool) -> list[pathlib.Path]:
    try:
        if staged:
            command = ['git', 'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
        else:
            command = ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard']
        output = subprocess.run(command, cwd=REPO_ROOT, capture_output=True, check=True).stdout
        names = [name for name in output.decode().split('\0') if name]
    except (subprocess.CalledProcessError, FileNotFoundError):
        names = [str(path.relative_to(REPO_ROOT)) for path in REPO_ROOT.rglob('*')
                 if path.is_file() and '.git' not in path.parts]
    return [REPO_ROOT / name for name in names if (REPO_ROOT / name).is_file()]


def manifest_names() -> list[str]:
    names = []
    for line in (REPO_ROOT / 'secrets.manifest').read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if line and not line.startswith('#'):
            names.append(line.split()[0])
    return names


def keychain_secrets() -> dict[str, bytes]:
    if sys.platform != 'darwin':
        return {}
    found = {}
    for name in manifest_names():
        result = subprocess.run(['security', 'find-generic-password', '-s', SERVICE, '-a', name, '-w'],
                                capture_output=True, check=False)
        value = result.stdout.strip()
        if result.returncode == 0 and len(value) >= MIN_SECRET_LENGTH:
            found[f'Llavero:{name}'] = value
            if name.endswith('_B64'):
                try:
                    found[f'Llavero:{name} (decodificado)'] = base64.b64decode(value)
                except (ValueError, binascii.Error):
                    pass
    return found


def stdin_secrets() -> dict[str, bytes]:
    found = {}
    for number, raw_line in enumerate(sys.stdin.buffer.read().splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith(b'#') or b'=' not in line:
            continue
        name, _, value = line.partition(b'=')
        name_text = name.decode(errors='replace').strip()
        if name_text.startswith(NOT_SECRET_PREFIXES) and name_text not in NOT_SECRET_EXCEPTIONS:
            continue
        value = value.strip().strip(b'"').strip(b"'")
        if len(value) >= MIN_SECRET_LENGTH:
            found[f'stdin:{name_text} (línea {number})'] = value
    return found


def main() -> int:
    staged = '--staged' in sys.argv
    secrets = keychain_secrets()
    if '--env-from-stdin' in sys.argv:
        secrets.update(stdin_secrets())
    files = list_files(staged)
    problems = []
    for path in files:
        try:
            content = path.read_bytes()
        except OSError:
            continue
        relative = path.relative_to(REPO_ROOT)
        for origin, value in secrets.items():
            if value in content:
                problems.append(f'{relative}: contiene el valor de {origin}')
        if relative.name == 'check-leaks.py':
            continue
        for label, pattern in PATTERNS:
            for match in pattern.finditer(content):
                if not looks_like_key(match):
                    continue
                line_number = content.count(b'\n', 0, match.start()) + 1
                problems.append(f'{relative}:{line_number}: parece {label}')
    print(f'Revisados {len(files)} archivos contra {len(secrets)} valores secretos y {len(PATTERNS)} patrones.')
    if problems:
        print('\n'.join(sorted(set(problems))))
        print('✗ Posibles fugas. Sacalas antes de commitear.')
        return 1
    print('✓ Sin fugas.')
    return 0


sys.exit(main())
