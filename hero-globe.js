/**
 * Nexora Pay — Minimalist 3D Earth Globe
 * High-performance, pure Canvas 2D spherical projection with transaction arcs and continents dot matrix.
 */
(function () {
  'use strict';

  // Detect Safari / WebKit engine (where transparent WebM decoding lacks hardware acceleration and causes 100% CPU lock)
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent) ||
                   (/iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream) ||
                   (typeof navigator.vendor === 'string' && navigator.vendor.indexOf('Apple') > -1);

  const video = document.getElementById('hero-earth-video');
  const canvas = document.getElementById('hero-globe-canvas');
  let canvasInitialized = false;

  // On Safari, bypass the heavy transparent WebM video to achieve silky-smooth 60 FPS scrolling
  if (isSafari && video) {
    try {
      video.pause();
      video.style.display = 'none';
      video.removeAttribute('src');
      video.load();
    } catch (_) {}
    if (canvas) {
      canvas.style.display = 'block';
    }
    initCanvasGlobe();
    return;
  }

  if (video) {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const hero = video.closest('.hero-globe-wrap');
    let inView = !('IntersectionObserver' in window);

    const syncPlayback = () => {
      if (reducedMotion.matches || document.hidden || !inView) {
        video.pause();
        return;
      }
      video.play().catch(() => {});
    };

    if ('IntersectionObserver' in window && hero) {
      const observer = new IntersectionObserver((entries) => {
        inView = entries.some((entry) => entry.isIntersecting);
        syncPlayback();
      }, { threshold: 0.01 });
      observer.observe(hero);
    }

    if (reducedMotion.addEventListener) {
      reducedMotion.addEventListener('change', syncPlayback);
    } else if (reducedMotion.addListener) {
      reducedMotion.addListener(syncPlayback);
    }
    document.addEventListener('visibilitychange', syncPlayback);
    syncPlayback();

    video.addEventListener('error', () => {
      video.style.display = 'none';
      if (canvas) {
        canvas.style.display = 'block';
        initCanvasGlobe();
      }
    });

    return;
  }

  // If no video tag, start canvas directly
  if (canvas) {
    canvas.style.display = 'block';
    initCanvasGlobe();
  }

  function initCanvasGlobe() {
    if (canvasInitialized) return;
    const canvas = document.getElementById('hero-globe-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvasInitialized = true;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Key global payment hubs (lat, lon in degrees)
  const HUBS = [
    { name: 'São Paulo', lat: -23.55, lon: -46.63, major: true },
    { name: 'Nova York', lat: 40.71, lon: -74.00, major: true },
    { name: 'Londres', lat: 51.50, lon: -0.12, major: true },
    { name: 'Tóquio', lat: 35.67, lon: 139.65, major: false },
    { name: 'Frankfurt', lat: 50.11, lon: 8.68, major: false },
    { name: 'Lisboa', lat: 38.72, lon: -9.13, major: false },
    { name: 'Miami', lat: 25.76, lon: -80.19, major: false },
    { name: 'Bogotá', lat: 4.71, lon: -74.07, major: false }
  ];

  // Arcs between hubs
  const ARCS = [
    { from: 0, to: 1, progress: 0.1, speed: 0.007 }, // SP -> NY
    { from: 0, to: 5, progress: 0.45, speed: 0.006 }, // SP -> Lisboa
    { from: 1, to: 2, progress: 0.7, speed: 0.008 }, // NY -> Londres
    { from: 2, to: 4, progress: 0.25, speed: 0.009 }  // Londres -> Frankfurt
  ];

  // Generate continent dot clusters on Earth's surface
  // Approximate land bounding boxes [minLat, maxLat, minLon, maxLon]
  const LAND_BOXES = [
    [-35, 10, -75, -35],   // South America
    [15, 65, -125, -60],   // North America
    [36, 62, -10, 40],     // Europe
    [-34, 35, -18, 50],    // Africa
    [10, 70, 60, 140],     // Asia
    [-38, -12, 115, 152]   // Australia
  ];

  function isLand(lat, lon) {
    for (let i = 0; i < LAND_BOXES.length; i++) {
      const b = LAND_BOXES[i];
      if (lat >= b[0] && lat <= b[1] && lon >= b[2] && lon <= b[3]) {
        return true;
      }
    }
    return false;
  }

  // Pre-generate sphere points (denser on land, sparse grid on oceans)
  const dots = [];
  const latStep = 6;
  const lonStep = 9;

  for (let lat = -80; lat <= 80; lat += latStep) {
    const rAtLat = Math.cos((lat * Math.PI) / 180);
    const count = Math.max(8, Math.floor(360 / lonStep * rAtLat));
    for (let i = 0; i < count; i++) {
      const lon = -180 + (i * 360) / count;
      const onLand = isLand(lat, lon);
      // Keep land dots with 90% probability, ocean dots with 15% probability (minimalist look)
      if (onLand || (i % 4 === 0 && Math.abs(lat) % 18 === 0)) {
        const phi = ((90 - lat) * Math.PI) / 180;
        const theta = ((lon + 180) * Math.PI) / 180;
        dots.push({
          x: Math.sin(phi) * Math.cos(theta),
          y: Math.cos(phi),
          z: Math.sin(phi) * Math.sin(theta),
          onLand,
          size: onLand ? 1.4 : 0.8
        });
      }
    }
  }

  let width = 0;
  let height = 0;
  let dpr = 1;
  let radius = 180;
  let rotY = 0.8;
  let rotX = 0.35; // Tilt ~20 deg
  let targetRotX = 0.35;
  let targetRotY = 0.8;
  let isVisible = true;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = rect.width || canvas.clientWidth || 480;
    height = rect.height || canvas.clientHeight || 480;
    if (width <= 0) width = 480;
    if (height <= 0) height = 480;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    radius = Math.min(width, height) * 0.44;
  }

  window.addEventListener('resize', resize, { passive: true });
  // Call resize immediately and after DOM content loaded to ensure true bounding rect
  resize();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', resize);
  }
  setTimeout(resize, 100);

  // Mouse & Touch interaction
  window.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.top <= window.innerHeight && rect.bottom >= 0) {
      const nx = (e.clientX - (rect.left + rect.width / 2)) / (window.innerWidth / 2);
      const ny = (e.clientY - (rect.top + rect.height / 2)) / (window.innerHeight / 2);
      targetRotX = 0.35 + ny * 0.2;
      targetRotY += nx * 0.003;
    }
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (e.touches && e.touches[0]) {
      const touch = e.touches[0];
      const rect = canvas.getBoundingClientRect();
      if (rect.top <= window.innerHeight && rect.bottom >= 0) {
        const nx = (touch.clientX - (rect.left + rect.width / 2)) / (window.innerWidth / 2);
        const ny = (touch.clientY - (rect.top + rect.height / 2)) / (window.innerHeight / 2);
        targetRotX = 0.35 + ny * 0.15;
        targetRotY += nx * 0.004;
      }
    }
  }, { passive: true });

  // Great circle arc calculation between two lat/lon hubs
  function hubToVector(hub) {
    const phi = ((90 - hub.lat) * Math.PI) / 180;
    const theta = ((hub.lon + 180) * Math.PI) / 180;
    return {
      x: Math.sin(phi) * Math.cos(theta),
      y: Math.cos(phi),
      z: Math.sin(phi) * Math.sin(theta)
    };
  }

  function rotateVector(v, rX, rY) {
    // Rotate Y
    const cosY = Math.cos(rY);
    const sinY = Math.sin(rY);
    const x1 = v.x * cosY + v.z * sinY;
    const y1 = v.y;
    const z1 = -v.x * sinY + v.z * cosY;

    // Rotate X
    const cosX = Math.cos(rX);
    const sinX = Math.sin(rX);
    const x2 = x1;
    const y2 = y1 * cosX - z1 * sinX;
    const z2 = y1 * sinX + z1 * cosX;

    return { x: x2, y: y2, z: z2 };
  }

  function render() {
    if (!isVisible) {
      requestAnimationFrame(render);
      return;
    }

    if (!reducedMotion) {
      rotY += 0.0028; // Smooth rotation
      rotX += (targetRotX - rotX) * 0.05;
    }

    ctx.clearRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;
    const isLight = document.documentElement.classList.contains('theme-light') || document.body.classList.contains('theme-light');

    // Rich atmospheric aura
    const gradient = ctx.createRadialGradient(cx, cy, radius * 0.35, cx, cy, radius * 1.25);
    if (isLight) {
      gradient.addColorStop(0, 'rgba(124, 58, 237, 0.14)');
      gradient.addColorStop(0.65, 'rgba(99, 102, 241, 0.04)');
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    } else {
      gradient.addColorStop(0, 'rgba(168, 85, 247, 0.18)');
      gradient.addColorStop(0.65, 'rgba(124, 58, 237, 0.05)');
      gradient.addColorStop(1, 'rgba(10, 10, 15, 0)');
    }
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.25, 0, Math.PI * 2);
    ctx.fill();

    // Render Globe outline halo
    ctx.strokeStyle = isLight ? 'rgba(124, 58, 237, 0.22)' : 'rgba(168, 85, 247, 0.28)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Render Dots
    for (let i = 0; i < dots.length; i++) {
      const d = dots[i];
      const p = rotateVector(d, rotX, rotY);

      // Back-face culling with soft gradient fade
      const depth = p.z; // -1 to 1
      if (depth < -0.15) {
        // Back of globe: very faint
        ctx.fillStyle = isLight ? 'rgba(148, 163, 184, 0.12)' : 'rgba(148, 163, 184, 0.15)';
        ctx.beginPath();
        ctx.arc(cx + p.x * radius, cy + p.y * radius, 0.7, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      const alpha = Math.min(1, Math.max(0.2, (depth + 0.3) * 0.85));
      if (d.onLand) {
        // High vibrancy on land
        ctx.fillStyle = isLight
          ? `rgba(124, 58, 237, ${alpha * 0.92})`
          : `rgba(192, 132, 252, ${alpha * 0.95})`;
        ctx.beginPath();
        ctx.arc(cx + p.x * radius, cy + p.y * radius, d.size * 1.1, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Subtle ocean dots
        ctx.fillStyle = isLight
          ? `rgba(100, 116, 139, ${alpha * 0.35})`
          : `rgba(148, 163, 184, ${alpha * 0.4})`;
        ctx.beginPath();
        ctx.arc(cx + p.x * radius, cy + p.y * radius, d.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Render Hubs and Transaction Arcs
    for (let a = 0; a < ARCS.length; a++) {
      const arc = ARCS[a];
      if (!reducedMotion) {
        arc.progress = (arc.progress + arc.speed) % 1;
      }

      const v1 = hubToVector(HUBS[arc.from]);
      const v2 = hubToVector(HUBS[arc.to]);

      const p1 = rotateVector(v1, rotX, rotY);
      const p2 = rotateVector(v2, rotX, rotY);

      if (p1.z > -0.2 || p2.z > -0.2) {
        ctx.beginPath();
        const steps = 20;
        let visiblePoints = 0;

        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const mx = v1.x * (1 - t) + v2.x * t;
          const my = v1.y * (1 - t) + v2.y * t;
          const mz = v1.z * (1 - t) + v2.z * t;
          const len = Math.sqrt(mx * mx + my * my + mz * mz);

          const altitude = 1 + Math.sin(t * Math.PI) * 0.14;
          const vx = (mx / len) * altitude;
          const vy = (my / len) * altitude;
          const vz = (mz / len) * altitude;

          const pt = rotateVector({ x: vx, y: vy, z: vz }, rotX, rotY);
          const px = cx + pt.x * radius;
          const py = cy + pt.y * radius;

          if (s === 0) {
            ctx.moveTo(px, py);
          } else {
            ctx.lineTo(px, py);
          }
          if (pt.z > 0) visiblePoints++;
        }

        if (visiblePoints > 3) {
          ctx.strokeStyle = isLight ? 'rgba(124, 58, 237, 0.45)' : 'rgba(216, 180, 254, 0.45)';
          ctx.lineWidth = 1.4;
          ctx.stroke();

          // Pulse particle traveling along arc
          const t = arc.progress;
          const mx = v1.x * (1 - t) + v2.x * t;
          const my = v1.y * (1 - t) + v2.y * t;
          const mz = v1.z * (1 - t) + v2.z * t;
          const len = Math.sqrt(mx * mx + my * my + mz * mz);
          const alt = 1 + Math.sin(t * Math.PI) * 0.14;
          const ptPulse = rotateVector({ x: (mx / len) * alt, y: (my / len) * alt, z: (mz / len) * alt }, rotX, rotY);

          if (ptPulse.z > -0.1) {
            ctx.fillStyle = '#ffffff';
            ctx.shadowColor = isLight ? '#7c3aed' : '#c084fc';
            ctx.shadowBlur = 8;
            ctx.beginPath();
            ctx.arc(cx + ptPulse.x * radius, cy + ptPulse.y * radius, 2.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
          }
        }
      }
    }

    // Render major hubs glowing marker
    for (let h = 0; h < HUBS.length; h++) {
      const v = hubToVector(HUBS[h]);
      const p = rotateVector(v, rotX, rotY);
      if (p.z > 0.05) {
        const px = cx + p.x * radius;
        const py = cy + p.y * radius;

        // Glowing center dot
        ctx.fillStyle = HUBS[h].major ? '#ffffff' : (isLight ? '#7c3aed' : '#c084fc');
        ctx.beginPath();
        ctx.arc(px, py, HUBS[h].major ? 2.8 : 2.0, 0, Math.PI * 2);
        ctx.fill();

        // Soft outer ring for major hubs
        if (HUBS[h].major) {
          ctx.strokeStyle = isLight ? 'rgba(124, 58, 237, 0.5)' : 'rgba(192, 132, 252, 0.6)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(px, py, 6, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    requestAnimationFrame(render);
  }

  // Intersection observer with generous rootMargin
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      isVisible = entries[0].isIntersecting;
    }, { rootMargin: '120px 0px' });
    observer.observe(canvas);
  }

  document.addEventListener('visibilitychange', () => {
    isVisible = !document.hidden;
  });

    render();
  }
})();
