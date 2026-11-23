"""Stand-in detection rules for the privacy scorer: what the reader's text must let Find see.
They follow §0 decision 2's defaults (passwords and PINs, codes, keys and tokens with prefixes from
gitleaks' rules and strong labels, tokens in links and webhooks, emails, card numbers with Luhn,
IBANs with mod 97, phones, labelled IDs plus SSN and NI shapes, listed names) and leave addresses,
password dots and unlabelled random strings alone. They are not the product's rules
(src/shared/privacy/detect is); they exist so a reader can be scored on whether its text is good
enough for rules of this kind.

find(lines, names) -> covers. A line is {"bbox": [x0, y0, x1, y1], "variants": [{"text", "spans"}]}
where spans[i] is the [x0, x1) of character i in frame pixels. A cover is
{"kind", "rule", "box": [x0, y0, x1, y1], "line": index}.
"""
import re

# ---- one line at a time ------------------------------------------------------------------------
KEY_PREFIXES = [
    r"(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z2-7]{16}",
    r"(?:AK[I1l]A|AS[I1l]A)[A-Za-z0-9]{16}(?![A-Za-z0-9])",  # read with 0/1/8 or lower case; checked in line_matches
    r"gh[pousr]_[A-Za-z0-9]{30,}",
    r"github_pat_\w{40,}",
    r"glpat-[\w-]{16,}",
    r"x[o0]x[baprs]-[\w-]{10,}",
    r"sk-(?:proj|svcacct|admin)-[\w-]{20,}",
    r"sk-[A-Za-z0-9]{32,}",
    r"(?:sk|rk)_(?:live|test|prod)_[A-Za-z0-9]{10,}",
    r"whsec_[A-Za-z0-9]{16,}",
    r"A[Il1|]za[\w-]{30,}",
    r"SG\.[\w-]{16,}\.[\w-]{16,}",
    r"npm_[A-Za-z0-9]{30,}",
    r"shpat_[a-fA-F0-9]{28,}",
    r"hf_[A-Za-z]{30,}",
    r"pypi-A[gq]E[\w-]{30,}",
    r"\bSK[0-9a-fA-F]{32}\b",
    r"[A-Za-z0-9_~.]{3}\dQ~[A-Za-z0-9_~.\-]{28,36}",
    r"django-insecure-\S{20,}",
]
KEY_RE = re.compile("|".join(f"(?:{p})" for p in KEY_PREFIXES))
JWT_RE = re.compile(r"eyJ[\w-]{6,}\.[\w-]{6,}(?:\.[\w-]*)?|eyJ[\w-]{16,}")
PEM_RE = re.compile(r"-*\s*(?:BEGIN|END)[ A-Z0-9_-]*PRIVATE KEY(?:\s*-+)?")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}")
PLACEHOLDER = re.compile(r"(?i)^(?:your[_-]|<|x{4,}|\.\.\.|os\.|process\.env|\$\{|\$env|null|none|true|false|changeme)|\.\.\.$|x{6,}")
ASSIGN_RE = re.compile(
    r"(?i)[\"']?\b([A-Z0-9_]*?(?:API[_ ]?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|PIN|CREDENTIALS?|AUTHTOKEN)[A-Z0-9_]*)\b[\"']?\s*[:=]\s*[\"']?([^\s\"',;]{4,})"
)
BEARER_RE = re.compile(r"(?i)\bbearer\s+([\w\-.~+/]{12,}=*)")
PW_RE = re.compile(r"(?i)\b(?:password|passwd|passphrase|pwd|pin|passcode|security key|network key)\b(\s+for\b[^:\n]{0,30}?\s+is\s+|\s*(?:\bis\b|:|=)\s*|\s+)([^\s,;\"'<>]{4,})")
USERINFO_RE = re.compile(r"://[^/\s:@]+:([^@\s/]{3,})@")
LINK_RE = re.compile(r"(?i)[?&](?:token|access_token|refresh_token|id_token|session|sid|sig|signature|code|ticket|share_token|key|apikey|api_key|auth|secret|password|reset|magic|otp)=([^&\s\"'<>#]{6,})")
# A space inside a webhook path is a misread "_" (URLs hold no spaces): keep going over it.
HOOK_RE = re.compile(r"(?i)(?:hooks\.slack\.com/(?:services|workflows|triggers)/|discord(?:app)?\.com/api/webhooks/)([\w/+-]{20,}(?: [\w/+-]{6,})*)")
DSN_RE = re.compile(r"https?://([0-9a-f]{32})@")
CODE_AFTER_RE = re.compile(r"(?i)\b(?:code|otp|one[- ]time|verification|passcode|2fa|mfa|cvc|cvv)\b(?=[^0-9\n]{0,24}?[\s:=])[^0-9\n]{0,24}?(?<![\w-])(\d{3}[ -]\d{3}|\d{4,8}|\d{3})(?!\d)")
CODE_BEFORE_RE = re.compile(r"(?i)(?<![\d\w])(\d{3}[ -]?\d{3})(?!\d)(?=[^0-9\n]{0,30}\b(?:code|verification|sign in)\b)")
CARD_RE = re.compile(r"(?<![\w.])[0-9OoIlSB](?:[ -]?[0-9OoIlSB]){12,18}(?![\w.])")
IBAN_RE = re.compile(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}")
PHONE_RES = [
    re.compile(r"(?<![\w+])\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,5}){1,4}(?!\d)"),
    re.compile(r"(?<!\w)\(\d{3}\)\s?\d{3}-\d{4}(?!\d)"),
    re.compile(r"(?<![\w-])\d{3}-\d{3}-\d{4}(?!\d)"),
    re.compile(r"(?<![\w+])0\d{1,4}[ -]\d{2,4}[ -]?\d{3,4}(?![\w])"),
    re.compile(r"(?<![\w+])01[3-9]\d{2}-?\d{6}(?!\d)"),
]
SSN_RE = re.compile(r"(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])")
NI_RE = re.compile(r"\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b")
ID_LABEL = r"(?:customer (?:id|number|no\.?)|employee id|payroll id|passport (?:no\.?|number)|tax (?:file )?(?:id|number|no\.?)|ssn|social security(?: number)?|national insurance(?: number)?|ni number|nid|account (?:no\.?|number)|member (?:id|number)|licen[cs]e (?:no\.?|number))"
ID_RE = re.compile(r"(?i)\b" + ID_LABEL + r"\b\W{0,3}(?:on file\W{0,3})?([A-Z0-9][A-Z0-9\- ]{3,22}[A-Z0-9])")
TEST_PANS = {"4242424242424242", "4111111111111111", "5555555555554444", "4000056655665556", "378282246310005"}
IBAN_LEN = {"GB": 22, "DE": 22, "FR": 27, "NL": 18, "ES": 24, "IT": 27, "PL": 28, "BE": 16, "IE": 22, "CH": 21, "AT": 20, "SE": 24, "PT": 25}
DIGITISH = str.maketrans({"O": "0", "o": "0", "I": "1", "l": "1", "S": "5", "B": "8"})


