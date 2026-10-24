# Whether the pointer is over a window (and not over another window covering it), for the
# window-recording e2e tests (libX11 via ctypes). This is what the capture helper reports as
# `cursorOver` on Windows (WindowFromPoint + GetAncestor): here the top-level window under the
# pointer (XQueryPointer's child of the root, i.e. the window manager's frame) is compared with
# the top-level window that holds the recorded one.
# Usage:
#   xpointer.py over <xid> [hz]   prints {"at","over"} JSON lines: once at start, then on every
#                                 change (polled at `hz`, default 60), until stdin closes or the
#                                 window is gone
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
x11.XQueryTree.argtypes = [
    ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_uint),
]
x11.XQueryPointer.argtypes = [
    ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
    ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_uint),
]
x11.XFree.argtypes = [ctypes.c_void_p]

# A window that went away must end the poller quietly, not abort the process.
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


def top_level(xid):
    """The child of the root that holds `xid` (its window manager frame), or None when it is gone."""
    w = xid
    for _ in range(64):
        r = ctypes.c_ulong()
        parent = ctypes.c_ulong()
        children = ctypes.c_void_p()
        n = ctypes.c_uint()
        errors.clear()
        if not x11.XQueryTree(display, w, ctypes.byref(r), ctypes.byref(parent), ctypes.byref(children), ctypes.byref(n)) or errors:
            return None
        if children.value:
            x11.XFree(children)
        if parent.value == root or parent.value == 0:
            return w
        w = parent.value
    return None


def pointer_child():
    r = ctypes.c_ulong()
    child = ctypes.c_ulong()
    i = ctypes.c_int()
    m = ctypes.c_uint()
    x11.XQueryPointer(display, root, ctypes.byref(r), ctypes.byref(child), ctypes.byref(i), ctypes.byref(i), ctypes.byref(i), ctypes.byref(i), ctypes.byref(m))
    return child.value


def over(xid, hz):
    last = None
    while True:
        top = top_level(xid)
        if top is None:
            return
        state = pointer_child() == top
        if state != last:
            last = state
            sys.stdout.write(json.dumps({'at': time.time() * 1000, 'over': state}) + '\n')
            sys.stdout.flush()
        ready, _, _ = select.select([sys.stdin], [], [], 1.0 / hz)
        if ready and not sys.stdin.buffer.read1(4096):
            return


if sys.argv[1] == 'over':
    over(int(sys.argv[2], 0), float(sys.argv[3]) if len(sys.argv) > 3 else 60.0)
