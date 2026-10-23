#!/usr/bin/env python3
"""Adds classes.dex to an aapt2-linked APK and writes it out with resources.arsc stored
uncompressed and 4-byte aligned (what Android requires from targetSdk 30), so zipalign is not needed."""
import struct, sys, zipfile

src, dex, dst = sys.argv[1:4]
PAD_ID = 0xD935  # the id zipalign uses for its padding extra field

with zipfile.ZipFile(src) as zin:
    entries = [(zi, zin.read(zi.filename)) for zi in zin.infolist()]
with open(dex, 'rb') as f:
    entries.append((zipfile.ZipInfo('classes.dex', date_time=(2026, 1, 1, 0, 0, 0)), f.read()))

with open(dst, 'wb') as fout:
    with zipfile.ZipFile(fout, 'w') as zout:
        for zi, data in entries:
            name = zi.filename
            info = zipfile.ZipInfo(name, date_time=zi.date_time)
            info.external_attr = zi.external_attr
            stored = name == 'resources.arsc' or name.endswith(('.png', '.jpg', '.webp'))
            info.compress_type = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
            if stored:
                header_len = 30 + len(name.encode('utf-8'))
                pad = (-(fout.tell() + header_len)) % 4
                if 0 < pad < 4:
                    pad += 4
                if pad:
                    info.extra = struct.pack('<HH', PAD_ID, pad - 4) + b'\0' * (pad - 4)
            zout.writestr(info, data)

# sanity check: every stored entry's data must start on a 4-byte boundary
with zipfile.ZipFile(dst) as z:
    for zi in z.infolist():
        if zi.compress_type == zipfile.ZIP_STORED:
            off = zi.header_offset + 30 + len(zi.filename.encode('utf-8')) + len(zi.extra)
            if off % 4:
                sys.exit(f'misaligned entry {zi.filename} at {off}')
print('wrote', dst)