def luhn(d):
    s = 0
    for i, ch in enumerate(reversed(d)):
        n = int(ch)
        if i % 2:
            n *= 2
            if n > 9:
                n -= 9
        s += n
    return s % 10 == 0


def mod97(s):
    moved = s[4:] + s[:4]
    num = "".join(str(ord(c) - 55) if c.isalpha() else c for c in moved)
    return int(num) % 97 == 1


def iban_ok(s):
    """mod 97, also after undoing the reader's 0/O and 1/I mix-ups (at most 4 places)."""
    if mod97(s):
        return True
    amb = [i for i, c in enumerate(s) if i >= 4 and c in "0O1I"][:4]
    swap = {"0": "O", "O": "0", "1": "I", "I": "1"}
    for mask in range(1, 1 << len(amb)):
        t = list(s)
        for j, i in enumerate(amb):
            if mask >> j & 1:
                t[i] = swap[t[i]]
        if mod97("".join(t)):
            return True
    return False


def line_matches(text):
    """(kind, rule, start, end) for one line's text."""
    out = []
    add = lambda kind, rule, m, g=0: out.append((kind, rule, m.start(g), m.end(g)))
    for m in EMAIL_RE.finditer(text):
        add("email", "email", m)
    for m in JWT_RE.finditer(text):
        add("jwt", "jwt", m)
    for m in KEY_RE.finditer(text):
        v = m.group(0)
        end = m.end()
        # A long token read with a space inside it ("...QL1 6i0c"): carry on over the space.
        while len(v) >= 30 and end + 1 < len(text) and text[end] == " " and re.match(r"[\w-]{3,}(?![^\s\"'])", text[end + 1 :]):
            end += 1 + re.match(r"[\w-]+", text[end + 1 :]).end()
        if re.search(r"[xX]{6,}|\.\.\.", v):
            continue  # a placeholder such as xoxb-XXXXXXXX
        if re.match(r"A[KS][I1l]A", v) and not re.fullmatch(r"[A-Z2-7]{16}", v[4:].upper().translate(str.maketrans("018", "OIB"))):
            continue
        out.append(("key", "prefix", m.start(), end))
    for m in PEM_RE.finditer(text):
        add("privateKey", "pem", m)
    # Labels read with 0 for O (SLACK_B0T_T0KEN): fold UPPER_SNAKE words; same length, so positions hold.
    folded = re.sub(r"\b[A-Z][A-Z0-9]*_[A-Z0-9_]*\b", lambda w: re.sub(r"(?<=[A-Z_])0|0(?=[A-Z_])", "O", w.group(0)), text)
    for m in ASSIGN_RE.finditer(folded):
        label, value = m.group(1), m.group(2)
        if label.lower() == "key" or PLACEHOLDER.search(value) or "(" in value:
            continue
        if re.search(r"(?i)(?:key|token)_?id$", label) and not re.search(r"(?i)access", label) and not KEY_RE.search(value):
            continue  # an identifier of a key, not the key
        kind = "password" if re.search(r"(?i)pass|pwd|pin", label) else "key"
        end = m.end(2)
        while len(value) >= 30 and end + 1 < len(text) and text[end] == " " and re.match(r"[\w-]{3,}(?![^\s\"'])", text[end + 1 :]):
            end += 1 + re.match(r"[\w-]+", text[end + 1 :]).end()
        out.append((kind, "assign", m.start(2), end))
    for m in BEARER_RE.finditer(text):
        if not PLACEHOLDER.search(m.group(1)):
            add("key", "bearer", m, 1)
    for m in PW_RE.finditer(text):
        sep, value = m.group(1), m.group(2)
        strong = bool(re.search(r"is|:|=", sep))
        if PLACEHOLDER.search(value) or re.fullmatch(r"[•·.*]+", value):
            continue
        if strong or re.search(r"[\d\W_]", value):
            add("password", "label", m, 2)
    for m in USERINFO_RE.finditer(text):
        add("password", "userinfo", m, 1)
    for m in LINK_RE.finditer(text):
        add("linkToken", "query", m, 1)
    for m in HOOK_RE.finditer(text):
        add("linkToken", "webhook", m, 1)
    for m in DSN_RE.finditer(text):
        add("key", "dsn", m, 1)
    for m in CODE_AFTER_RE.finditer(text):
        add("code", "code-label", m, 1)
    for m in CODE_BEFORE_RE.finditer(text):
        add("code", "code-label", m, 1)
    for m in CARD_RE.finditer(text):
        d = re.sub(r"[ -]", "", m.group(0)).translate(DIGITISH)
        if d.isdigit() and 13 <= len(d) <= 19 and luhn(d) and d not in TEST_PANS:
            add("card", "luhn", m)
    for m in IBAN_RE.finditer(text):
        raw = m.group(0)
        compact = raw.replace(" ", "")
        lens = [IBAN_LEN[compact[:2]]] if compact[:2] in IBAN_LEN else range(min(34, len(compact)), 14, -1)
        for n in lens:
            if len(compact) >= n and iban_ok(compact[:n]):
                # map n compact characters back onto the raw span
                seen, end = 0, 0
                for i, ch in enumerate(raw):
                    if ch != " ":
                        seen += 1
                    if seen == n:
                        end = i + 1
                        break
                out.append(("iban", "mod97", m.start(), m.start() + end))
                break
    for rx in PHONE_RES:
        for m in rx.finditer(text):
            digits = re.sub(r"\D", "", m.group(0))
            if 8 <= len(digits) <= 15 and not re.search(r"(\d)\1{5,}", digits):
                add("phone", "phone", m)
    for m in SSN_RE.finditer(text):
        add("id", "ssn", m)
    for m in NI_RE.finditer(text):
        add("id", "ni", m)
    for m in ID_RE.finditer(text):
        if re.search(r"\d", m.group(1)):
            add("id", "id-label", m, 1)
    return out


