"""Export ra2web MapBounds as row runs, using native tile elevations.

Offline only: Python standard library and the existing LZO reader.
Verified against the local ra2web MapBounds.fromMapFile/computeLocalSize and
isWithinBounds implementation. This is an engine-bounds mask, not pathfinding.
"""
import argparse
import base64
import hashlib
import json
import re
import struct
from pathlib import Path

from lzo import unpack


def export(path, map_id):
    original = path.read_bytes()

    def section(name):
        match = re.search(rb'^\[' + name.encode() + rb'\]\s*\r?\n(.*?)(?=^\[|\Z)', original, re.M | re.S)
        if not match:
            raise ValueError('Missing section: ' + name)
        return dict(re.findall(rb'^([^=\r\n]+)=(.*?)\r?$', match[1], re.M))

    meta = section('Map')
    _, _, width, height = map(int, meta[b'Size'].split(b','))
    left, top, local_width, local_height = map(int, meta[b'LocalSize'].split(b','))
    data = unpack(base64.b64decode(b''.join(section('IsoMapPack5').values())))
    if len(data) != (width * 2 - 1) * height * 11 + 4:
        raise ValueError('Invalid native tile pack')
    tiles = [struct.unpack_from('<HHHhBBB', data, i) for i in range(0, len(data) - 4, 11)]
    # TileCollection.computeCutoffTileHeight inspects the last occupied display row.
    bottom = [(rx + ry - width - 1, z) for rx, ry, _, _, _, z, _ in tiles if 1 <= rx - ry + width - 1 < width * 2 - 4]
    last_row = max(y for y, _ in bottom)
    cutoff = max(9, max(z for y, z in bottom if y == last_row))
    left = max(2, left)
    local_width = min(width - 2 - left, local_width)
    bounds = dict(x=left * 2, y=top * 2, width=local_width * 2 - 2,
                  height=min(2 * (local_height + 5) - 1, 2 * height - 2 * (top - 3) - cutoff) - 8)
    rows = {}
    for rx, ry, _, _, _, z, _ in tiles:
        dx, dy = rx - ry + width - 1, rx + ry - width - 1 - z
        if bounds['x'] <= dx <= bounds['x'] + bounds['width'] and bounds['y'] <= dy <= bounds['y'] + bounds['height']:
            rows.setdefault(ry, []).append(rx)
    runs = []
    for y, xs in sorted(rows.items()):
        start = end = sorted(xs)[0]
        for x in sorted(xs)[1:]:
            if x != end + 1:
                runs.append([y, start, end])
                start = x
            end = x
        runs.append([y, start, end])
    return dict(schemaVersion=1, coordinateSystem='ra2-rxry', map=dict(id=map_id, sha256=hashlib.sha256(original).hexdigest()),
                generator='ra2web-map-bounds-v1', width=width + height, height=width + height, displayBounds=bounds, runs=runs)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--map', type=Path, required=True)
    parser.add_argument('--map-id', required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    value = export(args.map, args.map_id)
    args.out.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    print(f"Exported {len(value['runs'])} row runs")
