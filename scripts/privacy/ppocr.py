"""PP-OCRv6 reading with ONNX Runtime on one thread, as PaddleOCR 3.x does it, for the privacy
scorer (score_reader.py). Detection: DetResizeForTest (limit_type min, side 64, sizes to a
multiple of 32), ImageNet normalisation in BGR order, DBPostProcess with the thresholds of the
model's own inference.yml. Recognition: the rotate-crop of each quad, resize to height 48 keeping
the ratio (at least 320 wide), (x/255-0.5)/0.5, CTC greedy decode with the character list of
the model's inference.yml plus the blank and the trailing space. Each decoded character keeps the
x range of its CTC steps, so a match inside a line can be mapped back to pixels.

Only numpy, opencv-python-headless, pyclipper, shapely, pyyaml and onnxruntime are needed.
"""
import math
import time

import cv2
import numpy as np
import onnxruntime as ort
import pyclipper
import yaml
from shapely.geometry import Polygon


def session(path):
    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    so.inter_op_num_threads = 1
    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(path, sess_options=so, providers=["CPUExecutionProvider"])


class Detector:
    def __init__(self, model_dir, fit="pad"):
        cfg = yaml.safe_load(open(f"{model_dir}/inference.yml", encoding="utf-8"))
        pp = cfg["PostProcess"]
        self.thresh, self.box_thresh, self.unclip_ratio = pp["thresh"], pp["box_thresh"], pp["unclip_ratio"]
        self.max_candidates = pp.get("max_candidates", 1000)
        self.sess = session(f"{model_dir}/inference.onnx")
        self.fit = fit  # "pad": zero-pad to a multiple of 32 (a tile); "stretch": PaddleOCR's resize

    def preprocess(self, img):
        h, w = img.shape[:2]
        rh, rw = max(32, int(round(h / 32) * 32)), max(32, int(round(w / 32) * 32))
        mean = np.array([0.485, 0.456, 0.406], np.float32)
        std = np.array([0.229, 0.224, 0.225], np.float32)
        if self.fit == "stretch":
            im = cv2.resize(img, (rw, rh)).astype(np.float32)
            x = ((im / 255.0) - mean) / std
            scale = (rw / w, rh / h)
        else:
            rh, rw = int(math.ceil(h / 32) * 32), int(math.ceil(w / 32) * 32)
            x = np.zeros((rh, rw, 3), np.float32)
            x[:h, :w] = ((img.astype(np.float32) / 255.0) - mean) / std
            scale = (1.0, 1.0)
        return x.transpose(2, 0, 1)[None].astype(np.float32), scale

    def __call__(self, img):
        h, w = img.shape[:2]
        x, scale = self.preprocess(img)
        t0 = time.perf_counter()
        pred = self.sess.run(None, {"x": x})[0][0, 0]
        ms = (time.perf_counter() - t0) * 1e3
        if self.fit == "pad":
            pred = pred[:h, :w]
        else:
            pred = cv2.resize(pred, (w, h))  # back to the frame's own size (PaddleOCR scales the boxes instead)
        return self.boxes(pred), ms, pred

    def boxes(self, pred):
        h, w = pred.shape
        bitmap = (pred > self.thresh).astype(np.uint8) * 255
        contours, _ = cv2.findContours(bitmap, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        out = []
        for c in contours[: self.max_candidates]:
            pts, sside = mini_box(c)
            if sside < 3:
                continue
            if box_score(pred, pts) < self.box_thresh:
                continue
            exp = unclip(pts, self.unclip_ratio)
            if exp is None:
                continue
            pts, sside = mini_box(exp.reshape(-1, 1, 2))
            if sside < 5:
                continue
            pts[:, 0] = np.clip(np.round(pts[:, 0]), 0, w)
            pts[:, 1] = np.clip(np.round(pts[:, 1]), 0, h)
            if np.linalg.norm(pts[0] - pts[1]) <= 3 or np.linalg.norm(pts[0] - pts[3]) <= 3:
                continue
            out.append(pts.astype(np.float32))
        return sort_boxes(out)


def mini_box(contour):
    rect = cv2.minAreaRect(contour)
    pts = sorted(list(cv2.boxPoints(rect)), key=lambda p: p[0])
    i1, i4 = (0, 1) if pts[1][1] > pts[0][1] else (1, 0)
    i2, i3 = (2, 3) if pts[3][1] > pts[2][1] else (3, 2)
    return np.array([pts[i1], pts[i2], pts[i3], pts[i4]], np.float32), min(rect[1])


def box_score(pred, pts):
    h, w = pred.shape
    xmin, xmax = int(np.clip(np.floor(pts[:, 0].min()), 0, w - 1)), int(np.clip(np.ceil(pts[:, 0].max()), 0, w - 1))
    ymin, ymax = int(np.clip(np.floor(pts[:, 1].min()), 0, h - 1)), int(np.clip(np.ceil(pts[:, 1].max()), 0, h - 1))
    mask = np.zeros((ymax - ymin + 1, xmax - xmin + 1), np.uint8)
    p = pts.copy()
    p[:, 0] -= xmin
    p[:, 1] -= ymin
    cv2.fillPoly(mask, p.reshape(1, -1, 2).astype(np.int32), 1)
    return cv2.mean(pred[ymin : ymax + 1, xmin : xmax + 1], mask)[0]


def unclip(pts, ratio):
    poly = Polygon(pts)
    if poly.length == 0:
        return None
    d = poly.area * ratio / poly.length
    off = pyclipper.PyclipperOffset()
    off.AddPath([tuple(map(float, p)) for p in pts], pyclipper.JT_ROUND, pyclipper.ET_CLOSEDPOLYGON)
    res = off.Execute(d)
    if not res:
        return None
    return np.array(res[0], np.float32)


def sort_boxes(boxes):
    boxes = sorted(boxes, key=lambda b: (b[0][1], b[0][0]))
    for i in range(len(boxes) - 1):
        for j in range(i, -1, -1):
            if abs(boxes[j + 1][0][1] - boxes[j][0][1]) < 10 and boxes[j + 1][0][0] < boxes[j][0][0]:
                boxes[j], boxes[j + 1] = boxes[j + 1], boxes[j]
            else:
                break
    return boxes


def rotate_crop(img, pts):
    w = int(max(np.linalg.norm(pts[0] - pts[1]), np.linalg.norm(pts[2] - pts[3])))
    h = int(max(np.linalg.norm(pts[0] - pts[3]), np.linalg.norm(pts[1] - pts[2])))
    std = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    M = cv2.getPerspectiveTransform(pts.astype(np.float32), std)
    dst = cv2.warpPerspective(img, M, (w, h), borderMode=cv2.BORDER_REPLICATE, flags=cv2.INTER_CUBIC)
    rotated = dst.shape[0] / max(1, dst.shape[1]) >= 1.5
    if rotated:
        dst = np.rot90(dst)
    return dst, rotated


class Recogniser:
    def __init__(self, model_dir):
        cfg = yaml.safe_load(open(f"{model_dir}/inference.yml", encoding="utf-8"))
        self.chars = [""] + [str(c) for c in cfg["PostProcess"]["character_dict"]] + [" "]
        self.sess = session(f"{model_dir}/inference.onnx")

    def tensor(self, crop):
        h, w = crop.shape[:2]
        ratio = w / max(1, h)
        img_w = int(48 * max(320 / 48, ratio))
        rw = min(img_w, int(math.ceil(48 * ratio)))
        im = cv2.resize(crop, (rw, 48)).astype(np.float32)
        im = (im / 255.0 - 0.5) / 0.5
        x = np.zeros((48, img_w, 3), np.float32)
        x[:, :rw] = im
        return x.transpose(2, 0, 1)[None], rw, img_w

    def __call__(self, crop):
        x, rw, img_w = self.tensor(crop)
        t0 = time.perf_counter()
        probs = self.sess.run(None, {"x": x})[0][0]
        ms = (time.perf_counter() - t0) * 1e3
        return self.decode(probs, rw, img_w, crop.shape[1]), ms

    def decode(self, probs, rw, img_w, crop_w):
        steps = probs.shape[0]
        idx = probs.argmax(1)
        best = probs.max(1)
        px = img_w / steps  # resized pixels per CTC step
        k = crop_w / rw  # crop pixels per resized pixel
        text, spans, confs = [], [], []
        t = 0
        while t < steps:
            c = idx[t]
            run_end = t
            while run_end + 1 < steps and idx[run_end + 1] == c:
                run_end += 1
            if c != 0:
                text.append(self.chars[c] if c < len(self.chars) else "?")
                spans.append((t * px * k, (run_end + 1) * px * k))
                confs.append(float(best[t : run_end + 1].max()))
            t = run_end + 1
        # A character's span runs to the next character's start, so a match's box has no holes.
        widened = []
        for i, (a, b) in enumerate(spans):
            a2 = (a + spans[i - 1][1]) / 2 if i > 0 else max(0.0, a - px * k)
            b2 = (b + spans[i + 1][0]) / 2 if i + 1 < len(spans) else min(crop_w, b + px * k)
            widened.append((a2, b2))
        return {"text": "".join(text), "conf": float(np.mean(confs)) if confs else 0.0, "spans": widened, "charConf": confs}
