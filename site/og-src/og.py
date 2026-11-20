import random, math
random.seed(7)
W,H=1200,630
Y=372  # critical line y
X0,X1=70,1130
zeros=[14.134725,21.022040,25.010858,30.424876,32.935062,37.586178,40.918719,43.327073,48.005151,49.773832,52.970321,56.446248,59.347044,60.831779,65.112544,67.079811,69.546402,72.067158,75.704691,77.144840,79.337375,82.910381,84.735493,87.425275,88.809111,92.491899,94.651344,95.870634,98.831194,101.317851]
tx=lambda t: X0+(t-8)/(104-8)*(X1-X0)
chips=["m1·16g","m2·24g","m3·36g","m3max·48g","m4·32g","m4pro·48g","m4max·64g","m4max·128g","ultra·192g","ultra·64g","m2pro·32g","m1max·64g"]
glyph={"claude":"◆","codex":"◇","none":"·"}
out=[]
A=out.append
A(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
A('<rect width="100%" height="100%" fill="#000"/>')
A('<style>text{font-family:"SF Mono",Menlo,ui-monospace,monospace;fill:#fff}</style>')
# faint ascii grid of the critical strip
for gx in range(X0,X1+1,40):
    A(f'<text x="{gx}" y="{Y+4}" font-size="9" fill-opacity="0.18" text-anchor="middle">·</text>')
# nodes: field above (agents) and below (machines)
nodes=[]
for i in range(220):
    while True:
        x=random.uniform(40,1160); y=random.uniform(215,555)
        if abs(y-Y)>40 and not (y<230 and x<640) and not (abs(y-Y)<70 and x>1040): break
    nodes.append((x,y))
# threads
for (x,y) in nodes:
    z=min(zeros,key=lambda t:abs(tx(t)-x)+random.uniform(0,90))
    zx=tx(z)
    cx=(x+zx)/2+random.uniform(-40,40); cy=(y+Y)/2
    op=random.uniform(0.14,0.38)
    A(f'<path d="M{x:.1f},{y:.1f} Q{cx:.1f},{cy:.1f} {zx:.1f},{Y}" stroke="#fff" stroke-opacity="{op:.2f}" stroke-width="0.8" fill="none"/>')
placed=[]
for (x,y) in nodes:
    lane=random.choices(["claude","codex","none"],[5,4,2])[0]
    r=random.random()
    ok = r<0.12 and all(abs(x-a)>110 or abs(y-b)>22 for a,b in placed)
    if ok: placed.append((x,y))
    if ok:
        A(f'<text x="{x:.1f}" y="{y:.1f}" font-size="10" fill-opacity="0.75" text-anchor="middle">{glyph[lane]} {random.choice(chips)}</text>')
    else:
        A(f'<text x="{x:.1f}" y="{y+3:.1f}" font-size="11" fill-opacity="0.9" text-anchor="middle">{glyph[lane]}</text>')
# the critical line
A(f'<line x1="{X0-30}" y1="{Y}" x2="{X1+30}" y2="{Y}" stroke="#fff" stroke-width="2"/>')
for z in zeros:
    x=tx(z)
    A(f'<rect x="{x-4.5:.1f}" y="{Y-4.5}" width="9" height="9" fill="#000" stroke="#fff" stroke-width="1.6"/>')
    A(f'<rect x="{x-2:.1f}" y="{Y-2}" width="4" height="4" fill="#fff"/>')
for i,z in enumerate(zeros[:1]):
    x=tx(z); A(f'<text x="{x:.1f}" y="{Y+24}" font-size="10" fill-opacity="0.8" text-anchor="middle">{z:.6f}</text>')
A(f'<text x="{X1+30}" y="{Y-12}" font-size="13" text-anchor="end">Re(s) = ½</text>')
# header
A('<rect x="0" y="0" width="1200" height="34" fill="#fff"/>')
A('<text x="20" y="22" font-size="14" style="fill:#000">riemann-swarm — zsh</text>')
A('<text x="1180" y="22" font-size="14" text-anchor="end" style="fill:#000">● ● ●</text>')
A('<text x="40" y="104" font-size="44" font-weight="700">$ verify riemann_hypothesis</text>')
A('<rect x="757" y="70" width="24" height="44" fill="#fff"/>')
A('<text x="40" y="150" font-size="20" fill-opacity="0.85">every zero on one line. every Mac on one swarm.</text>')
A('<text x="40" y="186" font-size="16" fill-opacity="0.6">◆ claude  ◇ codex  ▣ checked by the Lean kernel</text>')
A('<text x="40" y="604" font-size="22" font-weight="700">ζ(½ + it) = 0</text>')
A('<text x="1160" y="604" font-size="18" text-anchor="end">riemannhypothesis.vercel.app</text>')
A('</svg>')
open('og.svg','w').write('\n'.join(out))
