// KaTeX rendering for untrusted strings: no \href, \url, \htmlClass etc.
import katex from 'katex';
import { splitMath } from './board';

const cache = new Map();

export function texHTML(src, display = false) {
  const key = (display ? 'D' : 'I') + src;
  let html = cache.get(key);
  if (html == null) {
    try {
      html = katex.renderToString(String(src), { throwOnError: false, displayMode: display, trust: false, output: 'html', strict: 'ignore', maxSize: 20, maxExpand: 500 });
    } catch {
      html = '';
    }
    if (cache.size > 2000) cache.clear();
    cache.set(key, html);
  }
  return html;
}

export function Tex({ src, display = false, className }) {
  const html = texHTML(src, display);
  if (!html) return <code className={className}>{src}</code>;
  const Tag = display ? 'div' : 'span';
  return <Tag className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

// Plain text with $…$ / $$…$$ math, newlines kept by CSS (pre-line).
export function MathText({ text }) {
  return splitMath(String(text ?? '')).map((s, i) =>
    s.t === 'text' ? <span key={i}>{s.v}</span> : <Tex key={i} src={s.v} display={s.t === 'display'} className={s.t === 'display' ? 'bd-dmath' : 'bd-imath'} />,
  );
}
