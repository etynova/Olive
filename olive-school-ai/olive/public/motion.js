(() => {
  'use strict';
  const view = document.getElementById('view');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;
  function split(el) {
    if (el.dataset.kinetic || el.children.length) return;
    const text = el.textContent.trim(); el.dataset.kinetic = '1'; el.textContent = '';
    const label = Object.assign(document.createElement('span'), { className: 'sr-only', textContent: text }); el.append(label);
    let i = 0;
    text.split(/(\s+)/).forEach((w) => {
      if (!w.trim()) return el.append(' ');
      const o = document.createElement('span'); o.className = 'kw'; o.setAttribute('aria-hidden', 'true');
      const n = document.createElement('span'); n.className = 'kw-i'; n.style.setProperty('--i', i++); n.textContent = w; o.append(n); el.append(o);
    });
  }
  let last = '';
  new MutationObserver(() => {
    const name = view.dataset.view; if (name === last && view.querySelector('[data-kinetic]')) return; last = name;
    view.classList.remove('enter'); void view.offsetWidth; view.classList.add('enter');
    view.querySelectorAll('.hero h1,.head h1').forEach(split);
  }).observe(view, { childList: true });
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  let cur = null;
  const reset = (el) => { if (el) el.style.transform = ''; };
  document.addEventListener('pointermove', (e) => {
    const c = e.target.closest?.('.card'); if (cur && cur !== c) { reset(cur); cur = null; } if (!c) return;
    const b = c.getBoundingClientRect(), x = (e.clientX - b.left) / b.width, y = (e.clientY - b.top) / b.height;
    c.style.setProperty('--mx', x * 100 + '%'); c.style.setProperty('--my', y * 100 + '%'); cur = c;
    c.style.transform = `perspective(800px) rotateX(${((.5 - y) * 10).toFixed(1)}deg) rotateY(${((x - .5) * 12).toFixed(1)}deg) translateY(-4px)`;
  }, { passive: true });
})();
