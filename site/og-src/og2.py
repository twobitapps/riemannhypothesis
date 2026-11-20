# OG image: Riemann's explicit formula. Grey: Chebyshev psi(x). White: psi rebuilt from the first N zeros.
import json, math, cmath, sys
zeros = json.load(open(sys.argv[1]))
N = len(zeros)
W, H = 1200, 630
X0, X1, XA, XB = 60, 1140, 2.0, 100.0
YMID, YAMP = 372, 19.0   # pixels per unit of psi(x)-x            # pixel y for psi = 0 and psi = 52
def px(x): return X0 + (x - XA) / (XB - XA) * (X1 - X0)
def py(v): return YMID - v * YAMP
def lam(n):
    for p in range(2, n + 1):
        if n % p == 0:
            m = n
            while m % p == 0: m //= p
            return math.log(p) if m == 1 else 0.0
    return 0.0
def psi(x): return sum(lam(n) for n in range(2, int(x) + 1))
def psiN(x, k):
    s = x - math.log(2 * math.pi) - 0.5 * math.log(1 - x ** -2)
    lx = math.log(x)
    for g in zeros[:k]:
        rho = complex(0.5, g)
        s -= 2 * (cmath.exp(rho * lx) / rho).real
    return s
# sanity: psi_N(30) close to psi(30)
assert abs(psiN(30.0, N) - psi(30.0)) < 1.5, (psiN(30.0, N), psi(30.0))
# staircase path
st = []
n = 2
while n < XB:
    v = psi(n)
    st.append(f"M{px(n):.1f},{py(v - n):.1f} L{px(n + 1):.1f},{py(v - n - 1):.1f}")
    n += 1
def curve(k, steps=2400):
    pts = []
    for i in range(steps + 1):
        x = XA + 0.02 + (XB - XA - 0.02) * i / steps
        pts.append(f"{px(x):.1f},{py(psiN(x, k) - x):.1f}")
    return "M" + " L".join(pts)
o = []
A = o.append
A(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
A('<rect width="100%" height="100%" fill="#000"/>')
A(f'<path d="{"".join(st)}" stroke="#fff" stroke-opacity="0.45" stroke-width="1.2" fill="none"/>')
for k, op in [(3, 0.22), (10, 0.30), (30, 0.40), (100, 0.55)]:
    A(f'<path d="{curve(k)}" stroke="#fff" stroke-opacity="{op}" stroke-width="1" fill="none"/>')
A(f'<path d="{curve(N)}" stroke="#fff" stroke-width="1.6" fill="none"/>')
for p in [2,3,5,7,11,13,17,19,23,29,31,37,41,43,47,53,59,61,67,71,73,79,83,89,97]:
    A(f'<text x="{px(p):.1f}" y="{YMID+188}" font-family="Menlo,monospace" font-size="11" fill="#fff" fill-opacity="0.45" text-anchor="middle">{p}</text>')
A('<text x="60" y="112" font-family="Baskerville, Iowan Old Style, Georgia, serif" font-size="64" fill="#fff">The Riemann Hypothesis</text>')
A('<text x="62" y="160" font-family="Baskerville, Iowan Old Style, Georgia, serif" font-size="26" font-style="italic" fill="#fff" fill-opacity="0.75">An agentic swarm to check two proofs.</text>')
A(f'<text x="1140" y="608" font-family="Menlo,monospace" font-size="15" fill="#fff" fill-opacity="0.55" text-anchor="end">ψ(x) − x, rebuilt from 3, 10, 30, 100 and {N:,} zeros of ζ</text>')
A('<text x="60" y="608" font-family="Menlo,monospace" font-size="15" fill="#fff" fill-opacity="0.55">riemannhypothesis.vercel.app</text>')
A('</svg>')
open('og.svg', 'w').write("\n".join(o))
print("ok", psiN(30.0, N), psi(30.0))
