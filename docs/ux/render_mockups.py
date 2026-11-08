#!/usr/bin/env python3
"""Renderiza las maquetas de WhatsApp (iOS) definidas en screens.json.

Uso:
    python3 render_mockups.py [--out DIR] [--zip RUTA.zip]

Requiere Pillow y qrcode (pip install pillow qrcode). Fuentes: Inter (variable)
y Noto Color Emoji; se pueden cambiar con las variables MOCKUP_FONT y
MOCKUP_EMOJI_FONT. Todo el texto de las pantallas sale de screens.json.
Las maquetas son ilustrativas: no se conecta nada ni se envía nada.
"""
import argparse
import json
import math
import os
import random
import re
import unicodedata
import zipfile
from functools import lru_cache
from pathlib import Path

import qrcode
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
S = 2                      # escala: 393x852 pt -> 786x1704 px
W, H = 393, 852
FONT = os.environ.get('MOCKUP_FONT', '/usr/share/fonts/truetype/sand-box/google/Inter/Inter-VariableFont_opsz,wght.ttf')
EMOJI = os.environ.get('MOCKUP_EMOJI_FONT', '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf')

# Paleta aproximada de WhatsApp iOS (tema claro)
WALL = (239, 234, 226)
DOODLE = (225, 217, 205)
OUT_BUBBLE = (217, 253, 211)
IN_BUBBLE = (255, 255, 255)
TEXT = (17, 27, 33)
META = (102, 119, 129)
TICK = (83, 189, 235)
LINK = (2, 126, 181)
BAR = (246, 246, 246)
GREEN = (37, 211, 102)
DARKGREEN = (0, 128, 105)
SEP = (222, 222, 222)
ICON = (17, 17, 17)

TEXT_SIZE = 16.0
LINE = 21.5
META_SIZE = 11.0
BUBBLE_MAX = 292
PAD_X, PAD_Y = 10, 7
HEADER_BOTTOM = 104
INPUT_TOP = 852 - 84

# Modo limpio (presentación): sin marcas de maqueta ni avisos dentro de las pantallas.
# Los enlaces y los QR siguen apuntando a dominios reservados (.example / .invalid).
# Los ajustes del modo limpio (textos, enlace y QR de presentación) están en presentation.json.
CLEAN = os.environ.get('MOCKUP_CLEAN') == '1'
PRESENTATION = json.loads((HERE / 'presentation.json').read_text(encoding='utf-8'))


def apply_clean(spec):
    """Aplica presentation.json sobre screens.json cuando CLEAN está activo."""
    if not CLEAN:
        return spec
    pr = PRESENTATION
    byid = {sc['id']: sc for sc in spec['screens']}
    hidden = []
    for hid, h in pr.get('hidden_screens', {}).items():
        sc = json.loads(json.dumps(byid[h['from']]))
        sc['id'], sc['hidden'] = hid, True
        hidden.append(sc)
    for ref, ov in pr.get('message_overrides', {}).items():
        sid, idx = ref.split(':')
        byid[sid]['messages'][int(idx)].update(ov)
    for sid, ov in pr.get('screen_overrides', {}).items():
        sc = byid[sid]
        for k in ('rows', 'page', 'messages', 'header'):
            sc.pop(k, None)
        sc.update(json.loads(json.dumps(ov)))
    for sc in spec['screens'] + hidden:
        for m in sc.get('messages', []):
            for k in ('text', 'caption'):
                if k in m:
                    for a, b in pr['replace_text'].items():
                        m[k] = m[k].replace(a, b)
            if m.get('preview'):
                m['preview']['domain'] = pr['link_domain']
        if sc.get('page'):
            sc['page']['domain'] = pr['link_domain']
    spec['screens'] = hidden + spec['screens']
    return spec


@lru_cache(maxsize=None)
def qr_asset():
    return Image.open(HERE / PRESENTATION['qr_asset']).convert('RGBA')


EMOJI_RE = re.compile('([\U0001F300-\U0001FAFF\u2600-\u27BF\u2B50\u2B55]\uFE0F?)')


def p(v):
    return int(round(v * S))


@lru_cache(maxsize=None)
def font(size, weight=400):
    f = ImageFont.truetype(FONT, p(size))
    try:
        f.set_variation_by_axes([min(32, max(14, size)), weight])
    except Exception:
        pass
    return f