def lev(a, b, cap):
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
        prev = cur
    return prev[-1]


def name_matches(text, names):
    out = []
    low = text.lower()
    for name in names:
        n = name.lower()
        cap = 1 if len(n) <= 12 else 2
        for i in range(len(low)):
            if i and low[i - 1].isalnum():
                continue
            if low[i] != n[0] and low[i + 1 : i + 2] != n[1:2]:
                continue
            for d in (0, -1, 1, -2, 2):
                j = i + len(n) + d
                if j > len(low) or j <= i or (j < len(low) and low[j].isalnum()):
                    continue
                if lev(low[i:j], n, cap) <= cap:
                    out.append(("name", "listed", i, j))
                    break
    return out


# ---- across lines -------------------------------------------------------------------------------
LABELS = [
    ("password", re.compile(r"(?i)^(?:new |current |old |confirm |temporary |wi-?fi |router admin )?(?:password|passcode|passphrase|pin|network security key)$")),
    ("code", re.compile(r"(?i)^(?:cvc|cvv|security code|door code|recovery codes?|backup codes?|confirmation code.*|.*verification code|enter the \d-digit code|one-time code)$")),
    ("key", re.compile(r"(?i)^(?:.*secret(?: key| access key)?|.*token|access key id|setup key|or type this key|api key|.*signing secret|restricted key.*|client secret|private key)$")),
    ("id", re.compile(r"(?i)^(?:" + ID_LABEL + r"|tax file number|customer id)$")),
]
CODE_TOKEN = re.compile(r"(?:[a-z0-9×]{3,5}-[a-z0-9]{3,5}|\d{4,5} \d{4,5}|\d{3} \d{3}|\d{6,10})")
CODE_LINE = re.compile(r"^\s*(?:\d{3}[ -]?\d{3}|\d{4,8})\s*$")


