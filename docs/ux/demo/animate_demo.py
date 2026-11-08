#!/usr/bin/env python3
"""Demo animada y guionizada del flujo de cobros CoDi por WhatsApp.

Reutiliza el renderizador de las maquetas (../render_mockups.py) y su texto
(../screens.json). El guion está en timeline.json: cada paso hace aparecer un
mensaje, escribe en el compositor, abre otro chat, muestra una notificación,
cambia el pie de la derecha, etc. Nada se conecta ni se envía: es una
animación de datos ficticios.

Uso:
    python3 animate_demo.py --out /tmp/demo.mp4            # video 1920x1080, 30 fps
    python3 animate_demo.py --frames DIR --at 12 40 75      # solo fotogramas sueltos (PNG)
    python3 animate_demo.py --dry-run                        # imprime la línea de tiempo

Requiere Pillow, qrcode y ffmpeg con libx264.
"""
import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import render_mockups as rm  # noqa: E402

SW, SH = 1920, 1080
PH_H = 1000                              # alto de la pantalla del teléfono en el escenario
PH_SCALE = PH_H / rm.p(rm.H)
PH_W = round(rm.p(rm.W) * PH_SCALE)
PH_X, PH_Y = 660 - PH_W // 2, 40
BG = (236, 238, 241)
INK = (17, 27, 33)
SUB = (70, 80, 90)
GREEN_D = (0, 128, 105)


# ---------- utilidades ----------

def ease(t):
    t = min(1.0, max(0.0, t))
    return 1 - (1 - t) ** 3


def ease_io(t):
    t = min(1.0, max(0.0, t))
    return 4 * t ** 3 if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2


def sfont(size, weight=400):
    f = ImageFont.truetype(rm.FONT, size)
    try:
        f.set_variation_by_axes([min(32, max(14, size * 0.5)), weight])
    except Exception:
        pass
    return f


_F = {}


def F(size, weight=400):
    k = (size, weight)
    if k not in _F:
        _F[k] = sfont(size, weight)
    return _F[k]


def wrap_px(text, f, width):
    out = []
    for para in text.split('\n'):
        line = ''
        for w in para.split():
            t = (line + ' ' + w).strip()
            if f.getlength(t) > width and line:
                out.append(line)
                line = w
            else:
                line = t
        out.append(line)
    return out


