"""Read MIX archive indexes for offline native-texture verification.

Format references: OpenRA MixFile.cs, BlowfishKeyProvider.cs, PackageEntry.cs.
https://github.com/OpenRA/OpenRA/tree/bleed/OpenRA.Mods.Cnc/FileSystem
Encrypted MIX indexes use an 80-byte RSA block and standard Blowfish ECB.
"""
import base64
import struct
import zlib

from cryptography.hazmat.decrepit.ciphers.algorithms import Blowfish
from cryptography.hazmat.primitives.ciphers import Cipher, modes


def filename_id(name):
    data = name.upper().encode('ascii')
    remainder = len(data) % 4
    if remainder:
        data += bytes([remainder]) + data[len(data) // 4 * 4:len(data) // 4 * 4 + 1] * (3 - remainder)
    return zlib.crc32(data)


def entries(data):
    extended = data[:2] == bytes(2)
    flags = struct.unpack_from('<I', data)[0] if extended else 0
    if flags & 0x20000:
        der = base64.b64decode('AihRvNoIbTn85FZRYNZRcT+i6KpU+maCsEqr3Q5q+LDB5tH7Tz2qQ38V')
        modulus = int.from_bytes(der[2:], 'big')
        size = (modulus.bit_length() - 2) // 8
        key = b''.join(pow(int.from_bytes(data[i:i + size + 1], 'little'), 65537, modulus)
                       .to_bytes(size + 1, 'little')[:size] for i in range(4, 84, size + 1))[:56]

        def decrypt(block):
            decoder = Cipher(Blowfish(key), modes.ECB()).decryptor()
            return decoder.update(block) + decoder.finalize()

        count, payload_size = struct.unpack_from('<HI', decrypt(data[84:92]))
        length = ((6 + 12 * count + 7) // 8) * 8
        header, offset = decrypt(data[84:84 + length]), 84 + length
    else:
        pos = 4 if extended else 0
        count, payload_size = struct.unpack_from('<HI', data, pos)
        header, offset = data[pos:pos + 6 + 12 * count], pos + 6 + 12 * count
    if offset + payload_size > len(data):
        raise ValueError('Truncated MIX payload')
    result = {}
    for i in range(count):
        fid, start, length = struct.unpack_from('<III', header, 6 + i * 12)
        if start + length > payload_size:
            raise ValueError('Invalid MIX entry')
        result[fid] = data[offset + start:offset + start + length]
    return result
