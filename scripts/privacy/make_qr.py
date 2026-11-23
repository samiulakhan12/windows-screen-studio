#!/usr/bin/env python3
"""Writes the QR codes of the privacy evaluation set as module matrices (scripts/privacy/eval-qr.json),
so make-eval-set.mjs can draw them as SVG without a QR dependency. Needs `segno` (BSD-3-Clause).

  python3 scripts/privacy/make_qr.py scripts/privacy/eval-qr.json
"""
import json
import sys

import segno

# class "secret": a QR that carries a secret (an authenticator seed, a Wi-Fi password, a login link);
# class "other": any other QR (a plain web link).
CODES = {
    "totp-priya": ("secret", "otpauth://totp/Acme%20Cloud:priya.raman%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Acme%20Cloud&digits=6"),
    "totp-jordan": ("secret", "otpauth://totp/Northwind:jordan.ellis%40northwind.test?secret=KRUGKIDROVUWG2ZAMJZG653OEBTG66BAJZ2XA4DFOI&issuer=Northwind"),
    "wifi-office": ("secret", "WIFI:T:WPA;S:Acme-Office-5G;P:Sunflower-2291;;"),
    "login-link": ("secret", "https://login.acme-cloud.io/qr?session=4f9c2a7e1b8d4c6fa03e5d7b9c1e2f40&sig=Zt8qLm2Np"),
    "app-download": ("other", "https://flown.example/download"),
    "menu-link": ("other", "https://example.com/menu/autumn"),
}

out = {}
for key, (cls, data) in CODES.items():
    qr = segno.make(data, error="m", micro=False)
    out[key] = {"class": cls, "data": data, "version": qr.version, "rows": ["".join("1" if v else "0" for v in row) for row in qr.matrix]}
json.dump(out, open(sys.argv[1], "w"), indent=1)
print({k: (v["version"], len(v["rows"])) for k, v in out.items()})
