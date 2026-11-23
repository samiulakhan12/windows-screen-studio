# Print selected gitleaks rules (id, line, regex, entropy, keywords, secretGroup). Reads TOML as data.
import sys, tomllib
path, ids = sys.argv[1], sys.argv[2].split(',')
raw = open(path, 'rb').read(); cfg = tomllib.loads(raw.decode())
lines = raw.decode().splitlines()
lineof = {}
for i, l in enumerate(lines, 1):
    if l.startswith('id = '): lineof[l.split('"')[1]] = i
for r in cfg['rules']:
    if r['id'] in ids or ids == ['ALL']:
        print(f"## {r['id']}  (line {lineof.get(r['id'])})")
        print('regex:', r.get('regex'))
        for k in ('entropy', 'keywords', 'secretGroup', 'path'):
            if k in r: print(k + ':', r[k])
        if 'allowlists' in r: print('allowlists:', [{k: v for k, v in a.items()} for a in r['allowlists']])
