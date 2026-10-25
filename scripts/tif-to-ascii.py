#!/usr/bin/env python3
"""turns a (geo)tiff into ascii art - made for Natural Earth's world rasters
(NE1_HR_LC_SR_W_DR.tif), but takes any 8-bit tiff.

no dependencies: uncompressed tiffs (Natural Earth's are) are read straight off
disk, a row at a time, so a 700MB map takes well under a second and next to no
memory. anything else (compressed, tiled, 16-bit) falls back to Pillow if it's
installed.

    scripts/tif-to-ascii.py                                # the whole world, 120 wide
    scripts/tif-to-ascii.py --width 240 --water " "         # land only, oceans blank
    scripts/tif-to-ascii.py --bbox -130,20,-60,55 --width 160  # just the US
    scripts/tif-to-ascii.py --color ansi --charset blocks   # in colour, in a terminal
    scripts/tif-to-ascii.py --color html -o world.html      # coloured, for a browser
    scripts/tif-to-ascii.py --png web/public/data/ascii-world.png  # the website's basemap

every option's default is in DEFAULTS below - change them there, or pass flags.
"""

import argparse
import bisect
import html
import struct
import sys
import zlib
from operator import itemgetter
from pathlib import Path

DEFAULTS = {
    # the tiff - by default the first one in the repo's root
    "input": None,
    # characters across. rows follow from the image's shape and --aspect
    "width": 120,
    # how much taller a character is than it is wide. 2 suits most terminal fonts
    "aspect": 2.0,
    # a named set of characters (see CHARSETS), sparsest to densest...
    "charset": "simple",
    # ...or your own, which wins over --charset
    "ramp": None,
    # light background? flip it, so dark places get the dense characters
    "invert": False,
    # applied after levels: under 1 brightens the midtones, over 1 darkens them
    "gamma": 1.0,
    # the brightness range spread over the ramp, 0-255 - "auto" picks the 1st to
    # 99th percentile of what's being drawn
    "levels": "auto",
    # samples per character, each way - more is smoother and slower
    "samples": 4,
    # draw water (oceans, lakes, rivers) as this character instead, e.g. " " or "~".
    # None treats water like everything else
    "water": None,
    # crop to west,south,east,north in degrees (needs a georeferenced tiff)
    "bbox": None,
    # none (plain text), ansi (24-bit terminal colour) or html (a coloured page)
    "color": "none",
    # where to write it - None is stdout
    "output": None,
    # instead of ascii, write the image the website draws its ascii from (see export_png)
    "png": None,
    # pixels across in that image. 4320 is 1/12 of a degree a pixel - enough for a
    # pixel per character until about zoom 7
    "png_width": 4320,
}

CHARSETS = {
    "simple": " .:-=+*#%@",
    "detailed": " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
    "blocks": " ░▒▓█",
    "dots": " ·•●",
    "binary": " #",
}

# a pixel is water when blue clearly leads - Natural Earth's oceans and lakes sit
# around (115, 168, 205), and even ice and snow are near-white
WATER_BLUE_OVER_RED = 50
WATER_BLUE_OVER_GREEN = 15


class TiffError(Exception):
    pass


