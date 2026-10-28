"""Export initial tree/rock cells for rally clearance (offline, standard library).

ra2web Terrain/Overlay objects have a 1x1 game foundation. Tree occupation
bits describe infantry subcells inside that cell, not adjacent map tiles.
OverlayPack uses chunked Format80/LCW, not IsoMapPack5's LZO format.
"""
import argparse
import base64
import configparser
import hashlib
import json
import struct
from pathlib import Path


def ini(path):
    data = path.read_bytes()
    value = configparser.ConfigParser(interpolation=None, strict=False)
    value.optionxform = str
    value.read_string(data.decode('utf-8-sig', errors='replace'))
    return data, value


def decode80(data, expected):
    out = bytearray()
    pos = 0

    def word():
        nonlocal pos
        value = struct.unpack_from('<H', data, pos)[0]
        pos += 2
        return value

    while pos < len(data):
        code = data[pos]
        pos += 1
        if code == 0x80:
            break
        if code < 0x80:
            count = 3 + (code >> 4)
            source = len(out) - (((code & 15) << 8) + data[pos])
            pos += 1
        elif code < 0xc0:
            count = code & 63
            out.extend(data[pos:pos + count])
            pos += count
            continue
        elif code == 0xfe:
            count = word()
            out.extend([data[pos]] * count)
            pos += 1
            continue
        else:
            count = word() if code == 0xff else 3 + (code & 63)
            source = word()
        if source < 0 or source >= len(out):
            raise ValueError('Invalid LCW back reference')
        for offset in range(count):
            out.append(out[source + offset])
    if len(out) != expected:
        raise ValueError('Invalid LCW decoded size')
    return out


def unpack80(data):
    pos, out = 0, bytearray()
    while pos < len(data):
        compressed, size = struct.unpack_from('<HH', data, pos)
        pos += 4
        if not compressed or not size:
            break
        if pos + compressed > len(data):
            raise ValueError('Truncated overlay chunk')
        out.extend(decode80(data[pos:pos + compressed], size))
        pos += compressed
    if len(out) != 512 * 512:
        raise ValueError('Invalid OverlayPack size')
    return out


def export(map_path, rules_path, art_path, map_id):
    original, native = ini(map_path)
    rules_data, rules = ini(rules_path)
    art_data, _ = ini(art_path)
    # Native maps can override object rules; merge them as the engine does.
    for name in native.sections():
        if not rules.has_section(name):
            rules.add_section(name)
        for key, value in native[name].items():
            rules[name][key] = value
    _, _, width, height = map(int, native['Map']['Size'].split(','))
    cells = set()
    terrain_count = 0
    for coordinate, name in native['Terrain'].items():
        x, y = int(coordinate) % 1000, int(coordinate) // 1000
        if not rules.has_section(name):
            raise ValueError('Missing terrain rules: ' + name)
        cells.add((x, y))
        terrain_count += 1
    packed = base64.b64decode(''.join(native['OverlayPack'].values()))
    overlay = unpack80(packed)
    # Engine readObjectTypes assigns sequential IDs to distinct values in file
    # order; INI numeric keys are not the overlay IDs (this file starts at 1).
    names = list(dict.fromkeys(value for key, value in rules['OverlayTypes'].items() if key.isdigit()))
    rock_count = 0
    for row in range(height):
        for column in range(2 * width - 1):
            dy = 2 * row + column % 2
            x = (column + dy) // 2 + 1
            y = dy - x + width + 1
            kind = overlay[x + 512 * y]
            if kind == 255:
                continue
            if kind >= len(names) or not rules.has_section(names[kind]):
                raise ValueError('Missing overlay rules: ' + str(kind))
            rule = rules[names[kind]]
            if rule.get('IsARock', '').lower() in ('yes', 'true', '1') or rule.get('Land', '').lower() == 'rock' or rule.get('Wall', '').lower() in ('yes', 'true', '1'):
                cells.add((x, y))
                rock_count += 1
    extent = width + height
    if any(not (0 <= x < extent and 0 <= y < extent) for x, y in cells):
        raise ValueError('Obstacle outside map extent')
    digest = lambda data: hashlib.sha256(data).hexdigest()
    return dict(schemaVersion=1, coordinateSystem='ra2-rxry',
                map=dict(id=map_id, sha256=digest(original)),
                generator='ra2web-static-obstacles-v1', width=extent, height=extent,
                sources=dict(rules=digest(rules_data), art=digest(art_data)),
                counts=dict(terrain=terrain_count, rockOrWallOverlay=rock_count),
                cells=[list(cell) for cell in sorted(cells, key=lambda p: (p[1], p[0]))])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['map', 'rules', 'art', 'out']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--map-id', required=True)
    args = parser.parse_args()
    value = export(args.map, args.rules, args.art, args.map_id)
    args.out.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(f"Exported {len(value['cells'])} obstacle cells: {value['counts']}")
