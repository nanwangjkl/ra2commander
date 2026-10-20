"""Import a flat CNCMaps render with colored region annotations.

Offline dependency: Pillow. Game assets and PNGs remain local.
Projection reference: CNCMaps.Engine/Map/Map.cs, GetLocalSizePixels and
GetStartPositionPixels, and TS/RA2 dx=rx-ry+width-1, dy=rx+ry-width-1.
https://github.com/zzattack/ccmaps-net/blob/main/CNCMaps.Engine/Map/Map.cs
"""
import argparse
import base64
import hashlib
import json
import re
import struct
from collections import deque
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from lzo import unpack


def require(condition, message):
    if not condition:
        raise ValueError(message)


def section(data, name):
    match = re.search(rb'^\[' + name.encode() + rb'\]\s*\r?\n(.*?)(?=^\[|\Z)', data, re.M | re.S)
    require(match, f'Missing map section {name}')
    return dict(re.findall(rb'^([^=\r\n]+)=(.*?)\r?$', match[1], re.M))


def flood_regions(mask, annotations, scale):
    width, height = mask.size
    labels = bytearray(mask.tobytes())
    require(len(annotations) < 255, 'At most 254 labels supported by this importer')
    for rid, region in enumerate(annotations, 1):
        x, y = (round(v / scale) for v in region['labelPixel'])
        require(0 <= x < width and 0 <= y < height, f"Label outside image: {region['name']}")
        start = y * width + x
        require(labels[start] == 0, f"Label on line, or connected to another region: {region['name']}")
        queue = deque([start])
        labels[start] = rid
        area = 0
        while queue:
            p = queue.popleft()
            area += 1
            for n in neighbors(p, width, height):
                if labels[n] == 0:
                    labels[n] = rid
                    queue.append(n)
        require(area > 100, f"Region unexpectedly small: {region['name']}")
    # Fill thick strokes and tiny unlabeled islands from the closest labeled
    # interior (Manhattan distance). This puts shared boundaries at stroke centres.
    queue = deque()
    for p, rid in enumerate(labels):
        if rid not in (0, 255) and any(labels[n] in (0, 255) for n in neighbors(p, width, height)):
            queue.append(p)
    while queue:
        p = queue.popleft()
        for n in neighbors(p, width, height):
            if labels[n] in (0, 255):
                labels[n] = labels[p]
                queue.append(n)
    require(all(v not in (0, 255) for v in labels), 'Unassigned image area')
    return labels


def neighbors(p, width, height):
    x = p % width
    if x:
        yield p - 1
    if x + 1 < width:
        yield p + 1
    if p >= width:
        yield p - width
    if p + width < width * height:
        yield p + width


def area(ring):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:])) / 2


def contains(ring, point):
    x, y = point
    inside = False
    for (ax, ay), (bx, by) in zip(ring, ring[1:]):
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            inside = not inside
    return inside


