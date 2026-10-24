# Holds a global key grab on the X root window, as another application owning a hotkey would.
# Usage: xgrabkey.py ctrl+alt+k   (prints "grabbed", then holds it until killed)
import ctypes
import sys
import time

x11 = ctypes.cdll.LoadLibrary('libX11.so.6')
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XGrabKey.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_uint, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_int]

handle = x11.XOpenDisplay(None)
if not handle:
    sys.exit('no X display')
d = ctypes.c_void_p(handle)
MASKS = {'shift': 1, 'ctrl': 4, 'alt': 8, 'win': 64}
mods = 0
key = None
for part in sys.argv[1].split('+'):
    if part in MASKS:
        mods |= MASKS[part]
    else:
        key = part
code = x11.XKeysymToKeycode(d, x11.XStringToKeysym(key.encode()))
root = x11.XDefaultRootWindow(d)
# Also with Caps Lock (2) and Num Lock (16), as hotkey owners do.
for extra in (0, 2, 16, 18):
    x11.XGrabKey(d, code, mods | extra, root, 1, 1, 1)
x11.XSync(d, 0)
print('grabbed', flush=True)
while True:
    time.sleep(1)
