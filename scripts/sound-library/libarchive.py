"""The archive reader of scripts/build-sound-library.mjs when 7-Zip's 7zz is not there: the system's
libarchive through Python's ctypes (standard library only). Run with `python3 -I`.

  libarchive.py version                          → {"version": ..., "library": <path of the .so>}
  libarchive.py list <archive>                   → [{"path": ..., "type": "file" | "dir" | "link" | "other"}]
  libarchive.py extract <archive> <member> <out> → writes exactly that member's bytes to <out>

Nothing is written but <out>, and only for a member that is a regular file with exactly that path;
the build script checks the listing (absolute paths, `..` parts, links) before it extracts.
"""
import ctypes
import ctypes.util
import json
import os
import sys

AE_IFMT = 0o170000
AE_IFREG = 0o100000
AE_IFDIR = 0o040000
AE_IFLNK = 0o120000


def load():
    name = ctypes.util.find_library('archive') or 'libarchive.so.13'
    lib = ctypes.CDLL(name)
    lib.archive_version_string.restype = ctypes.c_char_p
    lib.archive_read_new.restype = ctypes.c_void_p
    for f in ('archive_read_support_format_zip', 'archive_read_support_format_7zip', 'archive_read_support_filter_all', 'archive_read_free', 'archive_read_data_skip'):
        getattr(lib, f).argtypes = [ctypes.c_void_p]
    lib.archive_read_open_filename.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t]
    lib.archive_read_next_header.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    lib.archive_entry_pathname_utf8.restype = ctypes.c_char_p
    lib.archive_entry_pathname_utf8.argtypes = [ctypes.c_void_p]
    lib.archive_entry_filetype.restype = ctypes.c_uint
    lib.archive_entry_filetype.argtypes = [ctypes.c_void_p]
    lib.archive_entry_hardlink.restype = ctypes.c_char_p
    lib.archive_entry_hardlink.argtypes = [ctypes.c_void_p]
    lib.archive_entry_symlink.restype = ctypes.c_char_p
    lib.archive_entry_symlink.argtypes = [ctypes.c_void_p]
    lib.archive_read_data.restype = ctypes.c_ssize_t
    lib.archive_read_data.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
    lib.archive_error_string.restype = ctypes.c_char_p
    lib.archive_error_string.argtypes = [ctypes.c_void_p]
    return lib


def library_path(lib):
    with open('/proc/self/maps', encoding='utf-8') as maps:
        for line in maps:
            if 'libarchive' in line:
                return os.path.realpath(line.split()[-1])
    return ''


def entries(lib, archive):
    a = lib.archive_read_new()
    lib.archive_read_support_format_zip(a)
    lib.archive_read_support_format_7zip(a)
    lib.archive_read_support_filter_all(a)
    if lib.archive_read_open_filename(a, archive.encode(), 65536) != 0:
        raise SystemExit('cannot open ' + archive + ': ' + str(lib.archive_error_string(a)))
    entry = ctypes.c_void_p()
    try:
        while True:
            r = lib.archive_read_next_header(a, ctypes.byref(entry))
            if r == 1:
                return
            if r != 0:
                raise SystemExit('cannot read ' + archive + ': ' + str(lib.archive_error_string(a)))
            name = (lib.archive_entry_pathname_utf8(entry) or b'').decode('utf-8', 'replace')
            kind = lib.archive_entry_filetype(entry) & AE_IFMT
            link = lib.archive_entry_hardlink(entry) or lib.archive_entry_symlink(entry) or kind == AE_IFLNK
            t = 'link' if link else 'file' if kind == AE_IFREG else 'dir' if kind == AE_IFDIR else 'other'
            yield a, name, t
    finally:
        lib.archive_read_free(a)


def main(argv):
    lib = load()
    if argv[0] == 'version':
        print(json.dumps({'version': lib.archive_version_string().decode(), 'library': library_path(lib)}))
    elif argv[0] == 'list':
        out = []
        for a, name, t in entries(lib, argv[1]):
            out.append({'path': name, 'type': t})
            lib.archive_read_data_skip(a)
        print(json.dumps(out))
    elif argv[0] == 'extract':
        archive, member, out = argv[1], argv[2], argv[3]
        found = 0
        for a, name, t in entries(lib, archive):
            if name != member:
                lib.archive_read_data_skip(a)
                continue
            if t != 'file':
                raise SystemExit(member + ' is not a regular file')
            found += 1
            buf = ctypes.create_string_buffer(65536)
            with open(out, 'xb') as f:
                while True:
                    n = lib.archive_read_data(a, buf, 65536)
                    if n < 0:
                        raise SystemExit('cannot read ' + member + ': ' + str(lib.archive_error_string(a)))
                    if n == 0:
                        break
                    f.write(buf.raw[:n])
            break
        if found != 1:
            raise SystemExit('no member ' + member)
    else:
        raise SystemExit('unknown command')


if __name__ == '__main__':
    main(sys.argv[1:])
