#!/usr/bin/env python3
"""Regenerate every icon/brand bitmap from assets/brand/*.svg.

Developer tool only (end users never run this). Needs:
    pip install playwright pillow && playwright install chromium

Outputs:
    build/icon.png, build/icon.ico, build/icon.icns       app + installers
    build/tray.png, build/trayTemplate.png(@2x)           tray (Windows / macOS)
    build/appx/*.png                                      Microsoft Store tiles
    build/installerSidebar.bmp, build/dmg-background.png  installer art
    src/public/brand/*                                    web: favicon, phone app icon, logo
    src/main/icons/*                                      copies the desktop app loads at runtime
"""
import asyncio
import pathlib
from io import BytesIO

from PIL import Image
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
BRAND = ROOT / "assets" / "brand"
BUILD = ROOT / "build"
WEB = ROOT / "src" / "public" / "brand"
LOGO = (BRAND / "logo.svg").read_text()
GLYPH = (BRAND / "glyph.svg").read_text()


async def render(page, html, w, h):
    await page.set_viewport_size({"width": w, "height": h})
    await page.set_content(f"<html><body style='margin:0;background:transparent'>{html}</body></html>")
    png = await page.screenshot(omit_background=True, clip={"x": 0, "y": 0, "width": w, "height": h})
    return Image.open(BytesIO(png)).convert("RGBA")


def svg(src, w, h, color=None):
    s = src.replace("<svg ", f"<svg width='{w}' height='{h}' ", 1)
    if color:
        s = s.replace("#000", color)
    return s


async def main():
    BUILD.mkdir(exist_ok=True)
    (BUILD / "appx").mkdir(exist_ok=True)
    WEB.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        page = await b.new_page()

        big = await render(page, svg(LOGO, 1024, 1024), 1024, 1024)
        big.save(BUILD / "icon.png")
        big.save(BUILD / "icon.icns")
        big.save(BUILD / "icon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])

        for size, name in [(512, "logo-512.png"), (192, "logo-192.png"), (180, "apple-touch-icon.png"), (32, "favicon-32.png")]:
            big.resize((size, size), Image.LANCZOS).save(WEB / name)
        big.save(WEB / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
        (WEB / "logo.svg").write_text(LOGO)

        # tray: colored for Windows, black template images for the macOS menu bar
        big.resize((32, 32), Image.LANCZOS).save(BUILD / "tray.png")
        for scale, suffix in [(1, ""), (2, "@2x")]:
            g = await render(page, svg(GLYPH, 16 * scale, 16 * scale), 16 * scale, 16 * scale)
            g.save(BUILD / f"trayTemplate{suffix}.png")

        # Microsoft Store tiles (logo centred on brand colour)
        def tile(w, h, scale):
            bg = Image.new("RGBA", (w, h), (91, 91, 246, 255))
            s = int(min(w, h) * scale)
            bg.alpha_composite(big.resize((s, s), Image.LANCZOS), ((w - s) // 2, (h - s) // 2))
            return bg
        for name, (w, h, sc) in {
            "StoreLogo.png": (50, 50, 1.0), "Square44x44Logo.png": (44, 44, 1.0),
            "Square150x150Logo.png": (150, 150, 0.66), "Wide310x150Logo.png": (310, 150, 0.66),
            "SmallTile.png": (71, 71, 0.8), "LargeTile.png": (310, 310, 0.6),
            "SplashScreen.png": (620, 300, 0.5),
        }.items():
            (big.resize((w, h), Image.LANCZOS) if sc == 1.0 else tile(w, h, sc)).save(BUILD / "appx" / name)

        # installer art
        side = await render(page, f"""
          <div style="width:164px;height:314px;background:linear-gradient(160deg,#8B5CF6,#2563EB);
               display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
               font-family:Segoe UI,Arial,sans-serif;color:#fff">
            {svg(LOGO, 96, 96)}
            <div style="font-size:19px;font-weight:700">PCTV Home</div>
            <div style="font-size:11px;opacity:.85;text-align:center;padding:0 14px">Your PC, as a smart TV</div>
          </div>""", 164, 314)
        side.convert("RGB").save(BUILD / "installerSidebar.bmp")
        dmg = await render(page, f"""
          <div style="width:540px;height:380px;background:linear-gradient(160deg,#F5F3FF,#E0E7FF);
               font-family:-apple-system,Helvetica,sans-serif;color:#312E81;position:relative">
            <div style="position:absolute;top:28px;width:100%;text-align:center;font-size:20px;font-weight:700">PCTV Home</div>
            <div style="position:absolute;top:58px;width:100%;text-align:center;font-size:13px;opacity:.7">Drag to Applications to install</div>
            <div style="position:absolute;top:190px;left:238px;font-size:48px;opacity:.35">→</div>
          </div>""", 540, 380)
        dmg.convert("RGB").save(BUILD / "dmg-background.png")
        await b.close()
    # runtime copies used by the desktop app (build/ is not packaged)
    rt = ROOT / "src" / "main" / "icons"
    rt.mkdir(exist_ok=True)
    for n in ("icon.png", "tray.png", "trayTemplate.png", "trayTemplate@2x.png"):
        (rt / n).write_bytes((BUILD / n).read_bytes())
    print("icons written to", BUILD, "and", WEB)


asyncio.run(main())
