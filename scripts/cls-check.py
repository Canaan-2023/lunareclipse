import re
css = open('out/renderer/assets/index-C4JaFEGU.css', encoding='utf-8').read()

def quote(c):
    # 正则转义：产物 css 里 / -> \/ 、[ -> \[ 、] -> \] 、: -> \: 、. -> \.
    esc = c.replace('\\', '\\\\')
    esc = esc.replace('/', '\\\\/')
    esc = esc.replace('[', '\\[')
    esc = esc.replace(']', '\\]')
    esc = esc.replace(':', '\\:')
    esc = esc.replace('.', '\\.')
    return esc

def present(c):
    return re.search(r'\.' + quote(c) + r'(?=[,{])', css) is not None

tests = ['bg-accent/10', 'hover:bg-accent/10', 'bg-bg-base', 'disabled:opacity-40',
         'text-[12px]', 'tracking-[0.4em]', 'border-border-base', 'h-1.5', 'gap-0.5',
         'hover:bg-bg-hover', 'focus:outline-none', 'hover:shadow-lg', 'space-y-2',
         'from-accent/60', 'placeholder:text-fg-muted/25', '[scrollbar-width:none]']
for c in tests:
    print(c.ljust(30), present(c))