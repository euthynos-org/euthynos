"""
Generates the two README visuals into assets/:

  scan-demo.gif   animated terminal replay of `euthynos scan` on hono
  benchmark.png   grouped bars of the frozen M2 token medians

Both are drawn natively with Pillow. There is no SVG rasteriser on this box,
and `convert.exe` on Windows is the FAT-to-NTFS filesystem converter, not
ImageMagick -- do not reach for it.

The terminal text is captured verbatim from a real run against hono @26de7313.
The benchmark numbers come from the frozen M2 record. Neither is retyped by
hand anywhere else; edit here and regenerate.

    python scripts/make-readme-assets.py
"""

import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "assets")
os.makedirs(OUT, exist_ok=True)

# ----------------------------------------------------------------- palette
INK   = (13, 15, 21)
CHROME= (25, 28, 36)
LINE  = (35, 39, 51)
FG    = (237, 239, 243)
FG2   = (166, 173, 188)
FG3   = (110, 118, 134)
TEAL  = (79, 199, 206)
WARN  = (217, 164, 65)
BAD   = (210, 104, 106)
S_MCP = (10, 160, 169)
S_BASE= (123, 111, 216)

F = "C:/Windows/Fonts/"
def _font(cands, size):
    for c in cands:
        try:
            return ImageFont.truetype(F + c, size)
        except Exception:
            pass
    return ImageFont.load_default()

MONO  = lambda s: _font(["consola.ttf", "cour.ttf"], s)
MONOB = lambda s: _font(["consolab.ttf", "courbd.ttf"], s)
SANS  = lambda s: _font(["segoeui.ttf", "arial.ttf"], s)
SANSB = lambda s: _font(["segoeuib.ttf", "arialbd.ttf"], s)

# ------------------------------------------------------------ scan output
# (text, colour) -- verbatim from `euthynos scan` on hono @26de7313.
# Segments let one line carry more than one colour.
D = "\u2500" * 62
BAR = "\u2588" * 27
LT  = "\u2591" * 13

LINES = [
    [("", FG)],
    # The real CLI prints U+25C9 here. Consolas has no glyph for it and renders
    # tofu, so the mark is drawn (see MARK_LINE) rather than typed.
    [("    Euthynos", FG), ("  architecture scan \u00b7 382 files \u00b7 13 modules", FG3)],
    [("  " + D, LINE)],
    [("", FG)],
    [("  Architecture Health  ", FG), ("68", TEAL), ("/100  ", FG3), ("[Stable]", TEAL)],
    [("  " + BAR, TEAL), (LT, LINE), ("  68%", FG3)],
    [("", FG)],
    [("  Depth ", FG3), ("60", TEAL), ("    Seams ", FG3), ("65", TEAL),
     ("    Locality ", FG3), ("88", TEAL), ("    Leverage ", FG3), ("36", WARN),
     ("    Contam ", FG3), ("15", TEAL)],
    [("", FG)],
    [("  Modules", FG), ("  (sorted by depth, worst first)", FG3)],
    [("  module           depth          seams         leverage      callers", FG3)],
    [("  helper            ", FG2), ("46", WARN), (" Shallow    ", FG3), ("67", TEAL), (" Adequate   ", FG3), ("59", WARN), (" Underutil.     8", FG3)],
    [("  utils             ", FG2), ("46", WARN), (" Shallow    ", FG3), ("45", WARN), (" Weak       ", FG3), ("69", TEAL), (" Good          10", FG3)],
    [("  preset            ", FG2), ("47", WARN), (" Shallow    ", FG3), ("65", TEAL), (" Adequate   ", FG3), ("10", BAD),  (" Dead Weight    0", FG3)],
    [("  adapter           ", FG2), ("48", WARN), (" Shallow   ", FG3), ("100", TEAL), (" Healthy    ", FG3), ("23", BAD),  (" Dead Weight    2", FG3)],
    [("  client            ", FG2), ("51", WARN), (" Shallow    ", FG3), ("67", TEAL), (" Adequate   ", FG3), ("21", BAD),  (" Dead Weight    3", FG3)],
    [("  jsx               ", FG2), ("55", WARN), (" Shallow    ", FG3), ("51", WARN), (" Weak       ", FG3), ("26", BAD),  (" Dead Weight    4", FG3)],
    [("  validator         ", FG2), ("60", TEAL), (" Moderate   ", FG3), ("75", TEAL), (" Adequate   ", FG3), ("31", BAD),  (" Dead Weight    3", FG3)],
    [("  middleware        ", FG2), ("64", TEAL), (" Moderate   ", FG3), ("67", TEAL), (" Adequate   ", FG3), ("38", WARN), (" Dead Weight    5", FG3)],
    [("  router            ", FG2), ("69", TEAL), (" Moderate   ", FG3), ("51", WARN), (" Weak       ", FG3), ("66", TEAL), (" Good           6", FG3)],
    [("  benchmarks        ", FG2), ("71", TEAL), (" Moderate   ", FG3), ("55", WARN), (" Weak       ", FG3), ("10", BAD),  (" Dead Weight    0", FG3)],
    [("  (root)            ", FG2), ("74", TEAL), (" Moderate   ", FG3), ("45", WARN), (" Weak       ", FG3), ("68", TEAL), (" Good          11", FG3)],
    [("  runtime-tests     ", FG2), ("74", TEAL), (" Moderate  ", FG3), ("100", TEAL), (" Healthy    ", FG3), ("10", BAD),  (" Dead Weight    0", FG3)],
    [("  perf-measures     ", FG2), ("75", TEAL), (" Moderate   ", FG3), ("55", WARN), (" Weak      ", FG3),  ("n/a", FG3), ("            0", FG3)],
    [("", FG)],
    [("  Contamination  ", FG), ("15", TEAL), ("/100 \u00b7 lower is better  ", FG3), ("[Minor]", TEAL)],
    [("   no cross-module duplicate logic detected", FG3)],
    [("", FG)],
    # No wall-clock figure here: V1 publishes no precise latency numbers
    # (see ../docs/PROVENANCE.md), and this frame is a rendered image, so a stale
    # figure baked in here would survive every text-based claims scan.
    [("  scan complete", FG3)],
]

