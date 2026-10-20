"""Small LZO1X reader used only by the offline map importer.

Format references (not runtime dependencies):
https://raw.githubusercontent.com/OpenRA/OpenRA/bleed/OpenRA.Mods.Cnc/FileFormats/LZOCompression.cs
https://raw.githubusercontent.com/OpenRA/OpenRA/bleed/OpenRA.Mods.Cnc/UtilityCommands/ImportGen2MapCommand.cs
"""
import struct


def decode(src, expected):
    pos = 0
    out = bytearray()
    state, token = 'run', None

    def byte():
        nonlocal pos
        value = src[pos]
        pos += 1
        return value

    def word():
        return byte() | (byte() << 8)

    def literals(count):
        nonlocal pos
        if pos + count > len(src):
            raise ValueError('Truncated LZO literals')
        out.extend(src[pos:pos + count])
        pos += count

    def copy(start, count):
        if not 0 <= start < len(out) or len(out) + count > expected:
            raise ValueError('Invalid LZO match')
        for i in range(count):
            out.append(out[start + i])

    def extended(base):
        count = 0
        while src[pos] == 0:
            byte()
            count += 255
        return count + base + byte()

    if src[0] > 17:
        count = byte() - 17
        literals(count)
        if count < 4:
            state, token = 'match', byte()
        else:
            state = 'first'
    while True:
        if state == 'run':
            token = byte()
            if token >= 16:
                state = 'match'
            else:
                literals((token if token else extended(15)) + 3)
                state = 'first'
        elif state == 'first':
            token = byte()
            if token >= 16:
                state = 'match'
            else:
                copy(len(out) - 2049 - (token >> 2) - (byte() << 2), 3)
                state = 'done'
        elif state == 'match':
            if token >= 64:
                start = len(out) - 1 - ((token >> 2) & 7) - (byte() << 3)
                copy(start, (token >> 5) + 1)
            elif token >= 32:
                count = token & 31
                if not count:
                    count = extended(31)
                copy(len(out) - 1 - (word() >> 2), count + 2)
            elif token >= 16:
                high, count = (token & 8) << 11, token & 7
                if not count:
                    count = extended(7)
                distance = high + (word() >> 2)
                if not distance:
                    if pos != len(src) or len(out) != expected:
                        raise ValueError('LZO chunk size mismatch')
                    return bytes(out)
                copy(len(out) - distance - 16384, count + 2)
            else:
                copy(len(out) - 1 - (token >> 2) - (byte() << 2), 2)
            state = 'done'
        else:
            count = src[pos - 2] & 3
            if count:
                literals(count)
                token, state = byte(), 'match'
            else:
                state = 'run'


def unpack(src):
    pos, out = 0, bytearray()
    while pos < len(src):
        packed, size = struct.unpack_from('<HH', src, pos)
        pos += 4
        if packed == size == 0:
            break
        if not packed or not size or pos + packed > len(src):
            raise ValueError('Invalid LZO chunk header')
        out.extend(decode(src[pos:pos + packed], size))
        pos += packed
    if pos != len(src):
        raise ValueError('Trailing LZO data')
    return bytes(out)
