# X11 window geometry for the window-recording e2e tests (libX11 via ctypes).
# Usage:
#   xwindow.py wm                      prints 1 when a window manager runs, else 0
#   xwindow.py geometry <xid>          prints the window's screen rectangle as JSON
#   xwindow.py move <xid> <x> <y>      asks for the window to be moved (XMoveWindow)
#   xwindow.py watch <xid> [hz]        prints {"at","x","y","width","height","minimized"} JSON
#                                      lines: once at start, then on every change (polled at
#                                      `hz`, default 60), until stdin closes or the window is gone
# Rectangles are the window's own area (no frame), in root (screen) pixels: what Chromium
# and ffmpeg's x11grab -window_id capture for that window.
import ctypes
import json
import select
import sys
import time

x11 = ctypes.cdll.LoadLibrary('libX11.so.6')
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XInternAtom.restype = ctypes.c_ulong
x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]


class XWindowAttributes(ctypes.Structure):
    _fields_ = [
        ('x', ctypes.c_int), ('y', ctypes.c_int), ('width', ctypes.c_int), ('height', ctypes.c_int),
        ('border_width', ctypes.c_int), ('depth', ctypes.c_int), ('visual', ctypes.c_void_p),
        ('root', ctypes.c_ulong), ('class_', ctypes.c_int), ('bit_gravity', ctypes.c_int),
        ('win_gravity', ctypes.c_int), ('backing_store', ctypes.c_int), ('backing_planes', ctypes.c_ulong),
        ('backing_pixel', ctypes.c_ulong), ('save_under', ctypes.c_int), ('colormap', ctypes.c_ulong),
        ('map_installed', ctypes.c_int), ('map_state', ctypes.c_int), ('all_event_masks', ctypes.c_long),
        ('your_event_mask', ctypes.c_long), ('do_not_propagate_mask', ctypes.c_long),
        ('override_redirect', ctypes.c_int), ('screen', ctypes.c_void_p),
    ]


x11.XGetWindowAttributes.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(XWindowAttributes)]
x11.XTranslateCoordinates.argtypes = [
    ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
    ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong),
]
x11.XMoveWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int]
x11.XGetWindowProperty.argtypes = [
    ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long, ctypes.c_long, ctypes.c_int, ctypes.c_ulong,
    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_void_p),
]
x11.XFree.argtypes = [ctypes.c_void_p]
x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]

# A window that went away must end the watcher quietly, not abort the process.
ERROR_HANDLER = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
errors = []


def on_error(_display, _event):
    errors.append(1)
    return 0


handler = ERROR_HANDLER(on_error)
x11.XSetErrorHandler(handler)

display = x11.XOpenDisplay(None)
if not display:
    sys.exit('no X display')
root = x11.XDefaultRootWindow(display)


def geometry(xid):
    attrs = XWindowAttributes()
    errors.clear()
    if not x11.XGetWindowAttributes(display, xid, ctypes.byref(attrs)) or errors:
        return None
    x = ctypes.c_int()
    y = ctypes.c_int()
    child = ctypes.c_ulong()
    if not x11.XTranslateCoordinates(display, xid, root, 0, 0, ctypes.byref(x), ctypes.byref(y), ctypes.byref(child)) or errors:
        return None
    # IsViewable = 2: an unmapped (iconified) window is "minimised".
    return {'x': x.value, 'y': y.value, 'width': attrs.width, 'height': attrs.height, 'minimized': attrs.map_state != 2}


def wm_running():
    atom = x11.XInternAtom(display, b'_NET_SUPPORTING_WM_CHECK', 1)
    if not atom:
        return False
    actual = ctypes.c_ulong()
    fmt = ctypes.c_int()
    n = ctypes.c_ulong()
    after = ctypes.c_ulong()
    data = ctypes.c_void_p()
    ok = x11.XGetWindowProperty(display, root, atom, 0, 1, 0, 0, ctypes.byref(actual), ctypes.byref(fmt), ctypes.byref(n), ctypes.byref(after), ctypes.byref(data))
    if data.value:
        x11.XFree(data)
    return ok == 0 and n.value > 0


def watch(xid, hz):
    last = None
    while True:
        rect = geometry(xid)
        if rect is None:
            return
        if rect != last:
            last = rect
            sys.stdout.write(json.dumps(dict(at=time.time() * 1000, **rect)) + '\n')
            sys.stdout.flush()
        # Polled at `hz`; a closed stdin ends the watcher.
        ready, _, _ = select.select([sys.stdin], [], [], 1.0 / hz)
        if ready and not sys.stdin.buffer.read1(4096):
            return


cmd = sys.argv[1]
if cmd == 'wm':
    print(1 if wm_running() else 0)
elif cmd == 'geometry':
    print(json.dumps(geometry(int(sys.argv[2], 0))))
elif cmd == 'move':
    x11.XMoveWindow(display, int(sys.argv[2], 0), int(sys.argv[3]), int(sys.argv[4]))
    x11.XSync(display, 0)
elif cmd == 'watch':
    watch(int(sys.argv[2], 0), float(sys.argv[3]) if len(sys.argv) > 3 else 60.0)
