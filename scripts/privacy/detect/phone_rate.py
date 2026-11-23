# Share of uniformly random digit strings that a country's metadata accepts as a national number.
# Reads metadata JSON as data only. Usage: python3 -I phone_rate.py <metadata.min.json> <metadata.max.json>
import json, re, sys, random
mn = json.load(open(sys.argv[1])); mx = json.load(open(sys.argv[2]))
random.seed(1)
def types_union(entry):
    t = entry[11] if len(entry) > 11 and isinstance(entry[11], list) else None
    if not t: return None
    pats = []
    for x in t:
        if isinstance(x, list) and x and x[0]: pats.append(x[0])
    return re.compile('(?:' + '|'.join(pats) + ')') if pats else None
N = 20000
print('country len generalPattern%  maxTypes%')
for cc in ['US', 'GB', 'BD', 'IN', 'DE', 'FR']:
    e_min = mn['countries'][cc]; e_max = mx['countries'][cc]
    gen = re.compile(e_min[2]); lens = set(e_min[3]); tu = types_union(e_max)
    for L in range(6, 13):
        g = t = 0
        for _ in range(N):
            s = ''.join(random.choice('0123456789') for _ in range(L))
            if L in lens and gen.fullmatch(s):
                g += 1
                if tu and tu.fullmatch(s): t += 1
        if g: print(cc, L, f'{100*g/N:.2f}', f'{100*t/N:.2f}' if tu else 'n/a')