class Raster:
    """an uncompressed, 8-bit, strip-based tiff, read a row at a time"""

    TYPES = {1: "B", 2: "c", 3: "H", 4: "I", 5: "II", 6: "b", 7: "B", 8: "h", 9: "i", 10: "ii", 11: "f", 12: "d", 16: "Q"}

    def __init__(self, path):
        self.f = open(path, "rb")
        order = self.f.read(2)
        if order not in (b"II", b"MM"):
            raise TiffError("not a tiff")
        self.e = "<" if order == b"II" else ">"
        magic, ifd = struct.unpack(self.e + "HI", self.f.read(6))
        if magic != 42:
            raise TiffError("BigTIFF isn't supported")
        tags = self._ifd(ifd)

        self.width, self.height = tags[256][0], tags[257][0]
        bits = tags.get(258, (1,))
        self.spp = tags.get(277, (1,))[0]
        if tags.get(259, (1,))[0] != 1:
            raise TiffError("it's compressed")
        if 322 in tags:
            raise TiffError("it's tiled")
        if any(b != 8 for b in bits):
            raise TiffError(f"{bits[0]}-bit samples")
        if tags.get(284, (1,))[0] != 1:
            raise TiffError("planar (non-interleaved) samples")
        if self.spp not in (1, 2, 3, 4):
            raise TiffError(f"{self.spp} samples per pixel")
        self.offsets = tags[273]
        self.rows_per_strip = tags.get(278, (self.height,))[0]
        self.row_bytes = self.width * self.spp

        # geotiff: where pixel (0, 0) is, and how many degrees a pixel covers
        self.geo = None
        if 33550 in tags and 33922 in tags:
            sx, sy = tags[33550][:2]
            i, j, _, x, y, _ = tags[33922][:6]
            self.geo = (x - i * sx, y + j * sy, sx, sy)  # west, north, degrees per pixel

    def _ifd(self, offset):
        self.f.seek(offset)
        (n,) = struct.unpack(self.e + "H", self.f.read(2))
        tags = {}
        for _ in range(n):
            tag, typ, count, value = struct.unpack(self.e + "HHI4s", self.f.read(12))
            fmt = self.TYPES.get(typ)
            if fmt is None or typ == 2:
                continue
            size = struct.calcsize(self.e + fmt) * count
            if size <= 4:
                raw = value[:size]
            else:
                here = self.f.tell()
                self.f.seek(struct.unpack(self.e + "I", value)[0])
                raw = self.f.read(size)
                self.f.seek(here)
            vals = struct.unpack(self.e + fmt * count, raw)
            if typ in (5, 10):  # rationals come as pairs
                vals = tuple(vals[k] / vals[k + 1] if vals[k + 1] else 0 for k in range(0, len(vals), 2))
            tags[tag] = vals
        return tags

    def row(self, y, x0, x1):
        """the bytes of pixels x0 up to x1 on row y"""
        strip, within = divmod(y, self.rows_per_strip)
        self.f.seek(self.offsets[strip] + within * self.row_bytes + x0 * self.spp)
        return self.f.read((x1 - x0) * self.spp)


class PillowRaster:
    """anything Raster can't read, if Pillow's around"""

    def __init__(self, path):
        from PIL import Image  # noqa: only needed for odd tiffs

        Image.MAX_IMAGE_PIXELS = None  # world rasters are big on purpose
        img = Image.open(path)
        self.img = img.convert("RGB")
        self.width, self.height = self.img.size
        self.spp, self.geo = 3, None
        self.data = self.img.tobytes()
        self.row_bytes = self.width * 3

    def row(self, y, x0, x1):
        start = y * self.row_bytes
        return self.data[start + x0 * 3 : start + x1 * 3]


def open_raster(path):
    try:
        return Raster(path)
    except FileNotFoundError:
        sys.exit(f"{path}: no such file")
    except TiffError as err:
        if str(err) == "not a tiff":
            sys.exit(f"{path}: not a tiff")
        try:
            return PillowRaster(path)
        except ImportError:
            sys.exit(f"{path}: {err} - `pip install pillow` to read tiffs like this one")


def window(r, bbox):
    """the pixel rectangle a west,south,east,north box covers"""
    if not bbox:
        return 0, 0, r.width, r.height
    if not r.geo:
        sys.exit("--bbox needs a georeferenced tiff, and this one has no geotiff tags")
    west, south, east, north = bbox
    if west >= east or south >= north:
        sys.exit("--bbox is WEST,SOUTH,EAST,NORTH with west < east and south < north (crossing the date line isn't supported)")
    x0w, y0n, sx, sy = r.geo
    clamp = lambda v, hi: max(0, min(hi, int(round(v))))
    x0, x1 = clamp((west - x0w) / sx, r.width), clamp((east - x0w) / sx, r.width)
    y0, y1 = clamp((y0n - north) / sy, r.height), clamp((y0n - south) / sy, r.height)
    if x1 <= x0 or y1 <= y0:
        sys.exit("--bbox doesn't overlap the image")
    return x0, y0, x1, y1


