#!/usr/bin/env python3
"""Render the recorded simulation transcript, without imitating a live WhatsApp capture."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import textwrap
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[1]
out = root / 'docs' / 'verification'
node = str(root / 'node_modules' / 'node' / 'bin' / 'node')
if not Path(node).exists():
    node = shutil.which('node')
subprocess.run([node, '--import', 'tsx', 'src/demo.ts'], cwd=root,
               env={**os.environ, 'DEMO_ARTIFACT_DIR': str(out)}, check=True)
lines = (out / 'demo.txt').read_text().splitlines()
font = os.environ.get('DEMO_FONT', '/System/Library/Fonts/Menlo.ttc')
if not Path(font).exists():
    font = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
with tempfile.TemporaryDirectory(prefix='pey-demo-video-') as temp:
    directory = Path(temp)
    pages = []
    current = []
    for line in lines:
        wrapped = textwrap.wrap(line, 82, break_long_words=True, replace_whitespace=True)
        if len(current) + len(wrapped) + 1 > 18:
            pages.append(current)
            current = []
        current.extend(wrapped + [''])
    if current:
        pages.append(current)
    segments = []
    for index, page in enumerate(pages):
        text = directory / f'{index}.txt'
        text.write_text('PEY MVP | SIMULACION\nSalida real de npm run demo. Sin pagos reales.\n\n' + '\n'.join(page))
        video = directory / f'{index}.mp4'
        frame = directory / f'{index}.png'
        canvas = Image.new('RGB', (1440, 900), '#101c2c')
        draw = ImageDraw.Draw(canvas)
        face = ImageFont.truetype(font, 23)
        draw.multiline_text((48, 42), text.read_text().replace('🤖', '[BOT]'), font=face, fill='#e6edf3', spacing=9)
        canvas.save(frame)
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-i', str(frame),
                        '-t', '10', '-r', '24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(video)], check=True)
        segments.append(video)
    manifest = directory / 'concat.txt'
    manifest.write_text('\n'.join(f"file '{path}'" for path in segments))
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0',
                    '-i', str(manifest), '-c', 'copy', '-movflags', '+faststart', str(out / 'demo.mp4')], check=True)
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(out / 'demo.mp4'),
                    '-frames:v', '1', str(out / 'demo-preview.png')], check=True)
print(f'Video creado: {out / "demo.mp4"}')