@lru_cache(maxsize=None)
def emoji_img(ch, size):
    ef = ImageFont.truetype(EMOJI, 109)
    im = Image.new('RGBA', (160, 160), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((8, 8), ch, font=ef, embedded_color=True)
    bbox = im.getbbox()
    if not bbox:
        return None
    im = im.crop(bbox)
    h = p(size * 1.12)
    return im.resize((max(1, round(im.width * h / im.height)), h), Image.LANCZOS)


def split_emoji(text):
    return [t for t in EMOJI_RE.split(text) if t]


def is_emoji(t):
    return bool(EMOJI_RE.fullmatch(t))


def run_width(text, size, weight):
    w = 0
    for part in split_emoji(text):
        if is_emoji(part):
            e = emoji_img(part, size)
            w += (e.width if e else 0) + p(3)
        else:
            w += font(size, weight).getlength(part)
    return w / S


def draw_run(img, x, y, text, size, weight, color, underline=False):
    """Dibuja texto (en pt) con emoji a color. y es el tope de la línea."""
    d = ImageDraw.Draw(img)
    cx = p(x)
    f = font(size, weight)
    ascent = f.getmetrics()[0]
    for part in split_emoji(text):
        if is_emoji(part):
            e = emoji_img(part, size)
            if e:
                img.alpha_composite(e, (int(cx + p(1.5)), int(p(y) + ascent - e.height * 0.86)))
                cx += e.width + p(3)
        else:
            d.text((cx, p(y)), part, font=f, fill=color)
            wpart = f.getlength(part)
            if underline:
                uy = p(y) + ascent + p(1.5)
                d.line([(cx, uy), (cx + wpart, uy)], fill=color, width=max(1, p(0.8)))
            cx += wpart
    return cx / S


# ---------- texto enriquecido estilo WhatsApp: *negrita*, enlaces ----------

def parse_line(line):
    tokens = []
    for seg in re.split(r'(https?://\S+)', line):
        if not seg:
            continue
        if re.match(r'https?://', seg):
            tokens.append((seg, 'link'))
            continue
        for i, chunk in enumerate(re.split(r'\*([^*]+)\*', seg)):
            if chunk:
                tokens.append((chunk, 'bold' if i % 2 else 'reg'))
    return tokens


STYLE = {'reg': (400, TEXT, False), 'bold': (650, TEXT, False), 'link': (400, LINK, True)}


def wrap(text, maxw, size=TEXT_SIZE):
    """Devuelve líneas; cada línea es lista de (texto, estilo)."""
    out = []
    for raw in text.split('\n'):
        words = []
        for tok, st in parse_line(raw):
            for w in re.findall(r'\S+\s*|\s+', tok):
                words.append((w, st))
        line, lw = [], 0.0
        for w, st in words:
            ww = run_width(w, size, STYLE[st][0])
            wtrim = run_width(w.rstrip(), size, STYLE[st][0])
            if line and lw + wtrim > maxw:
                out.append(line)
                line, lw = [], 0.0
                w = w.lstrip()
                ww = run_width(w, size, STYLE[st][0])
            if not line and wtrim > maxw:   # palabra larga (URL): cortar por caracteres
                buf = ''
                for ch in w:
                    if run_width(buf + ch, size, STYLE[st][0]) > maxw:
                        out.append([(buf, st)])
                        buf = ''
                    buf += ch
                line, lw = [(buf, st)], run_width(buf, size, STYLE[st][0])
                continue
            line.append((w, st))
            lw += ww
        out.append(line)
    return out


def line_width(line, size=TEXT_SIZE):
    if not line:
        return 0
    total = 0
    for i, (t, st) in enumerate(line):
        t = t.rstrip() if i == len(line) - 1 else t
        total += run_width(t, size, STYLE[st][0])
    return total


def draw_lines(img, x, y, lines, size=TEXT_SIZE, lh=LINE):
    for line in lines:
        cx = x
        for i, (t, st) in enumerate(line):
            wgt, col, und = STYLE[st]
            t2 = t.rstrip() if i == len(line) - 1 else t
            draw_run(img, cx, y + (lh - size * 1.21) / 2, t2, size, wgt, col, und)
            cx += run_width(t, size, wgt)
        y += lh
    return y


def ellipsize(text, maxw, size, weight=400, lines=1):
    words, out, cur = text.split(' '), [], ''
    for w in words:
        trial = (cur + ' ' + w).strip()
        if run_width(trial, size, weight) <= maxw:
            cur = trial
        else:
            out.append(cur)
            cur = w
            if len(out) == lines:
                break
    if len(out) < lines:
        out.append(cur)
        cur = ''
    if cur or len(' '.join(out)) < len(text):
        last = out[-1]
        while last and run_width(last + '…', size, weight) > maxw:
            last = last[:-1]
        if ' '.join(out) != text:
            out[-1] = last.rstrip() + '…'
    return out[:lines]


# ---------- primitivas ----------

def rr(d, box, r, fill, outline=None, width=1):
    d.rounded_rectangle([p(box[0]), p(box[1]), p(box[2]), p(box[3])], radius=p(r), fill=fill, outline=outline, width=width)


def ticks(d, x, y, color=TICK):
    """Doble palomita azul (x,y = esquina inferior izquierda en pt)."""
    for off in (0, 4.2):
        pts = [(x + off, y - 4), (x + off + 2.6, y - 1.2), (x + off + 7.5, y - 8)]
        d.line([(p(a), p(b)) for a, b in pts], fill=color, width=p(1.25), joint='curve')


def avatar(img, cx, cy, r, key, avatars):
    a = avatars[key]
    col = tuple(int(a['color'][i:i + 2], 16) for i in (1, 3, 5))
    d = ImageDraw.Draw(img)
    d.ellipse([p(cx - r), p(cy - r), p(cx + r), p(cy + r)], fill=col)
    size = r * (0.78 if len(a['initials']) == 1 else 0.62)
    f = font(size, 600)
    tw = f.getlength(a['initials']) / S
    asc, desc = f.getmetrics()
    d.text((p(cx - tw / 2), p(cy) - (asc + desc) / 2 + p(size * 0.04)), a['initials'], font=f, fill=(255, 255, 255))


def wallpaper(img, top, bottom, seed=7):
    d = ImageDraw.Draw(img)
    d.rectangle([0, p(top), p(W), p(bottom)], fill=WALL)
    rnd = random.Random(seed)
    lw = max(1, p(1.1))
    step = 46
    for gy in range(int(top) - 20, int(bottom) + 20, step):
        for gx in range(-10, W + 20, step):
            x = gx + rnd.uniform(-8, 8) + (step / 2 if (gy // step) % 2 else 0)
            y = gy + rnd.uniform(-8, 8)
            k = rnd.randrange(7)
            s = rnd.uniform(7, 10)
            if k == 0:   # círculo
                d.ellipse([p(x - s), p(y - s), p(x + s), p(y + s)], outline=DOODLE, width=lw)
            elif k == 1:  # estrella
                pts = []
                for i in range(10):
                    ang = -math.pi / 2 + i * math.pi / 5
                    rad = s if i % 2 == 0 else s * 0.45
                    pts.append((p(x + rad * math.cos(ang)), p(y + rad * math.sin(ang))))
                d.polygon(pts, outline=DOODLE, width=lw)
            elif k == 2:  # corazón
                d.arc([p(x - s), p(y - s * .6), p(x), p(y + s * .3)], 150, 360, fill=DOODLE, width=lw)
                d.arc([p(x), p(y - s * .6), p(x + s), p(y + s * .3)], 180, 30, fill=DOODLE, width=lw)
                d.line([(p(x - s * .93), p(y)), (p(x), p(y + s * .9)), (p(x + s * .93), p(y))], fill=DOODLE, width=lw)
            elif k == 3:  # llave (tuerca)
                d.line([(p(x - s), p(y + s)), (p(x + s * .3), p(y - s * .3))], fill=DOODLE, width=lw)
                d.arc([p(x), p(y - s), p(x + s), p(y)], 200, 520, fill=DOODLE, width=lw)
            elif k == 4:  # nota musical
                d.ellipse([p(x - s * .6), p(y + s * .3), p(x), p(y + s * .8)], outline=DOODLE, width=lw)
                d.line([(p(x), p(y + s * .55)), (p(x), p(y - s)), (p(x + s * .6), p(y - s * .6))], fill=DOODLE, width=lw)
            elif k == 5:  # nube
                d.arc([p(x - s), p(y - s * .3), p(x), p(y + s * .5)], 90, 270, fill=DOODLE, width=lw)
                d.arc([p(x - s * .6), p(y - s * .8), p(x + s * .4), p(y + s * .2)], 180, 0, fill=DOODLE, width=lw)
                d.arc([p(x), p(y - s * .4), p(x + s), p(y + s * .5)], 270, 90, fill=DOODLE, width=lw)
                d.line([(p(x - s * .5), p(y + s * .5)), (p(x + s * .5), p(y + s * .5))], fill=DOODLE, width=lw)
            else:        # rayo
                d.line([(p(x), p(y - s)), (p(x - s * .4), p(y)), (p(x + s * .3), p(y)), (p(x - s * .1), p(y + s))], fill=DOODLE, width=lw)


def status_bar(img, clock, bg):
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, p(W), p(54)], fill=bg)
    f = font(17, 600)
    tw = f.getlength(clock) / S
    d.text((p(66 - tw / 2), p(16)), clock, font=f, fill=ICON)
    # señal
    for i in range(4):
        h = 4 + i * 2.6
        rr(d, (297 + i * 5, 31 - h, 300 + i * 5, 31), 1, ICON)
    # wifi
    cx, cy = 327, 31
    for r in (11, 7.5, 4):
        d.pieslice([p(cx - r), p(cy - r), p(cx + r), p(cy + r)], 225, 315, fill=ICON)
        d.pieslice([p(cx - r + 1.7), p(cy - r + 1.7), p(cx + r - 1.7), p(cy + r - 1.7)], 225, 315, fill=bg)
    d.pieslice([p(cx - 3), p(cy - 3), p(cx + 3), p(cy + 3)], 225, 315, fill=ICON)
    # batería
    rr(d, (343, 20.5, 369, 32.5), 3.6, None, outline=(150, 150, 150), width=p(1))
    rr(d, (345, 22.5, 367, 30.5), 2.2, ICON)
    rr(d, (370.5, 24.5, 372, 28.5), 0.8, (150, 150, 150))


def home_indicator(img, color=ICON):
    d = ImageDraw.Draw(img)
    rr(d, (W / 2 - 67, H - 9, W / 2 + 67, H - 4), 2.5, color)


# ---------- iconos ----------

def icon_back(d, x, y):
    d.line([(p(x + 7), p(y - 9)), (p(x), p(y)), (p(x + 7), p(y + 9))], fill=ICON, width=p(2.2), joint='curve')


def icon_video(d, x, y):
    rr(d, (x, y - 8, x + 17, y + 8), 3.5, None, outline=ICON, width=p(1.7))
    d.polygon([(p(x + 19), p(y - 2.5)), (p(x + 26), p(y - 7)), (p(x + 26), p(y + 7)), (p(x + 19), p(y + 2.5))], outline=ICON, width=p(1.7))


def icon_phone(d, x, y):
    pts = [(x + 2, y - 9), (x + 6, y - 10), (x + 8, y - 5), (x + 5.5, y - 3), (x + 9.5, y + 3.5), (x + 13, y + 6.5),
           (x + 15, y + 4), (x + 20, y + 6), (x + 19, y + 10), (x + 15, y + 11), (x + 6, y + 5), (x + 1, y - 3)]
    d.polygon([(p(a), p(b)) for a, b in pts], outline=ICON, width=p(1.6))


def icon_plus(d, x, y, s=10, w=1.9, color=ICON):
    d.line([(p(x - s), p(y)), (p(x + s), p(y))], fill=color, width=p(w))
    d.line([(p(x), p(y - s)), (p(x), p(y + s))], fill=color, width=p(w))


def icon_camera(d, x, y, color=ICON):
    rr(d, (x - 12, y - 8, x + 12, y + 9), 4, None, outline=color, width=p(1.7))
    rr(d, (x - 5, y - 11, x + 5, y - 7.5), 1.5, color)
    d.ellipse([p(x - 5), p(y - 4), p(x + 5), p(y + 6)], outline=color, width=p(1.7))


def icon_mic(d, x, y):
    rr(d, (x - 4.5, y - 11, x + 4.5, y + 3), 4.5, None, outline=ICON, width=p(1.7))
    d.arc([p(x - 8), p(y - 6), p(x + 8), p(y + 8)], 0, 180, fill=ICON, width=p(1.7))
    d.line([(p(x), p(y + 8)), (p(x), p(y + 12))], fill=ICON, width=p(1.7))


def icon_sticker(d, x, y):
    rr(d, (x - 9, y - 9, x + 9, y + 9), 6, None, outline=ICON, width=p(1.5))
    d.line([(p(x + 2), p(y + 9)), (p(x + 9), p(y + 2))], fill=ICON, width=p(1.5))


def input_bar(img):
    d = ImageDraw.Draw(img)
    d.rectangle([0, p(INPUT_TOP), p(W), p(H)], fill=BAR)
    d.line([(0, p(INPUT_TOP)), (p(W), p(INPUT_TOP))], fill=SEP, width=1)
    cy = INPUT_TOP + 26
    icon_plus(d, 22, cy, 10, 1.8)
    rr(d, (46, cy - 17, 300, cy + 17), 17, (255, 255, 255), outline=(210, 210, 210), width=p(0.8))
    icon_sticker(d, 282, cy)
    icon_camera(d, 330, cy)
    icon_mic(d, 368, cy)
    home_indicator(img)


def chat_header(img, hdr, avatars):
    d = ImageDraw.Draw(img)
    bg = (247, 247, 247)
    status_bar(img, hdr['_clock'], bg)
    d.rectangle([0, p(54), p(W), p(HEADER_BOTTOM)], fill=bg)
    d.line([(0, p(HEADER_BOTTOM)), (p(W), p(HEADER_BOTTOM))], fill=SEP, width=1)
    cy = 79
    icon_back(d, 14, cy)
    avatar(img, 52, cy, 18, hdr['avatar'], avatars)
    if hdr.get('subtitle'):
        draw_run(img, 78, cy - 20, hdr['name'], 17, 600, ICON)
        draw_run(img, 78, cy + 1, hdr['subtitle'], 12.5, 400, META)
    else:
        draw_run(img, 78, cy - 11, hdr['name'], 17, 600, ICON)
    icon_video(d, 300, cy)
    icon_phone(d, 350, cy)


# ---------- burbujas ----------

def tail(d, x, bottom, out, color):
    if out:
        pts = [(x - 12, bottom - 14), (x - 1, bottom - 4), (x + 6, bottom), (x - 10, bottom - 0.5)]
    else:
        pts = [(x + 12, bottom - 14), (x + 1, bottom - 4), (x - 6, bottom), (x + 10, bottom - 0.5)]
    d.polygon([(p(a), p(b)) for a, b in pts], fill=color)


def meta_width(m):
    w = run_width(m['time'], META_SIZE, 400)
    return w + (15 if m['dir'] == 'out' else 0)


def draw_meta(img, right, bottom, m, color=META):
    d = ImageDraw.Draw(img)
    w = meta_width(m)
    x = right - w
    draw_run(img, x, bottom - 15, m['time'], META_SIZE, 400, color)
    if m['dir'] == 'out':
        ticks(d, right - 11.5, bottom - 4.2)


def measure_text_bubble(m):
    inner = BUBBLE_MAX - 2 * PAD_X
    lines = wrap(m['text'], inner)
    mw = meta_width(m)
    widths = [line_width(l) for l in lines]
    last = widths[-1] if widths else 0
    extra_line = last + mw + 8 > inner
    content_w = max(widths + [mw])
    if not extra_line:
        content_w = max(content_w, last + mw + 8)
    quote_h = 0
    if m.get('quote'):
        quote_h = 52
        content_w = inner
    prev_h = 0
    if m.get('preview'):
        prev_h = 86
        content_w = inner
    h = PAD_Y + prev_h + quote_h + len(lines) * LINE + (16 if extra_line else 0) + PAD_Y
    if not extra_line:
        h += 1
    return {'lines': lines, 'w': content_w + 2 * PAD_X, 'h': h, 'extra': extra_line, 'quote_h': quote_h, 'prev_h': prev_h}


def qr_image(data, px):
    if CLEAN:
        # QR de presentación tal cual: se escala sin recolorear y conservando proporción y margen
        a = qr_asset()
        k = min(px / a.width, px / a.height)
        im = a.resize((max(1, round(a.width * k)), max(1, round(a.height * k))), Image.LANCZOS)
        out = Image.new('RGBA', (px, px), (255, 255, 255, 255))
        out.alpha_composite(im, ((px - im.width) // 2, (px - im.height) // 2))
        return out
    q = qrcode.QRCode(border=1, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=4)
    q.add_data(data)
    q.make(fit=True)
    return q.make_image(fill_color='black', back_color='white').convert('RGBA').resize((px, px), Image.NEAREST)


def draw_text_bubble(img, m, x, y, lay, is_last):
    d = ImageDraw.Draw(img)
    out = m['dir'] == 'out'
    col = OUT_BUBBLE if out else IN_BUBBLE
    w, h = lay['w'], lay['h']
    shadow(img, x, y, w, h)
    rr(d, (x, y, x + w, y + h), 17, col)
    if is_last:
        tail(d, x + w if out else x, y + h, out, col)
    cy = y + PAD_Y
    inner_l, inner_r = x + 5, x + w - 5
    if lay['prev_h']:
        pv = m['preview']
        pbg = (201, 238, 194) if out else (240, 240, 240)
        rr(d, (inner_l, y + 5, inner_r, y + 5 + 80), 11, pbg)
        thumb = qr_image(pv['qr'], p(64))
        mask = Image.new('L', thumb.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, thumb.width, thumb.height], radius=p(8), fill=255)
        img.paste(thumb, (p(inner_l + 8), p(y + 13)), mask)
        tx = inner_l + 82
        tw = inner_r - tx - 8
        draw_run(img, tx, y + 15, ellipsize(pv['title'], tw, 14.5, 650)[0], 14.5, 650, TEXT)
        draw_run(img, tx, y + 36, ellipsize(pv['desc'], tw, 13.5)[0], 13.5, 400, META)
        draw_run(img, tx, y + 56, pv['domain'], 12.5, 400, META)
        cy = y + 5 + 80 + 4
    if lay['quote_h']:
        q = m['quote']
        qbg = (204, 240, 197) if out else (243, 243, 243)
        rr(d, (inner_l, cy - 2, inner_r, cy - 2 + 46), 8, qbg)
        d.rounded_rectangle([p(inner_l), p(cy - 2), p(inner_l + 4), p(cy + 44)], radius=p(2), fill=(6, 207, 156))
        draw_run(img, inner_l + 12, cy + 3, q['name'], 13.5, 650, DARKGREEN)
        draw_run(img, inner_l + 12, cy + 22, ellipsize(q['text'], inner_r - inner_l - 22, 13.5)[0], 13.5, 400, META)
        cy += 52
    draw_lines(img, x + PAD_X, cy, lay['lines'])
    draw_meta(img, x + w - 9, y + h - 4, m)


def shadow(img, x, y, w, h):
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([p(x), p(y + 1), p(x + w), p(y + h + 1)], radius=p(17), fill=(205, 200, 190))


def measure(m):
    k = m['kind']
    if k == 'date':
        return {'h': 26, 'w': 0}
    if k == 'text':
        return measure_text_bubble(m)
    if k == 'voice':
        return {'w': 270, 'h': 62}
    if k == 'image':
        cap = wrap(m['caption'], 236 - 2 * PAD_X - 50)
        return {'w': 240, 'h': 4 + 300 + PAD_Y + len(cap) * LINE + PAD_Y + 2, 'cap': cap}
    raise ValueError(k)


def draw_date(img, m, y):
    d = ImageDraw.Draw(img)
    tw = run_width(m['text'], 12.5, 600)
    x0 = W / 2 - tw / 2 - 11
    rr(d, (x0, y, W / 2 + tw / 2 + 11, y + 24), 8, (255, 255, 255))
    draw_run(img, x0 + 11, y + 5, m['text'], 12.5, 600, (84, 101, 111))


def draw_voice(img, m, x, y, lay, is_last, avatars):
    d = ImageDraw.Draw(img)
    out = m['dir'] == 'out'
    col = OUT_BUBBLE if out else IN_BUBBLE
    w, h = lay['w'], lay['h']
    shadow(img, x, y, w, h)
    rr(d, (x, y, x + w, y + h), 17, col)
    if is_last:
        tail(d, x + w if out else x, y + h, out, col)
    avatar(img, x + 30, y + 31, 21, m['avatar'], avatars)
    # insignia de micrófono
    mx, my = x + 46, y + 47
    d.ellipse([p(mx - 7), p(my - 7), p(mx + 7), p(my + 7)], fill=col)
    rr(d, (mx - 2.3, my - 5, mx + 2.3, my + 1.5), 2.3, (36, 160, 230))
    d.arc([p(mx - 4), p(my - 2.5), p(mx + 4), p(my + 4)], 0, 180, fill=(36, 160, 230), width=p(1.2))
    # play
    px0 = x + 64
    d.polygon([(p(px0), p(y + 21)), (p(px0 + 13), p(y + 29.5)), (p(px0), p(y + 38))], fill=(120, 130, 138))
    rnd = random.Random(m['time'])
    bx = px0 + 24
    for i in range(34):
        hh = 3 + abs(math.sin(i * 0.7) * 9) * rnd.uniform(0.4, 1.0)
        rr(d, (bx + i * 4.6, y + 29.5 - hh / 2, bx + i * 4.6 + 2.2, y + 29.5 + hh / 2), 1.1, (160, 170, 176))
    d.ellipse([p(bx - 3), p(y + 25), p(bx + 6), p(y + 34)], fill=(120, 130, 138))
    draw_run(img, bx - 2, y + 41, m['duration'], META_SIZE, 400, META)
    draw_meta(img, x + w - 9, y + h - 4, m)


def draw_receipt(img, r, x, y, w, hgt):
    d = ImageDraw.Draw(img)
    rr(d, (x, y, x + w, y + hgt), 13, (233, 236, 239))
    rr(d, (x + 14, y + 16, x + w - 14, y + hgt - 16), 8, (255, 255, 255))
    cx = x + 26
    draw_run(img, cx, y + 30, 'Tu banco' if CLEAN else 'Tu banco (ejemplo)', 10.5, 600, (90, 90, 90))
    d.ellipse([p(x + w / 2 - 17), p(y + 56), p(x + w / 2 + 17), p(y + 90)], fill=(46, 175, 98))
    d.line([(p(x + w / 2 - 8), p(y + 73)), (p(x + w / 2 - 2), p(y + 80)), (p(x + w / 2 + 9), p(y + 66))], fill=(255, 255, 255), width=p(3))
    t = 'Transferencia enviada'
    draw_run(img, x + w / 2 - run_width(t, 12, 650) / 2, y + 98, t, 12, 650, TEXT)
    draw_run(img, x + w / 2 - run_width(r['amount'], 20, 700) / 2, y + 118, r['amount'], 20, 700, TEXT)
    rows = [('Concepto', r['concept']), ('Cuenta destino', r['dest']), ('Fecha', r['date']), ('Clave de rastreo', 'BNET0100261108' if CLEAN else 'EJEMPLO000000')]
    yy = y + 152
    for k, v in rows:
        draw_run(img, cx, yy, k, 9.5, 400, META)
        draw_run(img, cx, yy + 12, ellipsize(v, w - 52, 10.5, 600)[0], 10.5, 600, TEXT)
        yy += 29
    if CLEAN:
        return
    tag = 'COMPROBANTE FICTICIO'
    draw_run(img, x + w / 2 - run_width(tag, 9, 700) / 2, y + hgt - 32, tag, 9, 700, (200, 60, 60))


def draw_image_msg(img, m, x, y, lay, is_last):
    d = ImageDraw.Draw(img)
    out = m['dir'] == 'out'
    col = OUT_BUBBLE if out else IN_BUBBLE
    w, h = lay['w'], lay['h']
    shadow(img, x, y, w, h)
    rr(d, (x, y, x + w, y + h), 17, col)
    if is_last:
        tail(d, x + w if out else x, y + h, out, col)
    draw_receipt(img, m['receipt'], x + 4, y + 4, w - 8, 300)
    draw_lines(img, x + PAD_X, y + 4 + 300 + PAD_Y, lay['cap'])
    draw_meta(img, x + w - 9, y + h - 4, m)


def render_chat(sc, avatars):
    img = Image.new('RGBA', (p(W), p(H)), WALL + (255,))
    wallpaper(img, HEADER_BOTTOM, INPUT_TOP, seed=int(sc['id']))
    msgs = sc['messages']
    lays = [measure(m) for m in msgs]
    # apilar desde abajo
    gaps = []
    for i, m in enumerate(msgs):
        if i == len(msgs) - 1:
            gaps.append(0)
            continue
        n = msgs[i + 1]
        if m['kind'] == 'date' or n['kind'] == 'date':
            gaps.append(10)
        elif m.get('dir') == n.get('dir'):
            gaps.append(4)
        else:
            gaps.append(10)
    total = sum(l['h'] for l in lays) + sum(gaps)
    bottom = INPUT_TOP - 12
    y = bottom - total
    if y < HEADER_BOTTOM + 8 and not CLEAN:   # en modo limpio lo más antiguo queda bajo el encabezado, como al hacer scroll
        raise SystemExit(f"Pantalla {sc['id']}: el contenido no cabe ({HEADER_BOTTOM + 8 - y:.0f} pt de más)")
    for i, (m, lay) in enumerate(zip(msgs, lays)):
        nxt = msgs[i + 1] if i + 1 < len(msgs) else None
        is_last = not nxt or nxt['kind'] == 'date' or nxt.get('dir') != m.get('dir')
        if m['kind'] == 'date':
            draw_date(img, m, y)
        else:
            out = m['dir'] == 'out'
            x = W - 14 - lay['w'] if out else 14
            if m['kind'] == 'text':
                draw_text_bubble(img, m, x, y, lay, is_last)
            elif m['kind'] == 'voice':
                draw_voice(img, m, x, y, lay, is_last, avatars)
            elif m['kind'] == 'image':
                draw_image_msg(img, m, x, y, lay, is_last)
        y += lay['h'] + gaps[i]
    hdr = dict(sc['header'], _clock=sc['clock'])
    chat_header(img, hdr, avatars)
    input_bar(img)
    return img


def render_chatlist(sc, avatars):
    img = Image.new('RGBA', (p(W), p(H)), (255, 255, 255, 255))
    d = ImageDraw.Draw(img)
    status_bar(img, sc['clock'], (255, 255, 255))
    cy = 76
    d.ellipse([p(16), p(cy - 15), p(46), p(cy + 15)], fill=(239, 239, 239))
    for dx in (-6, 0, 6):
        d.ellipse([p(31 + dx - 1.6), p(cy - 1.6), p(31 + dx + 1.6), p(cy + 1.6)], fill=ICON)
    t = 'Chats'
    draw_run(img, W / 2 - run_width(t, 17, 600) / 2, cy - 11, t, 17, 600, ICON)
    icon_camera(d, 319, cy)
    d.ellipse([p(348), p(cy - 15), p(378), p(cy + 15)], fill=GREEN)
    icon_plus(d, 363, cy, 7, 2.2, (255, 255, 255))
    y = 100
    for r in sc['rows']:
        avatar(img, 42, y + 39, 26, r['avatar'], avatars)
        draw_run(img, 80, y + 15, r['name'], 17, 600, ICON)
        unread = r.get('unread')
        tcol = (30, 170, 97) if unread else META
        tw = run_width(r['time'], 14.5, 400)
        draw_run(img, W - 16 - tw, y + 17, r['time'], 14.5, 400, tcol)
        px = 80
        if r.get('ticks'):
            ticks(d, px, y + 53)
            px += 17
        maxw = W - 16 - px - (34 if unread else 0)
        lines = ellipsize(r['preview'], maxw, 15, 400, 1)
        draw_run(img, px, y + 39, lines[0], 15, 400, META)
        if unread:
            d.ellipse([p(W - 38), p(y + 39), p(W - 16), p(y + 61)], fill=(30, 170, 97))
            n = str(unread)
            draw_run(img, W - 27 - run_width(n, 13, 600) / 2, y + 42, n, 13, 600, (255, 255, 255))
        y += 78
        d.line([(p(80), p(y)), (p(W), p(y))], fill=(230, 230, 230), width=1)
    lock = '🔒 Tus mensajes personales están cifrados de extremo a extremo'
    draw_run(img, W / 2 - run_width(lock, 11.5, 400) / 2, y + 18, lock, 11.5, 400, META)
    # barra de pestañas
    ty = H - 83
    d.rectangle([0, p(ty), p(W), p(H)], fill=(248, 248, 248))
    d.line([(0, p(ty)), (p(W), p(ty))], fill=SEP, width=1)
    tabs = ['Novedades', 'Llamadas', 'Comunidades', 'Chats', 'Configuración']
    for i, t in enumerate(tabs):
        cx = 39 + i * 78.7
        active = t == 'Chats'
        colr = ICON if active else (90, 90, 90)
        if i == 0:
            d.ellipse([p(cx - 11), p(ty + 9), p(cx + 11), p(ty + 31)], outline=colr, width=p(1.6))
            d.ellipse([p(cx - 6), p(ty + 14), p(cx + 6), p(ty + 26)], outline=colr, width=p(1.6))
        elif i == 1:
            icon_phone(d, cx - 10, ty + 20)
        elif i == 2:
            for dx in (-8, 0, 8):
                d.ellipse([p(cx + dx - 3.5), p(ty + 10), p(cx + dx + 3.5), p(ty + 17)], outline=colr, width=p(1.4))
                d.arc([p(cx + dx - 6), p(ty + 19), p(cx + dx + 6), p(ty + 33)], 180, 360, fill=colr, width=p(1.4))
        elif i == 3:
            d.ellipse([p(cx - 12), p(ty + 9), p(cx + 10), p(ty + 29)], fill=ICON)
            d.polygon([(p(cx - 10), p(ty + 24)), (p(cx - 14), p(ty + 32)), (p(cx - 4), p(ty + 28))], fill=ICON)
        else:
            d.ellipse([p(cx - 10), p(ty + 10), p(cx + 10), p(ty + 30)], outline=colr, width=p(1.6))
            d.ellipse([p(cx - 4), p(ty + 16), p(cx + 4), p(ty + 24)], outline=colr, width=p(1.6))
        draw_run(img, cx - run_width(t, 10.5, 600 if active else 500) / 2, ty + 36, t, 10.5, 600 if active else 500, colr)
    home_indicator(img)
    return img


PEY_BLUE = (37, 99, 235)
PAY_BLUE = (45, 106, 228)
BORDER = (209, 213, 219)
MUTED = (107, 114, 128)
INK = (17, 24, 39)


def safari_bar(img, domain):
    d = ImageDraw.Draw(img)
    by = H - 92
    d.rectangle([0, p(by), p(W), p(H)], fill=(246, 246, 246))
    d.line([(0, p(by)), (p(W), p(by))], fill=SEP, width=1)
    rr(d, (12, by + 8, W - 12, by + 46), 12, (255, 255, 255))
    draw_run(img, 26, by + 18, 'AA', 14, 600, ICON)
    dom = f"🔒 {domain}"
    draw_run(img, W / 2 - run_width(dom, 15, 500) / 2, by + 18, dom, 15, 500, ICON)
    d.arc([p(W - 40), p(by + 19), p(W - 26), p(by + 33)], 300, 240, fill=ICON, width=p(1.6))
    ly = by + 66
    d.line([(p(36), p(ly - 7)), (p(29), p(ly)), (p(36), p(ly + 7))], fill=(0, 122, 255), width=p(2))
    d.line([(p(100), p(ly - 7)), (p(107), p(ly)), (p(100), p(ly + 7))], fill=(190, 190, 190), width=p(2))
    rr(d, (190, ly - 6, 204, ly + 8), 2, None, outline=(0, 122, 255), width=p(1.6))
    d.line([(p(197), p(ly - 10)), (p(197), p(ly + 2))], fill=(0, 122, 255), width=p(1.6))
    rr(d, (276, ly - 7, 292, ly + 7), 2, None, outline=(0, 122, 255), width=p(1.6))
    rr(d, (348, ly - 8, 362, ly + 6), 2, None, outline=(0, 122, 255), width=p(1.6))
    rr(d, (352, ly - 4, 366, ly + 10), 2, (246, 246, 246), outline=(0, 122, 255), width=p(1.6))
    home_indicator(img)


def centered(img, y, text, size, weight, color):
    draw_run(img, W / 2 - run_width(text, size, weight) / 2, y, text, size, weight, color)


def pey_header(img, title):
    """Barra superior como el checkout de referencia: casa, comercio, logo pey."""
    d = ImageDraw.Draw(img)
    cy = 80
    # casa
    d.line([(p(26), p(cy - 1)), (p(36), p(cy - 10)), (p(46), p(cy - 1))], fill=INK, width=p(1.9), joint='curve')
    rr(d, (29, cy - 4, 43, cy + 9), 2, None, outline=INK, width=p(1.9))
    rr(d, (34, cy + 2, 38, cy + 9), 1, INK)
    centered(img, cy - 10, title, 15.5, 650, INK)
    draw_run(img, W - 30 - run_width('pey', 23, 800), cy - 16, 'pey', 23, 800, PEY_BLUE)
    d.line([(0, p(106)), (p(W), p(106))], fill=(229, 231, 235), width=p(0.8))


def concept_pill(img, y, text):
    if CLEAN or not text:
        return
    d = ImageDraw.Draw(img)
    tw = run_width(text, 10.5, 600)
    rr(d, (W / 2 - tw / 2 - 10, y, W / 2 + tw / 2 + 10, y + 20), 10, (254, 243, 199))
    centered(img, y + 4, text, 10.5, 600, (146, 64, 14))


def field(d, img, box, placeholder, color=(156, 163, 175), size=15):
    rr(d, box, 6, (255, 255, 255), outline=BORDER, width=p(0.8))
    draw_run(img, box[0] + 11, (box[1] + box[3]) / 2 - size * 0.62, placeholder, size, 400, color)


def codi_button(d, img, box):
    rr(d, box, 5, (0, 0, 0))
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    t = 'CoDi'
    tw = run_width(t, 18, 800)
    draw_run(img, cx - tw / 2, cy - 11.5, t, 18, 800, (255, 255, 255))
    # arco del logotipo sobre la "o"
    ox = cx - tw / 2 + run_width('C', 18, 800) + run_width('o', 18, 800) / 2
    d.arc([p(ox - 6), p(cy - 15), p(ox + 6), p(cy - 5)], 200, 340, fill=(255, 255, 255), width=p(1.6))


def render_checkout(sc, avatars):
    pg = sc['page']
    img = Image.new('RGBA', (p(W), p(H)), (255, 255, 255, 255))
    d = ImageDraw.Draw(img)
    status_bar(img, sc['clock'], (255, 255, 255))
    pey_header(img, pg['business'])
    concept_pill(img, 114, pg['concept'])
    L, R = 32, W - 32
    draw_run(img, L, 144, pg['label_total'], 14, 650, INK)
    rr(d, (L, 164, R, 202), 14, (255, 255, 255), outline=BORDER, width=p(0.9))
    d.rounded_rectangle([p(L), p(164), p(L + 34), p(202)], radius=p(14), fill=(243, 244, 246))
    d.rectangle([p(L + 20), p(164.5), p(L + 34), p(201.5)], fill=(243, 244, 246))
    d.line([(p(L + 34), p(164)), (p(L + 34), p(202))], fill=BORDER, width=p(0.9))
    draw_run(img, L + 12, 173, '$', 15, 400, INK)
    draw_run(img, L + 46, 173, pg['amount_input'], 15, 400, INK)
    tot = f"Total: {pg['total']}"
    tw = run_width(tot, 21, 650)
    draw_run(img, W / 2 - tw / 2 - 8, 220, tot, 21, 650, INK)
    ax = W / 2 + tw / 2 + 4
    d.polygon([(p(ax), p(236)), (p(ax + 10), p(236)), (p(ax + 5), p(230))], fill=INK)
    d.line([(p(L), p(258)), (p(R), p(258))], fill=(229, 231, 235), width=p(0.8))
    fee = pg['fee'].rstrip('*') if CLEAN else pg['fee']
    rows = [(pg['label_products'], pg['products'], False), (pg['label_fee'], fee, True)]
    y = 268
    for k, v, info in rows:
        draw_run(img, 104, y, k, 11, 400, MUTED)
        if info:
            ix = 104 + run_width(k, 11, 400) + 6
            d.ellipse([p(ix), p(y + 2), p(ix + 10), p(y + 12)], outline=PEY_BLUE, width=p(1))
            draw_run(img, ix + 3.6, y + 1.5, 'i', 8, 700, PEY_BLUE)
        draw_run(img, 288 - run_width(v, 11, 400), y, v, 11, 400, INK)
        y += 20
    if not CLEAN:
        centered(img, y + 2, pg['fee_note'], 9.5, 400, MUTED)
    d.line([(p(L), p(326)), (p(R), p(326))], fill=(229, 231, 235), width=p(0.8))
    # tarjeta contenedora
    rr(d, (L, 334, R, 706), 9, (255, 255, 255), outline=(229, 231, 235), width=p(0.9))
    IL, IR = L + 15, R - 15
    codi_button(d, img, (IL, 348, IR, 390))
    oy = 410
    t = pg['label_or']
    tw = run_width(t, 12, 400)
    d.line([(p(IL), p(oy + 7)), (p(W / 2 - tw / 2 - 10), p(oy + 7))], fill=(229, 231, 235), width=p(0.8))
    d.line([(p(W / 2 + tw / 2 + 10), p(oy + 7)), (p(IR), p(oy + 7))], fill=(229, 231, 235), width=p(0.8))
    centered(img, oy, t, 12, 400, (75, 85, 99))
    # sección de tarjeta (referencia visual, deshabilitada)
    draw_run(img, IL, 432, pg['label_card'], 13, 400, (55, 65, 81))
    field(d, img, (IL, 451, IR, 489), '1234 1234 1234 1234')
    d.ellipse([p(IR - 34), p(463), p(IR - 20), p(477)], fill=(235, 0, 27))
    d.ellipse([p(IR - 26), p(463), p(IR - 12), p(477)], fill=(247, 158, 27))
    mid = W / 2
    draw_run(img, IL, 503, pg['label_exp'], 13, 400, (55, 65, 81))
    draw_run(img, mid + 4, 503, pg['label_cvc'], 13, 400, (55, 65, 81))
    field(d, img, (IL, 522, mid - 4, 560), 'MM / AA')
    field(d, img, (mid + 4, 522, IR, 560), 'CVC')
    rr(d, (IR - 30, 533, IR - 12, 547), 2, None, outline=(156, 163, 175), width=p(1))
    d.line([(p(IR - 30), p(537)), (p(IR - 12), p(537))], fill=(156, 163, 175), width=p(1.4))
    draw_run(img, IL, 574, pg['label_country'], 13, 400, (55, 65, 81))
    field(d, img, (IL, 593, IR, 631), pg['country'], INK)
    d.line([(p(IR - 22), p(609)), (p(IR - 17), p(614)), (p(IR - 12), p(609))], fill=(75, 85, 99), width=p(1.5))
    rr(d, (IL, 645, IR, 689), 6, PAY_BLUE)
    centered(img, 657, pg['pay'], 14.5, 650, (255, 255, 255))
    # velo sobre la parte de tarjeta: fuera del MVP
    veil = Image.new('RGBA', (p(IR - IL + 8), p(689 - 424 + 6)), (255, 255, 255, 150))
    img.alpha_composite(veil, (p(IL - 4), p(424)))
    if not CLEAN:
        tag = pg['card_note']
        tw = run_width(tag, 11.5, 650)
        rr(d, (W / 2 - tw / 2 - 12, 605 - 47, W / 2 + tw / 2 + 12, 605 - 23), 12, (55, 65, 81))
        centered(img, 605 - 42, tag, 11.5, 650, (255, 255, 255))
    safari_bar(img, pg['domain'])
    return img


def render_codiqr(sc, avatars):
    pg = sc['page']
    img = Image.new('RGBA', (p(W), p(H)), (255, 255, 255, 255))
    d = ImageDraw.Draw(img)
    status_bar(img, sc['clock'], (255, 255, 255))
    pey_header(img, pg['business'])
    concept_pill(img, 114, pg['concept'])
    L, R = 32, W - 32
    centered(img, 148, f"Total: {pg['total']}", 21, 650, INK)
    centered(img, 178, pg['detail'], 12, 400, MUTED)
    codi_button(d, img, (L + 15, 220, R - 15, 262))
    qs = 210
    qx, qy = W / 2 - qs / 2, 282
    img.paste(qr_image(pg['qr'], p(qs)), (p(qx), p(qy)))
    y = qy + qs + 14
    if not CLEAN:
        bw = 92
        rr(d, (W / 2 - bw / 2, qy + qs / 2 - 14, W / 2 + bw / 2, qy + qs / 2 + 14), 7, (200, 40, 40))
        centered(img, qy + qs / 2 - 9, 'DEMO', 15, 800, (255, 255, 255))
        centered(img, y, 'DEMO · NO PAGABLE', 12.5, 700, (200, 40, 40))
    y += 22
    centered(img, y, pg['expires'], 12.5, 500, MUTED)
    y += 28
    for ln in wrap(pg['help'], R - L - 36, 13.5):
        draw_run(img, L + 18, y, ''.join(t for t, _ in ln).rstrip(), 13.5, 400, (55, 65, 81))
        y += 19
    y += 10
    rr(d, (L + 15, y, R - 15, y + 38), 6, None, outline=BORDER, width=p(0.9))
    centered(img, y + 10, pg['save'], 14, 600, PAY_BLUE)
    box_bottom = y + 52
    d.rounded_rectangle([p(L), p(206), p(R), p(box_bottom)], radius=p(9), outline=(229, 231, 235), width=p(0.9))
    y = box_bottom + 14
    for ln in wrap(pg['footer'], R - L, 11.5):
        centered(img, y, ''.join(t for t, _ in ln).rstrip(), 11.5, 400, MUTED)
        y += 16
    safari_bar(img, pg['domain'])
    return img


# ---------- hojas de contacto ----------

def framed(screen, scale):
    w, h = int(screen.width * scale), int(screen.height * scale)
    im = screen.convert('RGB').resize((w, h), Image.LANCZOS)
    r = int(36 * scale * S / 2)
    mask = Image.new('L', (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=r, fill=255)
    pad = int(26 * scale * S / 2)
    out = Image.new('RGBA', (w + 2 * pad, h + 2 * pad), (0, 0, 0, 0))
    sh = Image.new('L', (w + 2 * pad, h + 2 * pad), 0)
    ImageDraw.Draw(sh).rounded_rectangle([pad, pad + 6, pad + w, pad + h + 6], radius=r, fill=90)
    sh = sh.filter(ImageFilter.GaussianBlur(pad / 2))
    out.paste((0, 0, 0, 255), (0, 0), sh)
    frame = Image.new('RGBA', (w + 12, h + 12), (0, 0, 0, 0))
    ImageDraw.Draw(frame).rounded_rectangle([0, 0, w + 11, h + 11], radius=r + 6, fill=(30, 30, 30, 255))
    out.alpha_composite(frame, (pad - 6, pad - 6))
    out.paste(im, (pad, pad), mask)
    return out, pad


def _wrap_px(text, f, width):
    lines, line = [], ''
    for w in text.split():
        t = (line + ' ' + w).strip()
        if f.getlength(t) > width and line:
            lines.append(line)
            line = w
        else:
            line = t
    if line:
        lines.append(line)
    return lines


def caption_fonts():
    fb = ImageFont.truetype(FONT, 28)
    fb.set_variation_by_axes([24, 700])
    fr = ImageFont.truetype(FONT, 21)
    fr.set_variation_by_axes([16, 400])
    return fb, fr


def caption_block(img, x, y, width, sc, draw=True):
    """Dibuja (o solo mide) el pie de una pantalla; devuelve la altura usada."""
    fb, fr = caption_fonts()
    title = _wrap_px(f"{sc['id']} · {sc['caption']}", fb, width)
    note = _wrap_px(sc['note'], fr, width)
    h = len(title) * 36 + 8 + len(note) * 29
    if draw:
        d = ImageDraw.Draw(img)
        yy = y
        for ln in title:
            d.text((x, yy), ln, font=fb, fill=(20, 20, 20))
            yy += 36
        yy += 8
        for ln in note:
            d.text((x, yy), ln, font=fr, fill=(80, 80, 80))
            yy += 29
    return h


def sheet(screens, imgs, cols, title, subtitle, disclaimer, scale=0.5):
    rows = math.ceil(len(screens) / cols)
    tile, pad = framed(imgs[0], scale)
    cw = tile.width + 30
    cap_h = max(caption_block(None, 0, 0, tile.width - 2 * pad, sc, draw=False) for sc in screens) + 40
    ch = tile.height + cap_h
    Wd = cols * cw + 80
    ft = ImageFont.truetype(FONT, 56); ft.set_variation_by_axes([32, 750])
    fs = ImageFont.truetype(FONT, 28); fs.set_variation_by_axes([20, 450])
    fd = ImageFont.truetype(FONT, 24); fd.set_variation_by_axes([16, 600])
    disc = _wrap_px(disclaimer, fd, Wd - 100)
    top = 160 + len(disc) * 32 + 20
    Hd = top + rows * ch + 20
    out = Image.new('RGBA', (Wd, Hd), (250, 248, 244, 255))
    d = ImageDraw.Draw(out)
    d.text((50, 40), title, font=ft, fill=(17, 27, 33))
    d.text((52, 112), subtitle, font=fs, fill=(70, 80, 88))
    for k, ln in enumerate(disc):
        d.text((52, 160 + k * 32), ln, font=fd, fill=(160, 70, 40))
    for i, (sc, im) in enumerate(zip(screens, imgs)):
        r, c = divmod(i, cols)
        x0 = 40 + c * cw
        y0 = top + r * ch
        t, pd = framed(im, scale)
        out.alpha_composite(t, (x0, y0))
        caption_block(out, x0 + pd, y0 + t.height - pd + 18, t.width - 2 * pd, sc)
    return out.convert('RGB')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=str(HERE / 'mockups'))
    ap.add_argument('--zip', default=None)
    ap.add_argument('--clean', action='store_true', help='modo limpio de presentación (sin marcas de maqueta)')
    ap.add_argument('--screens-only', action='store_true', help='solo las pantallas, sin hojas de resumen')
    a = ap.parse_args()
    global CLEAN
    CLEAN = CLEAN or a.clean
    spec = apply_clean(json.loads((HERE / 'screens.json').read_text(encoding='utf-8')))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    avatars = spec['avatars']
    names, imgs = [], []
    for sc in spec['screens']:
        if sc.get('hidden'):
            continue
        if sc['type'] == 'chat':
            im = render_chat(sc, avatars)
        elif sc['type'] == 'chatlist':
            im = render_chatlist(sc, avatars)
        elif sc['type'] == 'checkout':
            im = render_checkout(sc, avatars)
        else:
            im = render_codiqr(sc, avatars)
        plain = unicodedata.normalize('NFKD', sc['caption'].lower()).encode('ascii', 'ignore').decode()
        slug = re.sub(r'[^a-z0-9]+', '-', plain).strip('-')[:48]
        fn = out / f"{sc['id']}-{slug}.png"
        im.convert('RGB').save(fn, optimize=True)
        names.append(fn)
        imgs.append(im)
        print('pantalla', fn.name, im.size)
    meta = spec['meta']
    if a.screens_only:
        return
    ov = sheet(spec['screens'], imgs, 6, meta['title'], f"Rafa (Taller de Rafa), el agente y dos clientes: Ana y Luis. {len(spec['screens'])} pantallas en orden.", meta['disclaimer'], scale=0.5)
    ov.save(out / 'overview.png', optimize=True)
    names.append(out / 'overview.png')
    print('overview', ov.size)
    for ch, label in meta['chapters'].items():
        idx = [i for i, sc in enumerate(spec['screens']) if str(sc['chapter']) == ch]
        st = sheet([spec['screens'][i] for i in idx], [imgs[i] for i in idx], len(idx), f"Capítulo {ch} · {label}", meta['title'], meta['disclaimer'], scale=0.5)
        fn = out / f"storyboard-{ch}.png"
        st.save(fn, optimize=True)
        names.append(fn)
        print('storyboard', fn.name, st.size)
    if a.zip:
        with zipfile.ZipFile(a.zip, 'w', zipfile.ZIP_DEFLATED) as z:
            for fn in names:
                z.write(fn, f"mockups/{fn.name}")
            for src in ('screens.json', 'render_mockups.py', 'README.md'):
                if (HERE / src).exists():
                    z.write(HERE / src, src)
        print('zip', a.zip)


if __name__ == '__main__':
    main()
