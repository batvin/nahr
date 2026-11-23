// نهر — موشن سبک: آشکار شدن، شمارش، تیلت سهبعدی و کپی دستورات
(() => {
  document.body.classList.add('reveal-ready');

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // نوار پیشروی صفحه
  const bar = document.getElementById('scroll-progress');
  const progress = () => {
    if (!bar) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = `${max > 0 ? (window.scrollY / max) * 100 : 0}%`;
  };
  window.addEventListener('scroll', progress, { passive: true });
  progress();

  // آشکار شدن بخشها هنگام پیمایش صفحه
  const revealables = [...document.querySelectorAll('.reveal')];
  const counter = (el) => {
    if (el.dataset.done) return;
    el.dataset.done = '1';
    const target = Number(el.dataset.count);
    const decimals = Number(el.dataset.decimals || 0);
    if (!Number.isFinite(target)) return;
    if (reduce) {
      el.textContent = target.toLocaleString('fa-IR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      return;
    }
    const start = performance.now();
    const duration = 1300;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = (target * eased).toLocaleString('fa-IR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('in');
        entry.target.querySelectorAll('[data-count]').forEach(counter);
        observer.unobserve(entry.target);
      }
    }, { threshold: 0.12 });
    revealables.forEach((el) => observer.observe(el));
  } else {
    revealables.forEach((el) => {
      el.classList.add('in');
      el.querySelectorAll('[data-count]').forEach(counter);
    });
  }

  // حلقهٔ امتیاز محک
  const score = document.querySelector('.score-ring [data-count]');
  const ring = document.querySelector('.score-ring');
  if (score && ring) ring.style.setProperty('--score', score.dataset.count);

  // تیلت سهبعدی کارتها و ترمینال
  if (!reduce && window.matchMedia('(pointer: fine)').matches) {
    document.querySelectorAll('[data-tilt]').forEach((el) => {
      el.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        el.style.transform = `perspective(900px) rotateX(${(-y * 7).toFixed(2)}deg) rotateY(${(x * 9).toFixed(2)}deg) translateZ(6px)`;
      });
      el.addEventListener('pointerleave', () => { el.style.transform = ''; });
    });
  }

  // کپی دستورات با fallback برای http
  document.querySelectorAll('[data-copy]').forEach((box) => {
    const btn = box.querySelector('button');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const text = box.dataset.copy;
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
        else {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.append(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        const old = btn.textContent;
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = old; }, 1800);
      } catch {
        btn.textContent = '!';
      }
    });
  });

  // نوشتهٔ متحرک داخل ترمینال نمونه
  const tip = document.querySelector('.term-tip');
  if (tip && !reduce) {
    const tips = [
      'آخرین نسخه را از گیت هاب میگیرم…',
      'پنل وب روی 127.0.0.1:18080',
      'ایجنتها در گوش 7700',
      'محک ۱۰ حالت را امتحان میکند',
      'کد nh1_ دو سرور را با یک دستور وصل میکند',
    ];
    let i = 0;
    let pos = 0;
    let deleting = false;
    const step = () => {
      const text = tips[i];
      pos += deleting ? -1 : 1;
      tip.textContent = text.slice(0, pos);
      if (!deleting && pos === text.length) { deleting = true; return setTimeout(step, 1700); }
      if (deleting && pos === 0) { deleting = false; i = (i + 1) % tips.length; return setTimeout(step, 320); }
      setTimeout(step, 55);
    };
    setTimeout(step, 800);
  }
})();