CMD = "euthynos scan ."

MARK_LINE = 1          # index in LINES that gets the drawn brand mark

W, H = 900, 660
PAD, TOP = 22, 46
LH = 19
FS = MONO(13)
CMDF = MONO(14)


def frame(typed, n_lines, caret):
    """One GIF frame: chrome, the command as typed so far, n output lines."""
    im = Image.new("RGB", (W, H), INK)
    d = ImageDraw.Draw(im)

    d.rectangle([0, 0, W, 34], fill=CHROME)
    d.line([(0, 34), (W, 34)], fill=LINE)
    for i, c in enumerate([(43, 48, 60)] * 3):
        d.ellipse([16 + i * 18, 12, 26 + i * 18, 22], fill=c)
    d.text((W - 20, 11), "hono \u2014 382 files", font=MONO(12), fill=FG3, anchor="ra")

    d.text((PAD, TOP), "$", font=CMDF, fill=TEAL)
    d.text((PAD + 16, TOP), typed, font=CMDF, fill=FG)
    if caret:
        cw = d.textlength(typed, font=CMDF)
        d.rectangle([PAD + 18 + cw, TOP, PAD + 25 + cw, TOP + 16], fill=TEAL)

    y = TOP + 32
    for idx, line in enumerate(LINES[:n_lines]):
        x = PAD
        for text, col in line:
            if text:
                d.text((x, y), text, font=FS, fill=col)
                x += d.textlength(text, font=FS)
        # Line 1 carries the brand mark: a ring with a filled centre, drawn so
        # it does not depend on the terminal font having U+25C9.
        if idx == MARK_LINE:
            cx, cy, r = PAD + 8, y + 8, 5
            d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=TEAL, width=2)
            d.ellipse([cx - 2, cy - 2, cx + 2, cy + 2], fill=TEAL)
        y += LH
    return im


