#!/usr/bin/env python3
"""Render a faithful mockup screenshot of Minimal from the design spec.

This is NOT a screenshot of the compiled macOS app (that can only
run on a Mac). It draws, pixel-for-pixel from the spec in
Sources/TopBarView.swift and Sources/SidebarView.swift:
  - 28px slim top bar, almost transparent glass, back/forward/...
  - vertical tabs on the right, 220px wide, shown on hover
  - the same state in a second image with the sidebar hidden
"""
from PIL import Image, ImageDraw, ImageFont
import textwrap, os

W, H = 1280, 800
OUT = os.path.dirname(os.path.abspath(__file__))

def font(size, bold=False):
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    for base in ("/usr/share/fonts/truetype/dejavu/",):
        p = os.path.join(base, name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

def wrap(draw, text, fnt, max_w):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=fnt) <= max_w:
            cur = t
        else:
            lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines

def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size[0]-1, size[1]-1], radius=radius, fill=255)
    return m

def render(sidebar_open, out_path):
    # Desktop + soft shadow
    img = Image.new("RGB", (W, H), (231, 231, 236))
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle([28, 28, 1252, 772], radius=14, fill=(0, 0, 0, 70))
    from PIL import ImageFilter
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    img.paste(shadow, (0, 0), shadow)

    # Window content, clipped to rounded corners
    win = Image.new("RGB", (1240, 760), (255, 255, 255))
    d = ImageDraw.Draw(win)
    # Hero gradient (top 300px)
    top = (168, 200, 232); mid = (232, 213, 196); bot = (196, 216, 200)
    for y in range(300):
        t = y / 300
        c1 = tuple(int(top[i] + (mid[i]-top[i]) * min(t*2, 1)) for i in range(3)) if t < 0.5 else tuple(int(mid[i] + (bot[i]-mid[i]) * (t-0.5)*2) for i in range(3))
        d.line([(0, y), (1240, y)], fill=c1)
    # Hero pill
    d.rounded_rectangle([48, 248, 215, 274], radius=13, fill=(255, 255, 255, 220))
    d.text((60, 254), "DESIGN  ·  MINIMAL", font=font(11, True), fill=(60, 60, 60))
    # Article
    x, y = 48, 328
    d.text((x, y), "The quiet browser: less chrome, more page", font=font(34, True), fill=(29, 29, 31)); y += 52
    d.text((x, y), "A clean article, with nothing in the way — the whole point of the slim bar." if sidebar_open else "Normal browsing — tabs hidden, top bar barely there.", font=font(14), fill=(134, 134, 139)); y += 36
    paras = [
        "This is what a page looks like in Minimal. The top bar is only 28 points tall and almost completely transparent, so the article itself starts almost at the very top of the window.",
        "Tabs live on the right, hidden until you need them. Move your mouse to the right edge and this sidebar slides out over the page — it never squeezes the article sideways." if sidebar_open else "Hover the right edge and the vertical tabs slide out. Move away and they disappear again — the page never reflows.",
        "Back, forward, and the three-dot menu are the only controls up top. Everything else — a new tab, a URL, the blocker — lives in the menu or on the new-tab page.",
    ]
    max_w = 700 if sidebar_open else 820
    for p in paras:
        for line in wrap(d, p, font(16), max_w):
            d.text((x, y), line, font=font(16), fill=(51, 51, 51)); y += 26
        y += 14

    # Sidebar (glass, over the page) — drawn before the top bar so the bar stays on top
    if sidebar_open:
        side = Image.new("RGBA", (220, 760), (246, 246, 248, 185))
        win.paste(side, (1020, 0), side)
        d.line([(1020, 0), (1020, 760)], fill=(0, 0, 0, 25))
        tabs = [("Q", "The quiet browser: less…", True), ("D", "DuckDuckGo — search", False),
                ("G", "GitHub — minimal-browser", False), ("N", "New Tab", False)]
        ty = 40
        for letter, title, active in tabs:
            if active:
                d.rounded_rectangle([1028, ty, 1232, ty+30], radius=8, fill=(0, 122, 255, 38))
            d.ellipse([1036, ty+6, 1054, ty+24], fill=(0, 122, 255) if active else (210, 210, 215))
            d.text((1043, ty+8), letter, font=font(10, True), fill=(255, 255, 255) if active else (85, 85, 85))
            d.text((1060, ty+7), title, font=font(13), fill=(29, 29, 31) if active else (110, 110, 115))
            if active:
                d.text((1214, ty+6), "×", font=font(16), fill=(134, 134, 139))
            ty += 34
        d.text((1028, 722), "+  New Tab", font=font(13), fill=(110, 110, 115))
        # Hover hint
        d.rounded_rectangle([872, 118, 1012, 142], radius=6, fill=(29, 29, 31))
        d.text((884, 124), "◀ hovered right edge", font=font(12), fill=(255, 255, 255))

    # Top bar: almost-transparent glass over the page
    glass = Image.new("RGBA", (1240, 28), (255, 255, 255, 8))
    win.paste(glass, (0, 0), glass)
    d.line([(0, 27), (1240, 27)], fill=(0, 0, 0, 18))
    # Traffic lights
    for i, col in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
        d.ellipse([12 + i*20, 8, 24 + i*20, 20], fill=col)
    # Back / forward, offset 76px for the traffic lights (as in code)
    d.text((76, 4), "‹", font=font(18), fill=(29, 29, 31))
    d.text((104, 4), "›", font=font(18), fill=(29, 29, 31))
    # Options, right edge
    d.text((1202, 6), "⋯", font=font(18), fill=(29, 29, 31))
    # Progress line (open state only, as in the mockup)
    if sidebar_open:
        d.rectangle([0, 27, int(1240*0.38), 29], fill=(0, 122, 255))

    win.putalpha(255)
    img.paste(win, (20, 20), rounded_mask((1240, 760), 12))
    img.save(out_path)
    print(out_path, img.size)

if __name__ == "__main__":
    render(True, os.path.join(OUT, "screenshot-tabs-open.png"))
    render(False, os.path.join(OUT, "screenshot-tabs-hidden.png"))
