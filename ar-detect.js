// ar-detect.js - tap assist for the AR view: snap a tap to the golf ball or the cup.
// Works on small RGBA crops. Expected sizes come from the ground projection, so a ball
// 4 m away is expected to be small and one at your feet large. Prefers "no snap" over a wrong one.
(function (root) {
    'use strict';
    const A = root.ARCore || (typeof require !== 'undefined' ? require('./ar-core.js') : null);
    const BALL_R = 0.02135, CUP_R = 0.054;

    // Expected image ellipse (track/K pixels) of a horizontal circle of radius r (m) on the ground
    // under pixel (px, py), for a camera H m above the ground. Ball: use r = BALL_R (a sphere looks round).
    function expectedEllipse(K, up, px, py, H, r) {
        const P = A.rayToPlane(K, up, px, py, -H);
        if (!P) return null;
        const B = A.groundBasis(up);
        let sx = 0, sy = 0, n = 0; const pts = [];
        for (let i = 0; i < 24; i++) {
            const t = i / 24 * Math.PI * 2;
            const Q = A.add(P, A.add(A.mul(B.right, r * Math.cos(t)), A.mul(B.fwd, r * Math.sin(t))));
            const q = A.projectCam(K, Q); if (!q) return null;
            pts.push(q); sx += q.x; sy += q.y; n++;
        }
        const mx = sx / n, my = sy / n;
        let cxx = 0, cyy = 0, cxy = 0;
        for (const q of pts) { const dx = q.x - mx, dy = q.y - my; cxx += dx * dx; cyy += dy * dy; cxy += dx * dy; }
        cxx /= n; cyy /= n; cxy /= n;
        const e = eig(cxx, cyy, cxy);
        const range = Math.hypot(P.x, P.y, P.z);
        return { x: mx, y: my, a: Math.sqrt(2 * e.l1), b: Math.sqrt(2 * e.l2), theta: e.theta, range, ballR: K.f * BALL_R / range };
    }
    function eig(cxx, cyy, cxy) {
        const tr = cxx + cyy, det = cxx * cyy - cxy * cxy, d = Math.sqrt(Math.max(0, tr * tr / 4 - det));
        return { l1: tr / 2 + d, l2: Math.max(1e-9, tr / 2 - d), theta: 0.5 * Math.atan2(2 * cxy, cxx - cyy) };
    }
    function median(arr) { const a = Float32Array.from(arr).sort(); return a.length ? a[a.length >> 1] : 0; }
    // Robust grass statistics over the crop (grass dominates any crop around a tap).
    function grassStats(d, w, h) {
        const n = w * h, step = Math.max(1, Math.floor(n / 4000));
        const R = [], G = [], Bc = [], L = [];
        for (let i = 0; i < n; i += step) { const j = i * 4; R.push(d[j]); G.push(d[j + 1]); Bc.push(d[j + 2]); L.push(0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]); }
        const mR = median(R), mG = median(G), mB = median(Bc), mL = median(L);
        const mad = (arr, m) => median(arr.map(v => Math.abs(v - m))) * 1.4826;
        return { r: mR, g: mG, b: mB, L: mL, sR: Math.max(3, mad(R, mR)), sG: Math.max(3, mad(G, mG)), sB: Math.max(3, mad(Bc, mB)), sL: Math.max(3, mad(L, mL)) };
    }
    // 4-connected components of mask, with moments.
    function components(mask, w, h, minN, maxN) {
        const lab = new Int32Array(w * h), out = []; let cur = 0; const stack = new Int32Array(w * h);
        for (let i = 0; i < w * h; i++) {
            if (!mask[i] || lab[i]) continue;
            cur++; let sp = 0; stack[sp++] = i; lab[i] = cur;
            let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, x0 = w, x1 = 0, y0 = h, y1 = 0, sv = 0;
            while (sp) {
                const q = stack[--sp], y = (q / w) | 0, x = q - y * w;
                n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sv += mask[q];
                if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
                if (x > 0 && mask[q - 1] && !lab[q - 1]) { lab[q - 1] = cur; stack[sp++] = q - 1; }
                if (x < w - 1 && mask[q + 1] && !lab[q + 1]) { lab[q + 1] = cur; stack[sp++] = q + 1; }
                if (y > 0 && mask[q - w] && !lab[q - w]) { lab[q - w] = cur; stack[sp++] = q - w; }
                if (y < h - 1 && mask[q + w] && !lab[q + w]) { lab[q + w] = cur; stack[sp++] = q + w; }
            }
            if (n < minN || n > maxN) continue;
            const mx = sx / n, my = sy / n, e = eig(sxx / n - mx * mx, syy / n - my * my, sxy / n - mx * my);
            out.push({ id: cur, n, x: mx + 0.5, y: my + 0.5, a: 2 * Math.sqrt(e.l1), b: 2 * Math.sqrt(e.l2), theta: e.theta, x0, x1, y0, y1, touches: x0 === 0 || y0 === 0 || x1 === w - 1 || y1 === h - 1 });
        }
        return { comps: out, lab };
    }
    // Fraction of mask pixels in an elliptical annulus (k0..k1 times the blob's axes).
    function ringFraction(mask, w, h, c, k0, k1) {
        let hit = 0, tot = 0;
        const ct = Math.cos(c.theta), st = Math.sin(c.theta), R = Math.ceil(Math.max(c.a, 1) * k1) + 1;
        for (let y = Math.max(0, Math.floor(c.y - R)); y <= Math.min(h - 1, Math.ceil(c.y + R)); y++)
            for (let x = Math.max(0, Math.floor(c.x - R)); x <= Math.min(w - 1, Math.ceil(c.x + R)); x++) {
                const dx = x + 0.5 - c.x, dy = y + 0.5 - c.y, u = (dx * ct + dy * st) / Math.max(1, c.a), v = (-dx * st + dy * ct) / Math.max(1, c.b);
                const rr = Math.sqrt(u * u + v * v);
                if (rr >= k0 && rr <= k1) { tot++; if (mask[y * w + x]) hit++; }
            }
        return tot ? hit / tot : 0;
    }
    function meanLumaRing(d, w, h, c, k0, k1) {
        let s = 0, tot = 0;
        const ct = Math.cos(c.theta), st = Math.sin(c.theta), R = Math.ceil(Math.max(c.a, 1) * k1) + 1;
        for (let y = Math.max(0, Math.floor(c.y - R)); y <= Math.min(h - 1, Math.ceil(c.y + R)); y++)
            for (let x = Math.max(0, Math.floor(c.x - R)); x <= Math.min(w - 1, Math.ceil(c.x + R)); x++) {
                const dx = x + 0.5 - c.x, dy = y + 0.5 - c.y, u = (dx * ct + dy * st) / Math.max(1, c.a), v = (-dx * st + dy * ct) / Math.max(1, c.b);
                const rr = Math.sqrt(u * u + v * v);
                if (rr >= k0 && rr <= k1) { const j = (y * w + x) * 4; s += 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]; tot++; }
            }
        return tot ? s / tot : NaN;
    }
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const logGauss = (ratio, sig) => Math.exp(-Math.pow(Math.log(Math.max(1e-6, ratio)), 2) / (2 * sig * sig));

    // img: {data, w, h}; tap {x,y} and expect(x, y) -> {ballR} in crop pixels; searchR in crop pixels.
    function findBall(img, tap, expect, searchR, opts) {
        opts = opts || {};
        const { data: d, w, h } = img, gs = grassStats(d, w, h);
        const mask = new Uint8Array(w * h);
        const lumaGate = Math.max(12, 1.8 * gs.sL);
        for (let i = 0, j = 0; i < w * h; i++, j += 4) {
            const L = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
            const zr = (d[j] - gs.r) / gs.sR, zg = (d[j + 1] - gs.g) / gs.sG, zb = (d[j + 2] - gs.b) / gs.sB;
            const z = Math.sqrt((zr * zr + zg * zg + zb * zb) / 3);
            // white or bright/saturated colours: clearly brighter than grass AND far from grass colour
            if (L > gs.L + lumaGate && z > 3.2) mask[i] = 1;
        }
        const e0 = expect(tap.x, tap.y);
        if (!e0) return { ok: false, reason: 'no ground under the tap' };
        const r0 = e0.ballR;
        const { comps } = components(mask, w, h, Math.max(4, Math.floor(Math.PI * (0.45 * r0) ** 2)), Math.ceil(Math.PI * (2.2 * r0) ** 2));
        let best = null;
        for (const c of comps) {
            const dist = Math.hypot(c.x - tap.x, c.y - tap.y);
            if (dist > searchR || c.touches) continue;
            const ex = expect(c.x, c.y); if (!ex) continue;
            const re = Math.sqrt(c.n / Math.PI);
            const size = logGauss(re / ex.ballR, 0.42);
            const aspect = c.b / Math.max(1e-6, c.a);
            const fill = c.n / (Math.PI * c.a * c.b / 1);
            const iso = ringFraction(mask, w, h, { x: c.x, y: c.y, a: re, b: re, theta: 0 }, 1.6, 2.6);
            const conf = size * clamp01((aspect - 0.45) / 0.3) * clamp01((fill - 0.6) / 0.25) * clamp01(1 - iso / 0.25) * (1 - 0.35 * (dist / searchR) ** 2);
            const cand = { x: c.x, y: c.y, r: re, conf, size, aspect, fill, iso, dist };
            if (!best || cand.conf > best.conf) best = cand;
        }
        const thr = opts.threshold || 0.4;
        if (best && best.conf >= thr) return Object.assign({ ok: true }, best);
        return { ok: false, best, reason: best ? 'nothing ball-like enough' : 'no bright round blob near the tap' };
    }

    // Cup: a dark ellipse of the expected size/shape for that spot, isolated (not a shadow), ideally with a bright liner edge.
    function findCup(img, tap, expect, searchR, opts) {
        opts = opts || {};
        const { data: d, w, h } = img, gs = grassStats(d, w, h);
        const mask = new Uint8Array(w * h);
        const dark = Math.max(30, 3.5 * gs.sL);
        for (let i = 0, j = 0; i < w * h; i++, j += 4) {
            const L = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
            if (L < gs.L - dark) mask[i] = 1;
        }
        const e0 = tap ? expect(tap.x, tap.y) : expect(w / 2, h / 2);
        if (!e0) return { ok: false, reason: 'no ground under the tap' };
        const minA = opts.minAreaPx || Math.max(5, Math.floor(0.3 * Math.PI * e0.a * e0.b * 0.25));
        const { comps } = components(mask, w, h, 5, Math.ceil(Math.PI * e0.a * e0.b * 6) + 50);
        let best = null; const all = [];
        for (const c of comps) {
            const dist = tap ? Math.hypot(c.x - tap.x, c.y - tap.y) : 0;
            if ((tap && dist > searchR) || c.touches) continue;
            const ex = expect(c.x, c.y); if (!ex || ex.a < 1.5) continue;
            const area = logGauss(c.n / (Math.PI * ex.a * ex.b), 0.5);
            const aspect = logGauss((c.b / Math.max(1e-6, c.a)) / (ex.b / ex.a), 0.35);
            let dth = Math.abs(c.theta - ex.theta) % Math.PI; if (dth > Math.PI / 2) dth = Math.PI - dth;
            const orient = (c.b / c.a > 0.8 || ex.b / ex.a > 0.8) ? 1 : clamp01(1 - (dth - 0.35) / 0.35);
            const fill = c.n / (Math.PI * c.a * c.b);
            const iso = ringFraction(mask, w, h, c, 1.35, 2.0);
            const rimL = meanLumaRing(d, w, h, c, 1.0, 1.35);
            const rim = isFinite(rimL) && rimL > gs.L + 1.5 * gs.sL ? 1 : 0;
            let conf = area * aspect * orient * clamp01((fill - 0.6) / 0.25) * clamp01(1 - iso / 0.2);
            conf = Math.min(1, conf * (rim ? 1.25 : 1)) * (tap ? (1 - 0.35 * (dist / searchR) ** 2) : 1);
            const cand = { x: c.x, y: c.y, a: c.a, b: c.b, theta: c.theta, conf, area, aspect, orient, fill, iso, rim, dist, n: c.n, exp: ex };
            all.push(cand);
            if (!best || cand.conf > best.conf) best = cand;
        }
        const thr = opts.threshold || 0.45;
        if (best && best.conf >= thr) return Object.assign({ ok: true, all }, best);
        return { ok: false, best, all, reason: best ? 'nothing cup-like enough' : 'no dark round spot near the tap' };
    }

    const api = { expectedEllipse, findBall, findCup, grassStats, BALL_R, CUP_R };
    root.ARDetect = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
