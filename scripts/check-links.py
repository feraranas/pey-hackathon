#!/usr/bin/env python3
"""Verifica enlaces e imágenes locales en los Markdown del repositorio.

Comprueba que cada destino relativo exista y que cada ancla (#...) corresponda
a un encabezado del archivo destino, usando la regla de anclas de GitHub.
No consulta enlaces externos (http/https).
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LINK = re.compile(r'!?\[[^\]]*\]\(([^)\s]+)\)')
FENCE = re.compile(r'^(```|~~~)')


def slug(text: str) -> str:
    text = re.sub(r'`', '', text.strip().lower())
    text = re.sub(r'[^\w\s-]', '', text, flags=re.UNICODE)
    return re.sub(r'\s', '-', text)


def headings(path: pathlib.Path) -> set:
    found, seen, fenced = set(), {}, False
    for line in path.read_text(encoding='utf-8').splitlines():
        if FENCE.match(line):
            fenced = not fenced
            continue
        m = None if fenced else re.match(r'^#{1,6}\s+(.*)$', line)
        if m:
            s = slug(m.group(1))
            n = seen.get(s, 0)
            found.add(s if n == 0 else f'{s}-{n}')
            seen[s] = n + 1
    return found


def links(path: pathlib.Path):
    fenced = False
    for no, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
        if FENCE.match(line):
            fenced = not fenced
            continue
        if not fenced:
            for m in LINK.finditer(line):
                yield no, m.group(1)


errors, count = [], 0
for md in sorted(ROOT.rglob('*.md')):
    if 'node_modules' in md.parts or '.git' in md.parts:
        continue
    for no, target in links(md):
        if re.match(r'^[a-z]+:', target):
            continue
        count += 1
        file_part, _, frag = target.partition('#')
        dest = (md.parent / file_part).resolve() if file_part else md
        if not dest.exists():
            errors.append(f'{md.relative_to(ROOT)}:{no}: no existe {target}')
            continue
        if frag and dest.suffix == '.md' and frag not in headings(dest):
            errors.append(f'{md.relative_to(ROOT)}:{no}: ancla inexistente {target}')

for e in errors:
    print(e)
print(f'{count} enlaces locales revisados, {len(errors)} errores')
sys.exit(1 if errors else 0)