def build_gif():
    frames, durs = [], []

    frames.append(frame("", 0, True)); durs.append(700)
    for i in range(1, len(CMD) + 1):          # typing
        frames.append(frame(CMD[:i], 0, True)); durs.append(55)
    frames.append(frame(CMD, 0, True)); durs.append(850)   # the scan itself

    for n in range(1, len(LINES) + 1):        # output streams in
        frames.append(frame(CMD, n, True)); durs.append(70)

    frames.append(frame(CMD, len(LINES), False)); durs.append(4200)  # hold

    # Quantise to a shared adaptive palette; the terminal uses few colours, so
    # 64 is plenty and keeps the file small enough to sit in a README.
    pal = [f.convert("P", palette=Image.ADAPTIVE, colors=64) for f in frames]
    pal[0].save(os.path.join(OUT, "scan-demo.gif"), save_all=True,
                append_images=pal[1:], duration=durs, loop=0, optimize=True, disposal=2)
    kb = os.path.getsize(os.path.join(OUT, "scan-demo.gif")) / 1024
    print("  assets/scan-demo.gif   %d frames, %.0f KB" % (len(frames), kb))


# ------------------------------------------------------------- benchmark
DATA = [("callers", 70878, 49476, 12),
        ("similar-logic", 33429, 29120, 15),
        ("blast-radius", 56481, 39242, 15)]


def build_chart():
    W2, H2 = 1000, 540
    im = Image.new("RGB", (W2, H2), INK)
    d = ImageDraw.Draw(im)

    def ctr(x, y, t, f, fill):
        b = d.textbbox((0, 0), t, font=f)
        d.text((x - (b[2] - b[0]) / 2, y - (b[3] - b[1]) / 2), t, font=f, fill=fill)

    d.text((70, 34), "Same answers, fewer tokens", font=SANSB(28), fill=FG)
    d.text((70, 72), "Median fresh input tokens per task \u2014 M2, preregistered, hono, n=3 per cell",
           font=SANS(14), fill=FG2)

    padL, padT, plotH = 70, 140, 250
    plotW = W2 - padL - 60
    MAX = 80000
    yv = lambda v: padT + plotH - (v / MAX) * plotH

    for t in range(0, 80001, 20000):
        d.line([(padL, yv(t)), (W2 - 60, yv(t))], fill=LINE)
        d.text((padL - 12, yv(t) - 7), "%dk" % (t // 1000), font=MONO(11), fill=FG3, anchor="ra")

    d.rounded_rectangle([padL, padT - 28, padL + 10, padT - 18], 2, fill=S_BASE)
    d.text((padL + 16, padT - 30), "baseline (Read/Grep/Glob)", font=SANS(12), fill=FG2)
    d.rounded_rectangle([padL + 210, padT - 28, padL + 220, padT - 18], 2, fill=S_MCP)
    d.text((padL + 226, padT - 30), "euthynos (MCP)", font=SANS(12), fill=FG2)

    gw, barW, gap = plotW / len(DATA), 62, 2
    for i, (task, base, mcp, slots) in enumerate(DATA):
        cx = padL + gw * i + gw / 2
        x0 = cx - (barW * 2 + gap) / 2
        for j, (val, col) in enumerate([(base, S_BASE), (mcp, S_MCP)]):
            bx, by = x0 + j * (barW + gap), yv(val)
            d.rounded_rectangle([bx, by, bx + barW, padT + plotH], 4, fill=col)
            d.rectangle([bx, padT + plotH - 6, bx + barW, padT + plotH], fill=col)
            ctr(bx + barW / 2, by - 12, "{:,}".format(val), MONO(12), FG2)
        ctr(cx, padT + plotH + 22, task, MONO(13), FG)
        ctr(cx, padT + plotH + 43, "-%d%%" % round((base - mcp) / base * 100), MONOB(14), S_MCP)
        ctr(cx, padT + plotH + 63, "recall %d/%d \u00b7 both arms" % (slots, slots), MONO(10), FG3)

    d.line([(padL, padT + plotH), (W2 - 60, padT + plotH)], fill=(58, 65, 80))

    d.text((70, H2 - 52), "Answer keys frozen by commit before any session ran \u00b7 21 of 42 sessions valid",
           font=MONO(11), fill=FG3)
    d.text((70, H2 - 34), "2 of 7 tasks unmeasured (session limit) \u00b7 one repo, one model \u00b7 no per-tool isolation",
           font=MONO(11), fill=FG3)

    im.save(os.path.join(OUT, "benchmark.png"), "PNG")
    print("  assets/benchmark.png   %dx%d" % im.size)


build_gif()
build_chart()