def trace_regions(labels, width, height, count):
    edges = [{} for _ in range(count)]

    def edge(rid, start, end):
        edges[rid - 1].setdefault(start, []).append(end)

    for y in range(height):
        for x in range(width):
            p = y * width + x
            rid = labels[p]
            if y == 0 or labels[p - width] != rid:
                edge(rid, (x, y), (x + 1, y))
            if x == width - 1 or labels[p + 1] != rid:
                edge(rid, (x + 1, y), (x + 1, y + 1))
            if y == height - 1 or labels[p + width] != rid:
                edge(rid, (x + 1, y + 1), (x, y + 1))
            if x == 0 or labels[p - 1] != rid:
                edge(rid, (x, y + 1), (x, y))

    def direction(a, b):
        return 0 if b[0] > a[0] else 1 if b[1] > a[1] else 2 if b[0] < a[0] else 3

    results = []
    for graph in edges:
        rings = []
        while graph:
            start = next(iter(graph))
            current, heading, ring = start, 0, [start]
            while True:
                candidates = graph[current]
                order = [(heading + 1) % 4, heading, (heading - 1) % 4, (heading + 2) % 4]
                end = min(candidates, key=lambda point: order.index(direction(current, point)))
                candidates.remove(end)
                if not candidates:
                    del graph[current]
                heading = direction(current, end)
                ring.append(end)
                current = end
                if current == start:
                    break
            # Remove only exactly collinear vertices. Independent approximate
            # simplification would introduce gaps between neighbouring regions.
            points = ring[:-1]
            reduced = [b for a, b, c in zip(points[-1:] + points[:-1], points, points[1:] + points[:1])
                       if (b[0] - a[0]) * (c[1] - b[1]) != (b[1] - a[1]) * (c[0] - b[0])]
            require(len(reduced) >= 3, 'Degenerate contour')
            rings.append(reduced + reduced[:1])
        polygons = [{'outer': ring, 'holes': []} for ring in rings if area(ring) > 0]
        for hole in (ring for ring in rings if area(ring) < 0):
            owners = [p for p in polygons if contains(p['outer'], hole[0])]
            require(len(owners) == 1, 'Ambiguous contour hole')
            owners[0]['holes'].append(hole)
        require(polygons, 'Missing region contour')
        results.append(polygons)
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--map', required=True, type=Path)
    parser.add_argument('--image', required=True, type=Path)
    parser.add_argument('--annotations', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--diagnostics', type=Path)
    args = parser.parse_args()
    annotations = json.loads(args.annotations.read_text())
    original = args.map.read_bytes()
    sha = hashlib.sha256(original).hexdigest()
    require(sha == annotations['expectedMapSha256'], 'Map revision differs from annotation configuration')
    meta = section(original, 'Map')
    full = [int(v) for v in meta[b'Size'].split(b',')]
    local = [int(v) for v in meta[b'LocalSize'].split(b',')]
    raw = unpack(base64.b64decode(b''.join(section(original, 'IsoMapPack5').values())))
    require(len(raw) == (2 * full[2] - 1) * full[3] * 11 + 4 and raw[-4:] == bytes(4), 'Invalid IsoMapPack5')
    cells = [struct.unpack_from('<HHHhBBB', raw, offset) for offset in range(0, len(raw) - 4, 11)]
    # CNCMaps Local crop. Dimensions are additionally verified before using it.
    left, top = local[0] * 60, max(local[1] - 3, 0) * 30 + 15
    expected_size = (local[2] * 60, (local[1] - 3 + local[3] + 5) * 30 - top)
    source = Image.open(args.image).convert('RGB')
    require(source.size == expected_size, f'Expected an unscaled flat Local render of {expected_size}, got {source.size}')
    image_sha = hashlib.sha256(args.image.read_bytes()).hexdigest()
    require(image_sha == annotations['expectedImageSha256'], 'Image changed: recheck label seeds and projection before updating its hash')
    width, height = source.size
    scale = annotations['analysisScale']
    require(isinstance(scale, int) and scale > 0 and width % scale == height % scale == 0, 'Invalid analysis scale')
    ox, oy = full[2] * 30 - left, -full[2] * 15 - top
    # This render is 15 px below the renderer's conventional Local crop.
    # The correction was independently fitted to native CLAT tile textures in
    # all four image quadrants; dimensions alone cannot establish the origin.
    correction = annotations['cropOffsetCorrection']
    ox += correction[0]
    oy += correction[1]

    def project(rx, ry):
        return [30 * (rx - ry) + ox, 15 * (rx + ry) + oy]

    def unproject(point):
        px, py = point
        difference, total = (px - ox) / 30, (py - oy) / 15
        return [round((total + difference) / 2, 6), round((total - difference) / 2, 6)]

    small = source.resize((width // scale, height // scale), Image.Resampling.NEAREST)
    color = tuple(bytes.fromhex(annotations['boundaryColor'].lstrip('#')))
    red, green, blue = ImageChops.difference(small, Image.new('RGB', small.size, color)).split()
    tolerance = annotations['colorTolerance']
    mask = ImageChops.lighter(ImageChops.lighter(red, green), blue).point(lambda v: 255 if v <= tolerance else 0)
    mask = mask.filter(ImageFilter.MaxFilter(3))
    labels = flood_regions(mask, annotations['regions'], scale)
    polygons = trace_regions(labels, *small.size, len(annotations['regions']))
    regions = []
    for spec, parts in zip(annotations['regions'], polygons):
        regions.append({
            'id': spec['id'], 'name': spec['name'], 'aliases': spec['aliases'], 'level': spec['level'],
            'labelPosition': unproject(spec['labelPixel']),
            'polygons': [{key: [unproject([x * scale, y * scale]) for x, y in ring] if key == 'outer'
                          else [[unproject([x * scale, y * scale]) for x, y in hole] for hole in ring]
                          for key, ring in part.items()} for part in parts],
        })
    # Native-map check: height-jump edges should land on annotated cliffs.
    # This is a static terrain cross-check, not a real-game calibration claim.
    pixel_mask = mask.load()
    lookup = {(c[0], c[1]): c for c in cells}
    edge_count = matched_edges = 0
    candidates = []
    for cell in cells:
        rx, ry, _, _, _, z, _ = cell
        for dx, dy in ((1, 0), (0, 1)):
            other = lookup.get((rx + dx, ry + dy))
            if not other or abs(z - other[5]) < 2:
                continue
            point = [rx + dx / 2, ry + dy / 2]
            px, py = project(*point)
            x, y = round(px / scale), round(py / scale)
            if 0 <= x < small.width and 0 <= y < small.height:
                edge_count += 1
                if pixel_mask[x, y] == 255:
                    matched_edges += 1
                    candidates.append({'game': point, 'image': [px, py]})
    require(edge_count > 100 and matched_edges / edge_count > 0.8, 'Projected native cliffs do not sufficiently match annotated lines')
    control_points = []
    for cx, cy in ((width / 4, height / 4), (width * 3 / 4, height / 4),
                   (width / 4, height * 3 / 4), (width * 3 / 4, height * 3 / 4)):
        control_points.append(min(candidates, key=lambda p: (p['image'][0] - cx) ** 2 + (p['image'][1] - cy) ** 2))
    scheme = {
        'schemaVersion': 1,
        'map': {'id': annotations['mapId'], 'name': annotations['mapName'], 'sourceFile': args.map.name,
                'sha256': sha, 'fullSize': full, 'localSize': local, 'coordinateRange': [full[2] + full[3]] * 2},
        'scheme': {'id': annotations['schemeId'], 'version': annotations['schemeVersion'], 'title': annotations['title']},
        'source': {'image': args.image.name, 'sha256': image_sha,
                   'width': width, 'height': height, 'boundaryColor': annotations['boundaryColor'],
                   'labelColor': annotations['labelColor'], 'analysisScale': scale},
        'coordinateSystem': 'ra2-rxry',
        'projection': {'kind': 'isometric-flat', 'gameToPixel': [30, -30, ox, 15, 15, oy],
                       'validation': {'status': 'native-terrain-verified', 'nativeCliffEdges': edge_count,
                                      'edgesOnAnnotation': matched_edges, 'controlPoints': control_points,
                                      'textureAlignment': annotations['textureAlignment'],
                                      'realGameVerified': False}},
        'boundaryRule': 'stroke-centre-manhattan',
        'regions': regions,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(scheme, ensure_ascii=False, indent=2) + '\n')
    if args.diagnostics:
        args.diagnostics.mkdir(parents=True, exist_ok=True)
        overlay = small.copy()
        draw = ImageDraw.Draw(overlay)
        for parts in polygons:
            for part in parts:
                draw.line(part['outer'], fill=(0, 180, 0), width=1)
        overlay.save(args.diagnostics / 'region-contours.png')
        overlay = small.copy()
        draw = ImageDraw.Draw(overlay)
        for cell in cells:
            rx, ry, _, _, _, z, _ = cell
            px, py = project(rx, ry)
            for dx, dy, edge in ((1, 0, [(px, py + 15), (px + 30, py)]),
                                  (0, 1, [(px - 30, py), (px, py + 15)])):
                other = lookup.get((rx + dx, ry + dy))
                if other and abs(z - other[5]) >= 2:
                    draw.line([(x / scale, y / scale) for x, y in edge], fill=(0, 220, 0), width=1)
        overlay.save(args.diagnostics / 'native-cliffs.png')
    print(json.dumps({'file': str(args.out), 'regions': len(regions), 'vertices': sum(len(p['outer']) for r in regions for p in r['polygons']),
                      'cliffEdges': edge_count, 'cliffEdgesOnAnnotation': matched_edges}, ensure_ascii=False))


if __name__ == '__main__':
    main()