def hexcol(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def plain(text):
    return text.replace('*', '').replace('\n', ' ').strip()


# ---------- teléfono: capas ----------

class Phone:
    def __init__(self, spec):
        self.spec = spec
        self.avatars = spec['avatars']
        self._wall = {}
        self._content = {}
        self._header = {}
        self._input = {}
        self._banner = {}

    def wall(self, seed):
        if seed not in self._wall:
            im = Image.new('RGBA', (rm.p(rm.W), rm.p(rm.H)), rm.WALL + (255,))
            rm.wallpaper(im, rm.HEADER_BOTTOM, rm.INPUT_TOP, seed=seed)
            self._wall[seed] = im
        return self._wall[seed]

    @staticmethod
    def measure(m):
        if m['kind'] == 'typing':
            return {'w': 66, 'h': 36}
        return rm.measure(m)

    def layout(self, msgs):
        lays = [self.measure(m) for m in msgs]
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
        return lays, gaps, total

    def content(self, msgs):
        key = tuple(m['uid'] for m in msgs)
        if key in self._content:
            return self._content[key]
        lays, gaps, total = self.layout(msgs)
        img = Image.new('RGBA', (rm.p(rm.W), rm.p(total) + rm.p(6)), (0, 0, 0, 0))
        y = 0
        for i, (m, lay) in enumerate(zip(msgs, lays)):
            nxt = msgs[i + 1] if i + 1 < len(msgs) else None
            is_last = not nxt or nxt['kind'] == 'date' or nxt.get('dir') != m.get('dir')
            if m['kind'] == 'date':
                rm.draw_date(img, m, y)
            else:
                out = m['dir'] == 'out'
                x = rm.W - 14 - lay['w'] if out else 14
                if m['kind'] == 'text':
                    rm.draw_text_bubble(img, m, x, y, lay, is_last)
                elif m['kind'] == 'voice':
                    rm.draw_voice(img, m, x, y, lay, is_last, self.avatars)
                elif m['kind'] == 'image':
                    rm.draw_image_msg(img, m, x, y, lay, is_last)
                elif m['kind'] == 'typing':
                    d = ImageDraw.Draw(img)
                    rm.shadow(img, x, y, lay['w'], lay['h'])
                    rm.rr(d, (x, y, x + lay['w'], y + lay['h']), 17, rm.IN_BUBBLE)
                    rm.tail(d, x, y + lay['h'], False, rm.IN_BUBBLE)
                    for k in range(3):
                        cx, cy = x + 20 + k * 13, y + 18
                        d.ellipse([rm.p(cx - 4), rm.p(cy - 4), rm.p(cx + 4), rm.p(cy + 4)], fill=(175, 180, 184))
            y += lay['h'] + gaps[i]
        res = (img, total, lays)
        self._content[key] = res
        return res

    def header(self, hdr, clock, subtitle=None):
        key = (hdr['name'], clock, subtitle)
        if key not in self._header:
            im = Image.new('RGBA', (rm.p(rm.W), rm.p(rm.H)), (0, 0, 0, 0))
            h = dict(hdr, _clock=clock)
            if subtitle:
                h['subtitle'] = subtitle
            rm.chat_header(im, h, self.avatars)
            self._header[key] = im.crop((0, 0, rm.p(rm.W), rm.p(rm.HEADER_BOTTOM) + 2))
        return self._header[key]

    def input(self, text='', caret=True):
        key = (text, caret)
        if key not in self._input:
            im = Image.new('RGBA', (rm.p(rm.W), rm.p(rm.H)), (0, 0, 0, 0))
            rm.input_bar(im)
            if text:
                d = ImageDraw.Draw(im)
                cy = rm.INPUT_TOP + 26
                d.rectangle([rm.p(306), rm.p(rm.INPUT_TOP + 4), rm.p(rm.W), rm.p(rm.INPUT_TOP + 50)], fill=rm.BAR)
                rm.rr(d, (46, cy - 17, 340, cy + 17), 17, (255, 255, 255), outline=(210, 210, 210), width=rm.p(0.8))
                t = text.replace('\n', '  ')
                maxw = 270
                if rm.run_width(t, 16, 400) > maxw:
                    while t and rm.run_width('…' + t, 16, 400) > maxw:
                        t = t[1:]
                    t = '…' + t
                end = rm.draw_run(im, 58, cy - 10, t, 16, 400, rm.TEXT)
                if caret:
                    d.line([(rm.p(end + 1.5), rm.p(cy - 10)), (rm.p(end + 1.5), rm.p(cy + 10))], fill=rm.DARKGREEN, width=rm.p(1.6))
                d.ellipse([rm.p(352), rm.p(cy - 16), rm.p(384), rm.p(cy + 16)], fill=rm.GREEN)
                ax = 368
                d.line([(rm.p(ax), rm.p(cy + 8)), (rm.p(ax), rm.p(cy - 8))], fill=(255, 255, 255), width=rm.p(2.4))
                d.line([(rm.p(ax - 6.5), rm.p(cy - 1.5)), (rm.p(ax), rm.p(cy - 8)), (rm.p(ax + 6.5), rm.p(cy - 1.5))], fill=(255, 255, 255), width=rm.p(2.4), joint='curve')
            self._input[key] = im.crop((0, rm.p(rm.INPUT_TOP) - 1, rm.p(rm.W), rm.p(rm.H)))
        return self._input[key]

    def banner(self, title, body):
        key = (title, body)
        if key not in self._banner:
            bw, bh = rm.W - 16, 84
            pad = 14
            im = Image.new('RGBA', (rm.p(rm.W), rm.p(bh + 2 * pad)), (0, 0, 0, 0))
            sh = Image.new('L', im.size, 0)
            ImageDraw.Draw(sh).rounded_rectangle([rm.p(8), rm.p(pad + 3), rm.p(8 + bw), rm.p(pad + bh + 3)], radius=rm.p(22), fill=70)
            sh = sh.filter(ImageFilter.GaussianBlur(rm.p(8)))
            im.paste((0, 0, 0, 255), (0, 0), sh)
            d = ImageDraw.Draw(im)
            rm.rr(d, (8, pad, 8 + bw, pad + bh), 22, (250, 250, 250, 248))
            # icono de la app de mensajería (genérico, verde)
            ix, iy = 22, pad + 14
            rm.rr(d, (ix, iy, ix + 38, iy + 38), 9, rm.GREEN)
            d.ellipse([rm.p(ix + 8), rm.p(iy + 8), rm.p(ix + 30), rm.p(iy + 29)], outline=(255, 255, 255), width=rm.p(2.4))
            d.polygon([(rm.p(ix + 9), rm.p(iy + 31)), (rm.p(ix + 11), rm.p(iy + 24)), (rm.p(ix + 16), rm.p(iy + 28))], fill=(255, 255, 255))
            tx = ix + 50
            rm.draw_run(im, tx, pad + 12, title, 15, 650, rm.TEXT)
            rm.draw_run(im, 8 + bw - 14 - rm.run_width('ahora', 13, 400), pad + 13, 'ahora', 13, 400, rm.META)
            lines = rm.ellipsize(body, bw - (tx - 8) - 16, 14.5, 400, 2)
            for k, ln in enumerate(lines):
                rm.draw_run(im, tx, pad + 33 + k * 19, ln, 14.5, 400, rm.TEXT)
            self._banner[key] = (im, pad)
        return self._banner[key]

    def chat(self, view, msgs, clock, composer='', caret=True, subtitle=None,
             anim=None, typing_phase=None, banner=None, tap=None):
        """anim = (msgs_previos, t) para animar la llegada del último mensaje."""
        img = self.wall(view['seed']).copy()
        cimg, total, lays = self.content(msgs)
        anchor = rm.INPUT_TOP - 12
        if anim:
            prev, t = anim
            _, ptotal, _ = self.content(prev)
            e = ease(t)
            anchor += (1 - e) * (total - ptotal)
        top = anchor - total
        self._paste_content(img, cimg, top, 1.0 if not anim else None)
        if anim:
            pimg, _, _ = self.content(anim[0])
            base = self.wall(view['seed']).copy()
            self._paste_content(base, pimg, top, 1.0)
            self._paste_content(base, cimg, top, ease(anim[1] * 1.4))
            img = base
        if typing_phase is not None and msgs and msgs[-1]['kind'] == 'typing':
            d = ImageDraw.Draw(img)
            ty = top + total - 36
            for k in range(3):
                ph = (typing_phase * 2.2 - k * 0.22) % 1.0
                a = 0.5 + 0.5 * math.sin(ph * 2 * math.pi)
                c = tuple(int(150 + (205 - 150) * (1 - a)) for _ in range(3))
                cx = 14 + 20 + k * 13
                cy = ty + 18 - 2.5 * a
                d.ellipse([rm.p(cx - 4), rm.p(cy - 4), rm.p(cx + 4), rm.p(cy + 4)], fill=c)
        img.alpha_composite(self.header(view['header'], clock, subtitle), (0, 0))
        img.alpha_composite(self.input(composer, caret), (0, rm.p(rm.INPUT_TOP) - 1))
        if banner:
            self.draw_banner(img, *banner)
        if tap:
            self.draw_tap(img, *tap)
        return img.convert('RGB')

    @staticmethod
    def _paste_content(img, cimg, top, alpha):
        dest = rm.p(top)
        y0 = max(0, rm.p(rm.HEADER_BOTTOM) - dest)
        y1 = min(cimg.height, rm.p(rm.INPUT_TOP) - dest)
        if y1 <= y0:
            return
        part = cimg.crop((0, y0, cimg.width, y1))
        if alpha is not None and alpha < 1:
            a = part.getchannel('A').point(lambda v: int(v * alpha))
            part.putalpha(a)
        img.alpha_composite(part, (0, dest + y0))

    def draw_banner(self, img, title, body, t_in):
        bim, pad = self.banner(title, body)
        y = rm.p(-110 + 118 * ease(t_in))
        if y + bim.height <= 0:
            return
        if y < 0:
            img.alpha_composite(bim.crop((0, -y, bim.width, bim.height)), (0, 0))
        else:
            img.alpha_composite(bim, (0, y))

    @staticmethod
    def draw_tap(img, x, y, t):
        ov = Image.new('RGBA', img.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)
        r = 16 + 14 * ease(t)
        a = int(110 * (1 - t))
        d.ellipse([rm.p(x - r), rm.p(y - r), rm.p(x + r), rm.p(y + r)], fill=(60, 60, 60, a))
        img.alpha_composite(ov) if img.mode == 'RGBA' else None
        return ov


def tap_overlay(rgb, x, y, t):
    im = rgb.convert('RGBA')
    ov = Image.new('RGBA', im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    r = 16 + 16 * ease(t)
    a = int(120 * (1 - t))
    d.ellipse([rm.p(x - r), rm.p(y - r), rm.p(x + r), rm.p(y + r)], fill=(40, 40, 40, a), outline=(255, 255, 255, a), width=rm.p(1.5))
    im.alpha_composite(ov)
    return im.convert('RGB')


# ---------- escenario ----------

class Stage:
    def __init__(self, meta):
        self.meta = meta
        self._base = {}
        mask = Image.new('L', (PH_W, PH_H), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, PH_W - 1, PH_H - 1], radius=58, fill=255)
        self.mask = mask

    def base(self, chapter, phone, cap):
        key = (chapter, phone, json.dumps(cap, ensure_ascii=False, sort_keys=True))
        if key in self._base:
            return self._base[key]
        im = Image.new('RGB', (SW, SH), BG)
        d = ImageDraw.Draw(im)
        # columna izquierda: capítulos
        d.text((70, 66), 'Agente de cobros', font=F(30, 750), fill=INK)
        d.text((70, 106), 'Cobros CoDi por WhatsApp', font=F(21, 450), fill=SUB)
        y = 190
        for n, label in self.meta['chapters'].items():
            active = int(n) == chapter
            done = chapter and int(n) < chapter
            col = GREEN_D if active else ((120, 150, 140) if done else (150, 156, 162))
            d.ellipse([70, y, 104, y + 34], fill=col if (active or done) else None, outline=col, width=3)
            d.text((87, y + 17), n, font=F(19, 700), fill=(255, 255, 255) if (active or done) else col, anchor='mm')
            lines = wrap_px(label, F(21, 650 if active else 450), 250)
            for k, ln in enumerate(lines):
                d.text((118, y + 4 + k * 27), ln, font=F(21, 650 if active else 450), fill=INK if active else (110, 118, 126))
            y += 40 + 27 * max(1, len(lines)) + 10
        # bisel del teléfono
        d.rounded_rectangle([PH_X - 14, PH_Y - 14, PH_X + PH_W + 14, PH_Y + PH_H + 14], radius=72, fill=(28, 28, 31))
        d.rounded_rectangle([PH_X - 15, PH_Y - 15, PH_X + PH_W + 15, PH_Y + PH_H + 15], radius=73, outline=(80, 80, 86), width=2)
        # panel derecho
        x0, wpanel = 1000, 840
        if phone:
            ph = self.meta['phones'][phone]
            f = F(21, 700)
            tw = f.getlength(ph['label'])
            d.rounded_rectangle([x0, 92, x0 + tw + 36, 132], radius=20, fill=hexcol(ph['color']))
            d.text((x0 + 18, 112), ph['label'], font=f, fill=(255, 255, 255), anchor='lm')
        if chapter:
            d.text((x0, 172), f"CAPÍTULO {chapter} · {self.meta['chapters'][str(chapter)].upper()}", font=F(21, 700), fill=GREEN_D)
        yy = 216
        if cap:
            for ln in wrap_px(cap['title'], F(50, 760), wpanel):
                d.text((x0, yy), ln, font=F(50, 760), fill=INK)
                yy += 62
            yy += 16
            for ln in wrap_px(cap['body'], F(30, 420), wpanel):
                d.text((x0, yy), ln, font=F(30, 420), fill=SUB)
                yy += 44
            if cap.get('tech'):
                yy += 26
                f = F(22, 600)
                lines = wrap_px(cap['tech'], f, wpanel - 160)
                hh = 22 + 32 * len(lines)
                d.rounded_rectangle([x0, yy, x0 + wpanel, yy + hh + 12], radius=14, fill=(226, 240, 233), outline=(170, 210, 192), width=2)
                d.text((x0 + 20, yy + 18), 'DETRÁS', font=F(17, 750), fill=GREEN_D)
                for k, ln in enumerate(lines):
                    d.text((x0 + 120, yy + 14 + k * 32), ln, font=f, fill=(20, 80, 60))
        self.footer(d)
        self._base[key] = im
        return im

    def footer(self, d):
        if not self.meta.get('watermark'):
            return
        f = F(22, 750)
        t = self.meta['watermark']
        tw = f.getlength(t)
        x0, y0 = 1000, SH - 128
        d.rounded_rectangle([x0, y0, x0 + tw + 40, y0 + 44], radius=22, fill=(150, 72, 40))
        d.text((x0 + 20, y0 + 22), t, font=f, fill=(255, 255, 255), anchor='lm')
        for k, ln in enumerate(wrap_px(self.meta.get('disclaimer', ''), F(19, 450), SW - x0 - 60)):
            d.text((x0, SH - 62 + k * 26), ln, font=F(19, 450), fill=(100, 106, 112))

    def compose(self, base, phone_rgb):
        im = base.copy()
        scr = phone_rgb.resize((PH_W, PH_H), Image.LANCZOS)
        im.paste(scr, (PH_X, PH_Y), self.mask)
        return im

    def card(self, step, under=None, t=1.0):
        kind = step['kind']
        if kind == 'timejump':
            im = under.copy() if under is not None else Image.new('RGB', (SW, SH), BG)
            ov = Image.new('RGBA', (SW, SH), (12, 18, 24, int(170 * ease(t * 3))))
            im = Image.alpha_composite(im.convert('RGBA'), ov)
            d = ImageDraw.Draw(im)
            cw, ch = 1080, 380
            cx, cy = (SW - cw) // 2, (SH - ch) // 2 - 20
            a = ease(t * 3)
            if a > 0.05:
                d.rounded_rectangle([cx, cy, cx + cw, cy + ch], radius=28, fill=(255, 255, 255, int(255 * a)))
                if step.get('body'):
                    d.text((cx + 60, cy + 54), step['title'].upper(), font=F(24, 750), fill=(150, 72, 40))
                    d.text((cx + 60, cy + 100), step['body'], font=F(52, 760), fill=INK)
                else:
                    d.text((cx + 60, cy + 92), step['title'], font=F(64, 780), fill=INK)
                # barra de progreso del salto
                bx, by = cx + 60, cy + 196
                d.rounded_rectangle([bx, by, cx + cw - 60, by + 14], radius=7, fill=(225, 228, 232))
                d.rounded_rectangle([bx, by, bx + (cw - 120) * ease(t * 1.3), by + 14], radius=7, fill=GREEN_D)
                for k, ln in enumerate(wrap_px(step.get('note', ''), F(28, 420), cw - 120)):
                    d.text((cx + 60, cy + 240 + k * 40), ln, font=F(28, 420), fill=SUB)
            im = im.convert('RGB')
            self.footer(ImageDraw.Draw(im))
            return im
        im = Image.new('RGB', (SW, SH), (17, 27, 33))
        d = ImageDraw.Draw(im)
        x0 = 160
        if kind == 'intro':
            d.text((x0, 300), step['title'], font=F(86, 800), fill=(255, 255, 255))
            yy = 430
            for ln in wrap_px(step['body'], F(38, 420), 1300):
                d.text((x0, yy), ln, font=F(38, 420), fill=(210, 220, 225))
                yy += 54
            yy += 40
        else:
            yy = 180
            for ln in wrap_px(step['title'], F(58, 800), 1500):
                d.text((x0, yy), ln, font=F(58, 800), fill=(255, 255, 255))
                yy += 74
            yy += 30
            for b in step.get('bullets', []):
                d.ellipse([x0, yy + 16, x0 + 14, yy + 30], fill=rm.GREEN)
                for k, ln in enumerate(wrap_px(b, F(34, 450), 1400)):
                    d.text((x0 + 36, yy + k * 46), ln, font=F(34, 450), fill=(220, 228, 232))
                yy += 46 * len(wrap_px(b, F(34, 450), 1400)) + 18
            yy += 30
        if self.meta.get('watermark'):
            d.rounded_rectangle([x0, yy, x0 + 620, yy + 52], radius=26, fill=(150, 72, 40))
            d.text((x0 + 310, yy + 26), self.meta['watermark'], font=F(24, 750), fill=(255, 255, 255), anchor='mm')
        for k, ln in enumerate(wrap_px(step.get('note', ''), F(26, 420), 1500)):
            d.text((x0, yy + 84 + k * 38), ln, font=F(26, 420), fill=(170, 182, 190))
        return im


# ---------- director ----------

class Director:
    def __init__(self, spec, tl, sink, keyframes=None):
        self.spec, self.tl, self.sink = spec, tl, sink
        self.keyframes = Path(keyframes) if keyframes else None
        self.keys = []
        self.last_phone = None
        self.snap = None
        self.meta = tl['meta']
        self.fps = self.meta['fps']
        self.screens = {sc['id']: sc for sc in spec['screens']}
        self.phone = Phone(spec)
        self.stage = Stage(self.meta)
        self.chats = {k: [] for k in self.meta['chats']}
        self.views = {}
        for k, v in self.meta['chats'].items():
            sc = self.screens[v['screen']]
            self.views[k] = {'header': sc['header'], 'seed': int(v['screen'])}
        self.view = None          # ('chat', key) | ('static', rgb)
        self.clock = '9:10'
        self.chapter = 0
        self.who = None
        self.cap = None
        self.last = None
        self.frames = 0
        self.uid = 0
        self.log = []

    # salida
    def emit(self, im, n=1):
        self.last = im
        for _ in range(n):
            self.sink(im)
            self.frames += 1

    def nf(self, sec):
        return max(1, round(sec * self.fps))

    def compose(self, phone_rgb):
        self.last_phone = phone_rgb
        return self.stage.compose(self.base(), phone_rgb)

    def save_key(self, s):
        k = s.get('key')
        if not k or not self.keyframes:
            return
        ph = self.snap or self.last_phone
        out = self.keyframes / k['scene'] / f"{k['name']}.png"
        out.parent.mkdir(parents=True, exist_ok=True)
        ph.save(out, optimize=True)
        self.keys.append({'scene': k['scene'], 'file': f"{k['scene']}/{k['name']}.png",
                          't': round(self.frames / self.fps, 2), 'step': s['op'], 'ref': s.get('ref') or s.get('screen') or s.get('chat')})

    def base(self):
        return self.stage.base(self.chapter, self.who, self.cap)

    def msg(self, ref):
        sid, idx = ref.split(':')
        m = dict(self.screens[sid]['messages'][int(idx)])
        self.uid += 1
        m['uid'] = f"{ref}#{self.uid}"
        return m

    def cur_phone(self, **kw):
        kind, val = self.view
        if kind == 'chat':
            return self.phone.chat(self.views[val], self.chats[val], self.clock, **kw)
        return val

    def still(self, sec):
        frame = self.compose(self.cur_phone())
        self.emit(frame, self.nf(sec))

    @staticmethod
    def read_hold(m):
        txt = plain(m.get('text') or m.get('caption') or '')
        return min(2.6, max(0.8, 0.45 + 0.02 * len(txt)))

    # operaciones
    def op_card(self, s):
        n = self.nf(s['dur'])
        if s['kind'] == 'timejump':
            under = self.last
            for i in range(n):
                self.emit(self.stage.card(s, under, i / n))
        else:
            im = self.stage.card(s)
            fade = self.nf(0.5)
            prev = self.last
            for i in range(n):
                fr = im
                if prev is not None and i < fade:
                    fr = Image.blend(prev, im, ease_io(i / fade))
                self.emit(fr)
        self.last_card = True

    def op_chapter(self, s):
        self.chapter = s['n']

    def op_phone(self, s):
        old = self.last
        self.who = s['who']
        self._pending_fade = old

    def op_caption(self, s):
        old = self.last
        self.cap = {k: s[k] for k in ('title', 'body', 'tech') if k in s}
        if self.view is None or old is None:
            return
        new = self.compose(self.cur_phone())
        self.crossfade(old, new, 0.4)

    def crossfade(self, a, b, sec):
        n = self.nf(sec)
        for i in range(n):
            self.emit(Image.blend(a, b, ease_io((i + 1) / n)))

    def _switch(self, new_view, transition):
        old_phone = self.cur_phone() if self.view else None
        old_frame = self.last
        self.view = new_view
        new_phone = self.cur_phone()
        if transition in ('push', 'pop') and old_phone is not None:
            n = self.nf(0.45)
            Wp = old_phone.width
            for i in range(n):
                e = ease_io((i + 1) / n)
                canvas = Image.new('RGB', old_phone.size)
                if transition == 'push':
                    a, b, xa, xb = old_phone, new_phone, -int(0.3 * Wp * e), int(Wp * (1 - e))
                    under, over, xu, xo = a, b, xa, xb
                    dim = 0.25 * e
                else:
                    under, over = new_phone, old_phone
                    xu, xo = -int(0.3 * Wp * (1 - e)), int(Wp * e)
                    dim = 0.25 * (1 - e)
                canvas.paste(under, (xu, 0))
                if dim > 0:
                    canvas = Image.blend(canvas, Image.new('RGB', canvas.size, (0, 0, 0)), dim)
                canvas.paste(over, (xo, 0))
                self.emit(self.compose(canvas))
        elif transition == 'fade' or old_frame is not None:
            new = self.compose(new_phone)
            if old_frame is not None:
                self.crossfade(old_frame, new, 0.5 if transition == 'fade' else 0.3)
            else:
                self.emit(new)
        else:
            self.emit(self.compose(new_phone))

    def op_open(self, s):
        key = s['chat']
        for r in s.get('preload', []):
            if not any(m['uid'].split('#')[0] == r for m in self.chats[key]):
                self.chats[key].append(self.msg(r))
        if s.get('clock'):
            self.clock = s['clock']
        self._switch(('chat', key), s.get('transition', 'cut'))
        self.still(0.2)

    def op_chatlist(self, s):
        sc = dict(self.screens[s['screen']])
        self.clock = sc['clock']
        rgb = rm.render_chatlist(sc, self.spec['avatars']).convert('RGB')
        self._switch(('static', rgb), s.get('transition', 'cut'))
        self.still(0.9)

    def op_page(self, s):
        sc = self.screens[s['screen']]
        self.clock = sc['clock']
        if sc['type'] == 'checkout':
            rgb = rm.render_checkout(sc, self.spec['avatars']).convert('RGB')
        else:
            rgb = rm.render_codiqr(sc, self.spec['avatars']).convert('RGB')
        self._switch(('static', rgb), s.get('transition', 'fade'))
        self.still(s.get('hold', 3.0))

    def op_tap(self, s):
        ph = self.cur_phone()
        n = self.nf(0.45)
        for i in range(n):
            self.emit(self.compose(tap_overlay(ph, s['x'], s['y'], i / n)))

    def _append(self, key, m, hold=None, **kw):
        prev = list(self.chats[key])
        self.chats[key].append(m)
        if m.get('time'):
            self.clock = m['time']
        n = self.nf(0.34)
        view = self.views[key]
        for i in range(n):
            ph = self.phone.chat(view, self.chats[key], self.clock, anim=(prev, (i + 1) / n), **kw)
            self.emit(self.compose(ph))
        if hold is None:
            hold = self.read_hold(m)
        if hold:
            self.still(hold)

    def op_appear(self, s):
        key = self.view[1]
        if s.get('clock'):
            self.clock = s['clock']
        self._append(key, self.msg(s['ref']), s.get('hold'))

    def op_send(self, s):
        key = self.view[1]
        m = self.msg(s['ref'])
        txt = m['text']
        view = self.views[key]
        dur = min(1.25, 0.25 + 0.04 * len(txt))
        n = self.nf(dur)
        for i in range(n):
            k = max(1, round(len(txt) * (i + 1) / n))
            ph = self.phone.chat(view, self.chats[key], self.clock, composer=txt[:k], caret=(i // 8) % 2 == 0)
            self.emit(self.compose(ph))
        ph = self.phone.chat(view, self.chats[key], self.clock, composer=txt, caret=False)
        nt = self.nf(0.3)
        for i in range(nt):
            self.emit(self.compose(tap_overlay(ph, 368, rm.INPUT_TOP + 26, i / nt)))
        self._append(key, m, s.get('hold'))

    def op_recv(self, s):
        key = self.view[1]
        m = self.msg(s['ref'])
        view = self.views[key]
        typ = {'kind': 'typing', 'dir': 'in', 'uid': f"typing#{self.uid}"}
        prev = list(self.chats[key])
        self.chats[key].append(typ)
        sub = 'escribiendo…'
        n = self.nf(0.25)
        for i in range(n):
            ph = self.phone.chat(view, self.chats[key], self.clock, anim=(prev, (i + 1) / n), subtitle=sub)
            self.emit(self.compose(ph))
        n = self.nf(s.get('typing', 0.6))
        for i in range(n):
            ph = self.phone.chat(view, self.chats[key], self.clock, subtitle=sub, typing_phase=i / self.fps)
            self.emit(self.compose(ph))
        self.chats[key].pop()
        self._append(key, m, s.get('hold'))

    def op_banner(self, s):
        m = self.msg(s['ref'])
        title = 'Agente de cobros' if s['from'] == 'agent' else self.views[s['from']]['header']['name']
        body = plain(m.get('text', ''))
        ph_kw = {}
        n_in, n_hold = self.nf(0.4), self.nf(1.15)
        def phone_with(t):
            kind, val = self.view
            if kind == 'chat':
                return self.phone.chat(self.views[val], self.chats[val], self.clock, banner=(title, body, t))
            im = val.convert('RGBA')
            self.phone.draw_banner(im, title, body, t)
            return im.convert('RGB')
        for i in range(n_in):
            self.emit(self.compose(phone_with((i + 1) / n_in)))
        full = phone_with(1.0)
        self.snap = full
        self.emit(self.compose(full), n_hold)
        nt = self.nf(0.35)
        for i in range(nt):
            self.emit(self.compose(tap_overlay(full, 196, 50, i / nt)))

    def run(self):
        for s in self.tl['steps']:
            t0 = self.frames / self.fps
            op = getattr(self, 'op_' + s['op'])
            pend = getattr(self, '_pending_fade', None)
            self.snap = None
            op(s)
            self.save_key(s)
            self.log.append((round(t0, 2), s['op'], s.get('ref') or s.get('title') or s.get('chat') or s.get('who') or s.get('screen') or ''))
        # cola final
        self.emit(self.last, self.nf(0.8))
        return self.frames / self.fps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=None)
    ap.add_argument('--frames', default=None, help='carpeta para PNG sueltos')
    ap.add_argument('--at', nargs='*', type=float, default=[])
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--crf', default='20')
    ap.add_argument('--keyframes', default=None, help='carpeta: PNG del teléfono (sin escenario) en los pasos con "key"')
    a = ap.parse_args()
    spec = json.loads((HERE.parent / 'screens.json').read_text(encoding='utf-8'))
    tl = json.loads((HERE / 'timeline.json').read_text(encoding='utf-8'))
    rm.CLEAN = bool(tl['meta'].get('clean'))
    spec = rm.apply_clean(spec)
    fps = tl['meta']['fps']
    proc = None
    want = {round(t * fps): t for t in a.at}
    state = {'i': 0}
    if a.frames:
        Path(a.frames).mkdir(parents=True, exist_ok=True)
    if a.out:
        proc = subprocess.Popen([
            'ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
            '-s', f'{SW}x{SH}', '-r', str(fps), '-i', '-',
            '-c:v', 'libx264', '-preset', 'slow', '-crf', a.crf, '-tune', 'animation',
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-r', str(fps), a.out], stdin=subprocess.PIPE)
    cache = {'id': None, 'bytes': None}

    def sink(im):
        i = state['i']
        if proc:
            if cache['id'] is not im:
                cache['id'], cache['bytes'] = im, im.tobytes()
            proc.stdin.write(cache['bytes'])
        if i in want and a.frames:
            im.save(Path(a.frames) / f"frame-{want[i]:07.2f}s.png")
        state['i'] += 1

    if a.dry_run or (a.keyframes and not a.out):
        sink = lambda im: state.__setitem__('i', state['i'] + 1)  # noqa: E731
    d = Director(spec, tl, sink, a.keyframes)
    total = d.run()
    if a.keyframes:
        (Path(a.keyframes) / 'manifest.json').write_text(json.dumps(d.keys, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if proc:
        proc.stdin.close()
        proc.wait()
    for t, op, what in d.log:
        print(f"{t:7.2f}s  {op:8s} {what}")
    print(f"duración {total:.2f} s, {d.frames} fotogramas")


if __name__ == '__main__':
    main()
