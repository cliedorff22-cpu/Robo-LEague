# make_icons.py - draws the phone build's app icon (a red wedge robot with a
# spinning disc over a hazard stripe) and writes it as PNGs, with nothing but
# the Python standard library. Run from anywhere:  python3 mobile/icons/make_icons.py
import math, os, struct, zlib

HERE = os.path.dirname(os.path.abspath(__file__))

def png(path, w, h, rgba):
    raw = b"".join(b"\x00" + bytes(rgba[y * w * 4:(y + 1) * w * 4]) for y in range(h))
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))

def hexc(s): return tuple(int(s[i:i + 2], 16) for i in (1, 3, 5))

def inside_poly(x, y, pts):
    c = False
    for i in range(len(pts)):
        (x1, y1), (x2, y2) = pts[i], pts[i - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1: c = not c
    return c

BODY = [(0.16, 0.66), (0.84, 0.66), (0.84, 0.47), (0.60, 0.47), (0.16, 0.60)]
CAB = [(0.60, 0.47), (0.84, 0.47), (0.84, 0.42), (0.66, 0.42)]

def colour(x, y):
    """The icon at (x, y) in 0..1, as an RGB tuple."""
    # Disc: a toothed saw on the robot's back, spinning.
    dx, dy = x - 0.55, y - 0.36
    r, a = math.hypot(dx, dy), math.atan2(dy, dx)
    saw = 0.19 + 0.035 * ((a * 7 / (2 * math.pi)) % 1)
    if r < 0.045: return hexc("#2a2f39")
    if r < 0.07: return hexc("#8a93a3")
    if r < saw: return hexc("#d9dee6") if r < 0.15 else hexc("#b8c0cc")
    # Wheels.
    for wx in (0.30, 0.70):
        wr = math.hypot(x - wx, y - 0.66)
        if wr < 0.035: return hexc("#8a93a3")
        if wr < 0.085: return hexc("#15171c")
    if inside_poly(x, y, CAB): return hexc("#f0c419")
    if inside_poly(x, y, BODY):
        return hexc("#ff4a3d") if y < 0.52 + (0.60 - 0.52) * (0.6 - x) / 0.44 and x < 0.6 else hexc("#d8232a")
    # Hazard stripe under it.
    if 0.75 < y < 0.86:
        return hexc("#f0c419") if ((x + y) * 9) % 1 < 0.5 else hexc("#16181d")
    # Steel plate, a little lighter at the top.
    g = int(30 - 14 * y)
    return (g, g + 3, g + 9)

def draw(size, rounded):
    ss = 3
    px = bytearray(size * size * 4)
    rad = 0.18 if rounded else 0.0
    for j in range(size):
        for i in range(size):
            acc = [0, 0, 0]; cov = 0
            for sj in range(ss):
                for si in range(ss):
                    x = (i + (si + 0.5) / ss) / size; y = (j + (sj + 0.5) / ss) / size
                    if rounded:
                        cx = min(max(x, rad), 1 - rad); cy = min(max(y, rad), 1 - rad)
                        if math.hypot(x - cx, y - cy) > rad: continue
                    c = colour(x, y)
                    acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; cov += 1
            o = (j * size + i) * 4
            if cov:
                px[o:o + 4] = bytes([acc[0] // cov, acc[1] // cov, acc[2] // cov, 255 * cov // (ss * ss)])
    return px

for name, size, rounded in [("icon-512.png", 512, False), ("icon-192.png", 192, False), ("apple-touch-icon.png", 180, False), ("favicon-64.png", 64, True)]:
    png(os.path.join(HERE, name), size, size, draw(size, rounded))
    print("wrote", name)
