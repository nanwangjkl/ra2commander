"""Fit the flat SNOW render origin using native CLAT texture samples.

Offline dependencies: Pillow and cryptography. No game assets are written.
TMP format reference:
https://github.com/OpenRA/OpenRA/blob/bleed/OpenRA.Mods.Cnc/SpriteLoaders/TmpTSLoader.cs
"""
import argparse
import base64
import configparser
import hashlib
import json
import struct
from pathlib import Path

from PIL import Image

from import_regions import require, section
from lzo import unpack
from mix import entries, filename_id


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('pack', 'map', 'image', 'out'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    files = {p.name.lower(): p for p in args.pack.iterdir() if p.is_file()}
    archive = entries(files['ra2.mix'].read_bytes())
    sno = entries(archive[filename_id('isosnow.mix')])
    cache = entries(archive[filename_id('cache.mix')])
    local = entries(archive[filename_id('local.mix')])
    raw_palette = cache[filename_id('isosno.pal')]
    palette = [tuple(v * 4 for v in raw_palette[i:i + 3]) for i in range(0, 768, 3)]
    ini = configparser.ConfigParser(strict=False)
    ini.read_string(local[filename_id('snow.ini')].decode('latin1'))
    filenames, grass_ids, tile_id = {}, set(), 0
    for name in ini.sections():
        if not name.lower().startswith('tileset'):
            continue
        spec = ini[name]
        count = int(spec.get('TilesInSet', '0'))
        for i in range(count):
            filenames[tile_id + i] = spec['FileName'] + f'{i + 1:02}.sno'
            if spec['FileName'].lower() == 'clat':
                grass_ids.add(tile_id + i)
        tile_id += count
    templates = {}

    def template(tile, subtile):
        key = (tile, subtile)
        if key in templates:
            return templates[key]
        data = sno[filename_id(filenames[tile])]
        nx, ny, width, height = struct.unpack_from('<IIII', data)
        require(width == 60 and height == 30 and subtile < nx * ny, 'Unexpected TMP dimensions')
        offset = struct.unpack_from('<I', data, 16 + subtile * 4)[0]
        points = []
        if offset:
            pos = offset + 52
            for y in range(30):
                run = 4 * (y + 1) if y < 15 else 4 * (29 - y)
                left = (60 - run) // 2
                for x in range(run):
                    index = data[pos]
                    pos += 1
                    if x % 5 == 0 and y % 3 == 0 and index:
                        r, g, b = palette[index]
                        points.append((left + x, y, int(g > b * 1.12 and g > r * .94)))
        templates[key] = points
        return points

    original = args.map.read_bytes()
    meta = section(original, 'Map')
    require(meta[b'Theater'] == b'SNOW', 'This verification tool supports SNOW only')
    full = [int(v) for v in meta[b'Size'].split(b',')]
    local_size = [int(v) for v in meta[b'LocalSize'].split(b',')]
    raw = unpack(base64.b64decode(b''.join(section(original, 'IsoMapPack5').values())))
    require(len(raw) == (full[2] * 2 - 1) * full[3] * 11 + 4, 'Invalid tile pack size')
    cells = [struct.unpack_from('<HHHhBBB', raw, i) for i in range(0, len(raw) - 4, 11)]
    ox = full[2] * 30 - local_size[0] * 60
    oy = -full[2] * 15 - max(local_size[1] - 3, 0) * 30 - 15
    points = []
    for rx, ry, tile, _, subtile, _, _ in cells:
        if tile not in grass_ids:
            continue
        samples = template(tile, subtile)
        if len({p[2] for p in samples}) < 2:
            continue
        bx, by = 30 * (rx - ry) + ox - 30, 15 * (rx + ry) + oy - 15
        points.extend((bx + x, by + y, green) for x, y, green in samples)
    classes = [[p for p in points if p[2] == value] for value in (0, 1)]
    require(all(len(cls) > 1000 for cls in classes), 'Insufficient native texture samples')
    all_points = [p for cls in classes for p in cls[::max(1, len(cls) // 1000)]]
    image = Image.open(args.image).convert('RGB')
    width, height = image.size
    rgb = image.tobytes()

    def score(points, dx, dy):
        matches = total = 0
        for x, y, green in points:
            x, y = x + dx, y + dy
            if not (0 <= x < width and 0 <= y < height):
                continue
            pos = (y * width + x) * 3
            r, g, b = rgb[pos:pos + 3]
            if abs(r - 210) + abs(g - 101) + abs(b - 113) < 60 or abs(r - 7) + abs(g - 55) + abs(b - 154) < 60:
                continue
            matches += green == int(g > b * 1.12 and g > r * .94)
            total += 1
        return matches / total if total else 0

    coarse = sorted([(score(all_points, x, y), x, y) for x in range(-30, 31, 3) for y in range(-30, 31, 3)], reverse=True)
    _, dx, dy = coarse[0]
    fine = sorted([(score(all_points, x, y), x, y) for x in range(dx - 3, dx + 4) for y in range(dy - 3, dy + 4)], reverse=True)
    best, dx, dy = fine[0]
    quadrants = []
    for quadrant in range(4):
        subset = [p for p in all_points if int(p[0] >= width / 2) + 2 * int(p[1] >= height / 2) == quadrant]
        require(len(subset) >= 100, 'Insufficient samples in one image quadrant')
        result = sorted([(score(subset, x, y), x, y) for x in range(dx - 3, dx + 4) for y in range(dy - 3, dy + 4)], reverse=True)
        require(result[0][1:] == (dx, dy), 'Image quadrants disagree on projection')
        quadrants.append({'quadrant': quadrant, 'samples': len(subset), 'best': result[:3]})
    require(best > .7, 'Texture match too weak; use explicit control points instead')
    report = {'samples': len(all_points), 'bestOffsetCorrection': [dx, dy], 'score': best, 'quadrants': quadrants}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'mapSha256': hashlib.sha256(original).hexdigest(),
                      'imageSha256': hashlib.sha256(args.image.read_bytes()).hexdigest(),
                      'gameToPixel': [30, -30, ox + dx, 15, 15, oy + dy], **report}))


if __name__ == '__main__':
    main()