def label_kind(text):
    t = re.sub(r"^\d+\.\s*", "", text.strip())  # "2. Save your backup codes"
    if re.search(r"(?i)\b(?:recovery|backup) codes?\b", t):
        return "code", "codes"
    t = re.sub(r"[:\s]+$", "", t)
    t = re.sub(r"\s+", " ", t)
    for kind, rx in LABELS:
        if rx.match(t):
            return kind, t.lower()
    return None, None


def plausible(kind, v):
    v = v.strip()
    if not 3 <= len(v) <= 90 or re.fullmatch(r"[•·.*\s]+", v) or label_kind(v)[0]:
        return False
    if kind == "key":
        grouped = re.fullmatch(r"[A-Z0-9]{4}(?: [A-Z0-9]{4})+", v)
        return len(v) >= 8 and (" " not in v or bool(grouped)) and bool(re.search(r"\d", v) or (re.search(r"[a-z]", v) and re.search(r"[A-Z]", v)))
    if kind == "password":
        return len(v) >= 4 and " " not in v
    if kind == "code":
        return bool(re.search(r"\d", v))
    if kind == "id":
        return len(re.sub(r"\D", "", v)) >= 3
    return True


def find(lines, names):
    covers = []

    def box(li, a, b, spans):
        x0, y0, x1, y1 = lines[li]["bbox"]
        if spans and b - 1 < len(spans):
            return [spans[a][0], y0, spans[b - 1][1], y1]
        return [x0, y0, x1, y1]

    for li, L in enumerate(lines):
        for var in L["variants"]:
            text, spans = var["text"], var["spans"]
            for kind, rule, a, b in line_matches(text) + name_matches(text, names):
                if b > a:
                    covers.append({"kind": kind, "rule": rule, "box": box(li, a, b, spans), "line": li})

    prim = [L["variants"][-1]["text"] for L in lines]
    h_of = lambda L: L["bbox"][3] - L["bbox"][1]
    # Label next to or above a value.
    for li, L in enumerate(lines):
        kind, label = label_kind(prim[li])
        if not kind:
            continue
        lx0, ly0, lx1, ly1 = L["bbox"]
        h = h_of(L)
        cands = []
        for vi, V in enumerate(lines):
            if vi == li:
                continue
            vx0, vy0, vx1, vy1 = V["bbox"]
            same_row = abs((vy0 + vy1) / 2 - (ly0 + ly1) / 2) < 1.0 * h and 0 <= vx0 - lx1 < 1400
            below = 0 <= vy0 - ly1 + 0.3 * h < 3.2 * h and (abs(vx0 - lx0) < 80 or (vx0 < lx1 and vx1 > lx0))
            if (same_row or below) and plausible(kind, prim[vi]):
                cands.append(("row" if same_row else "below", (vx0 - lx1) if same_row else (vy0 - ly1), vi))
        if "codes" in label:  # a block of codes under its heading
            for vi, V in enumerate(lines):
                vx0, vy0, vx1, vy1 = V["bbox"]
                if 0 <= vy0 - ly1 < 6 * h and -60 < vx0 - lx0 < 900:
                    var = lines[vi]["variants"][-1]
                    if len(re.sub(r"\s", "", CODE_TOKEN.sub("", var["text"]))) > 3:
                        continue  # a sentence, not a list of codes
                    for m in CODE_TOKEN.finditer(var["text"]):
                        covers.append({"kind": "code", "rule": "codes-block", "box": box(vi, m.start(), m.end(), var["spans"]), "line": vi})
            continue
        for where in ("row", "below"):
            near = sorted((d, vi) for w, d, vi in cands if w == where)[:1]
            for _, vi in near:
                covers.append({"kind": kind, "rule": "label-" + where, "box": list(lines[vi]["bbox"]), "line": vi})
    # A line that is only a code, under a line that talks about a code.
    for vi, V in enumerate(lines):
        if not CODE_LINE.match(prim[vi]):
            continue
        h = h_of(V)
        for li, L in enumerate(lines):
            if li != vi and 0 <= V["bbox"][1] - L["bbox"][3] < 3.5 * h and L["bbox"][0] < V["bbox"][2] and L["bbox"][2] > V["bbox"][0] and re.search(r"(?i)\bcode\b", prim[li]):
                covers.append({"kind": "code", "rule": "code-under", "box": list(V["bbox"]), "line": vi})
                break
    # Private key blocks: every line from BEGIN to END in the same column.
    order = sorted(range(len(lines)), key=lambda i: lines[i]["bbox"][1])
    for pos, li in enumerate(order):
        if not re.search(r"BEGIN[ A-Z0-9_-]*PRIVATE KEY", prim[li]):
            continue
        x0 = lines[li]["bbox"][0]
        block = [li]
        rest = order[pos + 1 : pos + 60]
        end = next((lj for lj in rest if re.search(r"END[ A-Z0-9_-]*PRIVATE KEY", prim[lj])), None)
        if end is not None:
            # Everything between BEGIN and END that overlaps their columns (a key inside a JSON
            # string starts its body lines left of BEGIN).
            left = min(x0, lines[end]["bbox"][0]) - 400
            for lj in rest:
                if lines[lj]["bbox"][1] > lines[end]["bbox"][1]:
                    break
                if lines[lj]["bbox"][2] > left:
                    block.append(lj)
        else:
            for lj in rest:
                if abs(lines[lj]["bbox"][0] - x0) <= 60 and re.fullmatch(r"[A-Za-z0-9+/=\\n\"]{40,}", prim[lj].strip()):
                    block.append(lj)
        # One cover over the whole block: the reader often leaves the dashes out of a line's box.
        bx = [lines[i]["bbox"] for i in block]
        union = [min(b[0] for b in bx), min(b[1] for b in bx), max(b[2] for b in bx), max(b[3] for b in bx)]
        covers.append({"kind": "privateKey", "rule": "pem-block", "box": union, "line": li})
    # A key or token that runs to the end of its line continues on the next one.
    queue = list(covers)
    while queue:
        c = queue.pop(0)
        if c["kind"] not in ("jwt", "key", "privateKey", "linkToken") or c.get("depth", 0) >= 8:
            continue
        L = lines[c["line"]]
        h = h_of(L)
        if c["box"][2] < L["bbox"][2] - 0.6 * h:
            continue
        for vi, V in enumerate(lines):
            # The next line, starting at the wrapped line's own left edge (not a gutter left of it).
            cw = (L["bbox"][2] - L["bbox"][0]) / max(1, len(prim[c["line"]]))  # an indented line wraps to the column's edge
            if 0 <= V["bbox"][1] - L["bbox"][3] + 0.3 * h < 0.9 * h and V["bbox"][0] <= c["box"][0] + 0.5 * h and V["bbox"][0] >= L["bbox"][0] - 3 * cw:
                # Only a wrapped line: the token's line reaches the right edge of the column the
                # next line starts (the widest line starting there, within 15 lines).
                col = [W["bbox"][2] for W in lines if abs(W["bbox"][0] - V["bbox"][0]) < 40 and abs(W["bbox"][1] - V["bbox"][1]) < 15 * h]
                if col and L["bbox"][2] < max(col + [L["bbox"][2]]) - 1.2 * h:
                    continue
                var = V["variants"][-1]
                # The token may hold a misread "_" as a space; a last piece may be a few characters
                # alone on its line.
                m = re.match(r"[\w\-.+/=]+(?: [\w\-.+/=]{3,})*", var["text"])
                tok = m.group(0) if m else ""
                looks_random = (re.search(r"[a-z]", tok) and re.search(r"[A-Z]", tok) and re.search(r"\d", tok)) or re.fullmatch(r"[0-9a-f]{16,}", tok)
                tail = bool(m) and len(tok) < 12 and tok.strip() == var["text"].strip().strip("\"'")
                if m and (len(tok) >= 6 and looks_random or tail) and not re.match(r"\d{4}-\d{2}-\d{2}", tok):
                    nc = {"kind": c["kind"], "rule": "continued", "box": box(vi, 0, m.end(), var["spans"]), "line": vi, "depth": c.get("depth", 0) + 1}
                    if not any(x["rule"] == "continued" and x["line"] == vi for x in covers):
                        covers.append(nc)
                        queue.append(nc)
    return covers


def may_hold_secret_narrow(text, conf):
    """Only lines whose first read already shows a hit, or a read the recogniser is unsure of."""
    return conf < 0.9 or bool(line_matches(text))


def may_hold_secret(text, conf):
    """Lines worth a careful second read with the larger recogniser."""
    if conf < 0.95:
        return True
    return bool(
        re.search(r"@|\d{3}|[=:]\s*\S{6,}|[A-Za-z0-9_\-+/.~]{16,}|(?i:pass|pwd|pin|code|secret|token|key|ssn|iban|card|bearer|id\b|number)", text)
    )
