import re, os

src = 'src'
classes = set()
for root, dirs, files in os.walk(src):
    for f in files:
        if not f.endswith(('.tsx', '.ts', '.jsx', '.js', '.css')):
            continue
        p = os.path.join(root, f)
        try:
            txt = open(p, encoding='utf-8').read()
        except Exception:
            continue
        for m in re.finditer(r'className\s*=\s*[{"`]([^"`}]+)', txt):
            for tok in m.group(1).split():
                if re.fullmatch(r'[a-z0-9_\-\[\]/.:%#]+', tok):
                    classes.add(tok)
        for m in re.finditer(r'class\s*=\s*"([^"]+)"', txt):
            for tok in m.group(1).split():
                if re.fullmatch(r'[a-z0-9_\-\[\]/.:%#]+', tok):
                    classes.add(tok)

css = open('out/renderer/assets/index-C4JaFEGU.css', encoding='utf-8').read()

def present(c):
    # 字面匹配产物 CSS：选择器把 / [ ] : . 转义为 \/ \[ \] \: \.
    esc = c.replace('\\', '\\\\')
    esc = esc.replace('/', '\\/')
    esc = esc.replace('[', '\\[').replace(']', '\\]')
    esc = esc.replace(':', '\\:').replace('.', '\\.')
    return ('.' + esc) in css

skip_tokens = {'-', ':', 'active'}
missing = []
for c in sorted(classes):
    if c in skip_tokens or len(c) < 2:
        continue
    if not present(c):
        missing.append(c)

print('可解析类总数:', len(classes))
print('缺失数量:', len(missing))
for c in missing:
    print(' ', c)