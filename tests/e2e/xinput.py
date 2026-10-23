# Real X11 input for e2e tests (libXtst), so global hooks see genuine OS events.
# Usage: xinput.py script "m X Y; c X Y; g X0 Y0 X1 Y1 SECS; k ctrl+shift+s; s SECS"
import ctypes
import sys
import time

x11 = ctypes.cdll.LoadLibrary('libX11.so.6')
xtst = ctypes.cdll.LoadLibrary('libXtst.so.6')
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
handle = x11.XOpenDisplay(None)
if not handle:
    sys.exit('no X display')
d = ctypes.c_void_p(handle)

NAMES = {'ctrl': 'Control_L', 'shift': 'Shift_L', 'alt': 'Alt_L', 'win': 'Super_L', 'enter': 'Return', 'esc': 'Escape'}


def move(x, y):
    xtst.XTestFakeMotionEvent(d, -1, int(float(x)), int(float(y)), 0)
    x11.XFlush(d)


def click(x, y):
    move(x, y)
    time.sleep(0.05)
    xtst.XTestFakeButtonEvent(d, 1, 1, 0)
    x11.XFlush(d)
    time.sleep(0.06)
    xtst.XTestFakeButtonEvent(d, 1, 0, 0)
    x11.XFlush(d)


def glide(x0, y0, x1, y1, secs):
    n = max(1, int(secs * 60))
    for i in range(n + 1):
        move(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n)
        time.sleep(secs / n)


def key(combo):
    codes = [x11.XKeysymToKeycode(d, x11.XStringToKeysym(NAMES.get(k, k).encode())) for k in combo.split('+')]
    for c in codes:
        xtst.XTestFakeKeyEvent(d, c, 1, 0)
        x11.XFlush(d)
        time.sleep(0.03)
    for c in reversed(codes):
        xtst.XTestFakeKeyEvent(d, c, 0, 0)
        x11.XFlush(d)
        time.sleep(0.03)


for part in sys.argv[2].split(';') if sys.argv[1] == 'script' else []:
    a = part.split()
    if not a:
        continue
    if a[0] == 'm':
        move(a[1], a[2])
    elif a[0] == 'c':
        click(a[1], a[2])
    elif a[0] == 'g':
        glide(*[float(v) for v in a[1:6]])
    elif a[0] == 'k':
        key(a[1])
    elif a[0] == 's':
        time.sleep(float(a[1]))
x11.XCloseDisplay(d)