def sample(r, opts):
    """each character's average colour, brightness, and whether it's mostly water"""
    x0, y0, x1, y1 = window(r, opts.bbox)
    cols = max(1, opts.width)
    rows = max(1, round(cols * (y1 - y0) / (x1 - x0) / opts.aspect))
    n = max(1, opts.samples)
    cw, ch = (x1 - x0) / cols, (y1 - y0) / rows
    # the same sample columns on every row, as byte offsets into the row read
    xs = [int(x0 + (c + (k + 0.5) / n) * cw) for c in range(cols) for k in range(n)]
    xs = [min(x, x1 - 1) - x0 for x in xs]
    spp = r.spp

    cells = []
    for row in range(rows):
        lines = [r.row(min(int(y0 + (row + (k + 0.5) / n) * ch), y1 - 1), x0, x1) for k in range(n)]
        out = []
        for c in range(cols):
            R = G = B = wet = 0
            for line in lines:
                for x in xs[c * n : (c + 1) * n]:
                    p = x * spp
                    if spp >= 3:
                        pr, pg, pb = line[p], line[p + 1], line[p + 2]
                    else:
                        pr = pg = pb = line[p]
                    R += pr
                    G += pg
                    B += pb
                    wet += pb - pr > WATER_BLUE_OVER_RED and pb - pg > WATER_BLUE_OVER_GREEN
            k = n * n
            rgb = (R // k, G // k, B // k)
            lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
            out.append((rgb, lum, wet * 2 > k))
        cells.append(out)
    return cells


def render(cells, opts):
    ramp = opts.ramp or CHARSETS[opts.charset]
    if opts.invert:
        ramp = ramp[::-1]
    use_water = opts.water is not None

    # what the ramp spans: everything drawn with it (not water, when that has its own character)
    drawn = sorted(lum for row in cells for _, lum, wet in row if not (use_water and wet))
    if opts.levels == "auto" and drawn:
        lo = drawn[int(0.01 * (len(drawn) - 1))]
        hi = drawn[int(0.99 * (len(drawn) - 1))]
    elif opts.levels == "auto":
        lo, hi = 0, 255
    else:
        lo, hi = (float(v) for v in opts.levels.split(","))
    span = max(hi - lo, 1e-6)
    # evenly spaced thresholds, so each character covers the same slice of brightness
    steps = [(i + 1) / len(ramp) for i in range(len(ramp) - 1)]

    lines = []
    for row in cells:
        chars = []
        for rgb, lum, wet in row:
            if use_water and wet:
                ch = opts.water
            else:
                v = min(1.0, max(0.0, (lum - lo) / span)) ** opts.gamma
                ch = ramp[bisect.bisect_right(steps, v)]
            chars.append((ch, rgb))
        lines.append(chars)

    if opts.color == "ansi":
        out = []
        for chars in lines:
            line, last = [], None
            for ch, rgb in chars:
                if rgb != last and ch != " ":
                    line.append("\x1b[38;2;%d;%d;%dm" % rgb)
                    last = rgb
                line.append(ch)
            out.append("".join(line) + "\x1b[0m")
        return "\n".join(out) + "\n"

    if opts.color == "html":
        body = []
        for chars in lines:
            body.append("".join(f'<span style="color:#{r:02x}{g:02x}{b:02x}">{html.escape(ch)}</span>' if ch != " " else " " for ch, (r, g, b) in chars))
        return (
            "<!doctype html>\n<meta charset=utf-8>\n<title>ascii world</title>\n"
            "<body style=\"margin:0;background:#0b0f16\">\n"
            "<pre style=\"font:10px/1.1 ui-monospace,Menlo,monospace;margin:16px\">\n" + "\n".join(body) + "\n</pre>\n"
        )

    return "\n".join("".join(ch for ch, _ in chars).rstrip() for chars in lines) + "\n"


def export_png(r, opts):
    """the website's basemap (web/src/ascii.ts): the whole world as an image the
    site picks its characters from, live, as the map moves. red is brightness
    times how much of the pixel is land, green is how much of it is land - so the
    site can average it down for zoomed-out views without coasts smearing into
    dark land. blue's unused"""
    if opts.bbox:
        sys.exit("--png is always the whole world - leave out --bbox")
    if r.spp < 3:
        sys.exit("--png needs a colour tiff, to tell water from land")
    w = opts.png_width
    h = max(1, round(w * r.height / r.width))
    n = max(1, opts.samples)
    fx, fy = r.width / w, r.height / h
    # one getter per sample column - each pulls that column out of a whole row at C speed
    getters = [itemgetter(*[min(int((i + (k + 0.5) / n) * fx), r.width - 1) for i in range(w)]) for k in range(n)]
    if w == 1:
        getters = [lambda seq, g=g: (g(seq),) for g in getters]
    spp, k2 = r.spp, n * n

    raw = bytearray()
    for j in range(h):
        drys, lums = [], []
        for a in range(n):
            line = r.row(min(int((j + (a + 0.5) / n) * fy), r.height - 1), 0, r.width)
            R, G, B = line[0::spp], line[1::spp], line[2::spp]
            for get in getters:
                rs, gs, bs = get(R), get(G), get(B)
                dry = [not (b - r_ > WATER_BLUE_OVER_RED and b - g > WATER_BLUE_OVER_GREEN) for r_, g, b in zip(rs, gs, bs)]
                drys.append(dry)
                lums.append([(2126 * r_ + 7152 * g + 722 * b) * d for r_, g, b, d in zip(rs, gs, bs, dry)])
        land = [round(255 * c / k2) for c in map(sum, zip(*drys))]
        lit = [min(255, round(t / (10000 * k2))) for t in map(sum, zip(*lums))]
        row = bytearray(3 * w)
        row[0::3], row[1::3] = bytes(lit), bytes(land)
        raw += b"\0" + row  # filter type 0 - none

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    Path(opts.png).write_bytes(png)
    print(f"{opts.png}: {w}x{h}, {len(png) / 1e6:.1f} MB", file=sys.stderr)


def parse_args(argv):
    d = DEFAULTS
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n", 2)[2])
    p.add_argument("input", nargs="?", default=d["input"], help="the tiff (default: the first .tif in the repo's root)")
    p.add_argument("-w", "--width", type=int, default=d["width"], help=f"characters across (default {d['width']})")
    p.add_argument("--aspect", type=float, default=d["aspect"], help=f"character height / width (default {d['aspect']})")
    p.add_argument("--charset", choices=CHARSETS, default=d["charset"], help=f"named characters, sparse to dense (default {d['charset']})")
    p.add_argument("--ramp", default=d["ramp"], help="your own characters, sparse to dense - beats --charset")
    p.add_argument("--invert", action="store_true", default=d["invert"], help="for light backgrounds")
    p.add_argument("--gamma", type=float, default=d["gamma"], help=f"<1 brightens midtones, >1 darkens (default {d['gamma']})")
    p.add_argument("--levels", default=d["levels"], help="LO,HI brightness 0-255 to spread over the ramp, or auto (default)")
    p.add_argument("--samples", type=int, default=d["samples"], help=f"samples per character each way (default {d['samples']})")
    p.add_argument("--water", default=d["water"], help='draw water as this character, e.g. " " or "~"')
    p.add_argument("--bbox", default=d["bbox"], help="crop to WEST,SOUTH,EAST,NORTH in degrees")
    p.add_argument("--color", choices=["none", "ansi", "html"], default=d["color"], help=f"(default {d['color']})")
    p.add_argument("-o", "--output", default=d["output"], help="write here instead of stdout")
    p.add_argument("--png", default=d["png"], help="write the website's basemap image here instead of ascii")
    p.add_argument("--png-width", type=int, default=d["png_width"], help=f"pixels across for --png (default {d['png_width']})")
    opts = p.parse_args(argv)

    if opts.input is None:
        found = sorted(Path(__file__).resolve().parent.parent.glob("*.tif*"))
        if not found:
            p.error("no .tif in the repo's root - pass one")
        opts.input = found[0]
    if isinstance(opts.bbox, str):
        try:
            opts.bbox = [float(v) for v in opts.bbox.split(",")]
            assert len(opts.bbox) == 4
        except (ValueError, AssertionError):
            p.error("--bbox is WEST,SOUTH,EAST,NORTH, e.g. -130,20,-60,55")
    if opts.ramp is not None and len(opts.ramp) < 2:
        p.error("--ramp needs at least two characters")
    if opts.water is not None and len(opts.water) != 1:
        p.error("--water is one character")
    return opts


def main(argv=None):
    opts = parse_args(argv)
    raster = open_raster(opts.input)
    if opts.png:
        export_png(raster, opts)
        return
    art = render(sample(raster, opts), opts)
    if opts.output:
        Path(opts.output).write_text(art, encoding="utf-8")
    else:
        sys.stdout.write(art)


if __name__ == "__main__":
    main()
