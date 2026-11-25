/* main.js – Reveal-Animationen, mobiles Menü, Jahreszahl */
document.addEventListener('DOMContentLoaded', () => {
  // ---------- Scroll-Reveal ----------
  const revealElements = document.querySelectorAll('.reveal');
  const staggered = [
    ['.timeline .reveal-item', 140],
    ['.interest-grid .reveal-interest', 120],
  ];

  if (!('IntersectionObserver' in window)) {
    revealElements.forEach((el) => el.classList.add('is-visible'));
    staggered.forEach(([sel]) => document.querySelectorAll(sel).forEach((el) => el.classList.add('is-visible')));
  } else {
    const opts = { threshold: 0.15, rootMargin: '0px 0px -10% 0px' };
    const observer = new IntersectionObserver((entries, obs) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          obs.unobserve(entry.target);
        }
      });
    }, opts);

    revealElements.forEach((el) => observer.observe(el));
    staggered.forEach(([sel, step]) => {
      document.querySelectorAll(sel).forEach((el, i) => {
        el.style.setProperty('--delay', `${(i % 3) * step}ms`); // Versatz pro Spalte
        observer.observe(el);
      });
    });
  }

  // ---------- Schaufenster: Abdunklung zurücknehmen, solange eines im Bild ist ----------
  const gaps = document.querySelectorAll('.scene-gap');
  if (gaps.length && 'IntersectionObserver' in window) {
    const visible = new Set();
    const gapObserver = new IntersectionObserver((entries) => {
      entries.forEach((e) => (e.isIntersecting ? visible.add(e.target) : visible.delete(e.target)));
      document.documentElement.classList.toggle('in-gap', visible.size > 0);
    }, { threshold: 0.6 });
    gaps.forEach((g) => gapObserver.observe(g));
  }

  // ---------- Mobiles Menü ----------
  const header = document.querySelector('.site-header');
  const toggle = document.querySelector('.nav-toggle');
  const mobileMenu = document.getElementById('mobile-menu');
  const de = (document.documentElement.lang || 'de').startsWith('de');
  const labelOpen = de ? 'Menü öffnen' : 'Open menu';
  const labelClose = de ? 'Menü schließen' : 'Close menu';

  if (header && toggle && mobileMenu) {
    toggle.addEventListener('click', () => {
      const isOpen = header.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(isOpen));
      toggle.setAttribute('aria-label', isOpen ? labelClose : labelOpen);
    });
    mobileMenu.querySelectorAll('a').forEach((a) => {
      a.addEventListener('click', () => {
        header.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', labelOpen);
      });
    });
  }

  // ---------- Jahr im Footer ----------
  const year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();
});
