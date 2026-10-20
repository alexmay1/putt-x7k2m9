// ar-core.js - PuttGuide AR view math + tracking (no DOM). Loaded by ar-view.html and the node tests.
//
// Frames
//   device : W3C DeviceOrientation device frame (x right edge, y top edge, z out of the screen)
//   earth  : x east, y north, z up.  R = Rz(alpha) Rx(beta) Ry(gamma) maps device -> earth.
//   camera : rear camera, portrait, OpenCV style (X image right, Y image down, Z forward).
//            camera = (dx, -dy, -dz) of the device frame.
//   ground : horizontal plane under the camera, 2D (right, fwd) where fwd is the camera's
//            heading flattened onto the plane. Right-handed seen from above.
//   map    : the simulator's green coordinates (x right, z down the screen, meters) plus height.
//            Seen from above, (x, -z) is right-handed, so map -> ground is a rotation (+translation).
(function (root) {
    'use strict';
    const DEG = Math.PI / 180;
    const V = (x, y, z) => ({ x, y, z });
    const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
    const add = (a, b) => V(a.x + b.x, a.y + b.y, a.z + b.z);
    const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
    const mul = (a, s) => V(a.x * s, a.y * s, a.z * s);
    const cross = (a, b) => V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
    const len = (a) => Math.hypot(a.x, a.y, a.z);
    const unit = (a) => { const l = len(a) || 1; return V(a.x / l, a.y / l, a.z / l); };

    // ---------- orientation ----------
    function rotationFromEuler(alphaDeg, betaDeg, gammaDeg) {
        const a = (alphaDeg || 0) * DEG, b = (betaDeg || 0) * DEG, g = (gammaDeg || 0) * DEG;
        const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
        return [
            [ca * cg - sa * sb * sg, -sa * cb, ca * sg + sa * sb * cg],
            [sa * cg + ca * sb * sg, ca * cb, sa * sg - ca * sb * cg],
            [-cb * sg, sb, cb * cg]
        ];
    }
    const mulMV = (R, v) => V(R[0][0] * v.x + R[0][1] * v.y + R[0][2] * v.z, R[1][0] * v.x + R[1][1] * v.y + R[1][2] * v.z, R[2][0] * v.x + R[2][1] * v.y + R[2][2] * v.z);
    const mulMtV = (R, v) => V(R[0][0] * v.x + R[1][0] * v.y + R[2][0] * v.z, R[0][1] * v.x + R[1][1] * v.y + R[2][1] * v.z, R[0][2] * v.x + R[1][2] * v.y + R[2][2] * v.z);
    const camToDev = (c) => V(c.x, -c.y, -c.z);   // its own inverse
    // Earth "up" expressed in camera coordinates.
    function upInCamera(R) { return camToDev(V(R[2][0], R[2][1], R[2][2])); }
    // Camera pitch below the horizon (deg), for display.
    function pitchDownDeg(up) { return Math.asin(Math.max(-1, Math.min(1, -up.z))) / DEG; }

    // ---------- camera ----------
    // fovLongDeg = field of view across the long side of the video frame.
    function intrinsics(vw, vh, fovLongDeg) {
        const f = (Math.max(vw, vh) / 2) / Math.tan(fovLongDeg * DEG / 2);
        return { f, cx: vw / 2, cy: vh / 2, w: vw, h: vh };
    }
    const pixelRay = (K, px, py) => V((px - K.cx) / K.f, (py - K.cy) / K.f, 1);
    function projectCam(K, P) {
        if (P.z < 0.05) return null;
        return { x: K.cx + K.f * P.x / P.z, y: K.cy + K.f * P.y / P.z };
    }
    // Ground basis (camera coords) for a camera whose up vector is `up`.
    function groundBasis(up) {
        let fwd = sub(V(0, 0, 1), mul(up, up.z));
        if (len(fwd) < 0.05) fwd = sub(V(0, -1, 0), mul(up, -up.y)); // looking straight down: use image-up
        fwd = unit(fwd);
        const right = unit(cross(fwd, up));
        return { up, fwd, right };
    }
    // Ray from the camera through a pixel meets the horizontal plane `planeY` meters along up (negative = below).
    function rayToPlane(K, up, px, py, planeY) {
        const r = pixelRay(K, px, py);
        const d = dot(up, r);
        if (Math.abs(d) < 1e-6) return null;
        const t = planeY / d;
        if (t <= 0) return null;
        return mul(r, t);
    }
    const horiz = (B, P) => ({ x: dot(P, B.right), y: dot(P, B.fwd) });

    // Camera height above the ball (m) such that the horizontal ball->hole distance equals D.
    // dh = hole height - ball height (m). Returns null if the taps can't be on the ground.
    function solveCameraHeight(K, up, ballPx, holePx, D, dh) {
        dh = dh || 0;
        const B = groundBasis(up);
        const distAt = (H) => {
            const Pb = rayToPlane(K, up, ballPx.x, ballPx.y, -H);
            const Ph = rayToPlane(K, up, holePx.x, holePx.y, -H + dh);
            if (!Pb || !Ph) return NaN;
            const a = horiz(B, Pb), b = horiz(B, Ph);
            return Math.hypot(b.x - a.x, b.y - a.y);
        };
        let lo = Math.max(0.05, dh + 0.05), hi = 8;
        let flo = distAt(lo) - D, fhi = distAt(hi) - D;
        if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) {
            // Fall back to a flat-ground solution (distance is linear in H).
            const d1 = (() => {
                const Pb = rayToPlane(K, up, ballPx.x, ballPx.y, -1), Ph = rayToPlane(K, up, holePx.x, holePx.y, -1);
                if (!Pb || !Ph) return NaN;
                const a = horiz(B, Pb), b = horiz(B, Ph); return Math.hypot(b.x - a.x, b.y - a.y);
            })();
            return isFinite(d1) && d1 > 1e-4 ? D / d1 : null;
        }
        for (let i = 0; i < 40; i++) {
            const m = (lo + hi) / 2, fm = distAt(m) - D;
            if (!isFinite(fm)) { lo = m; continue; }
            if (fm * flo > 0) { lo = m; flo = fm; } else { hi = m; }
        }
        return (lo + hi) / 2;
    }
    // Horizontal ground distance between two tapped pixels for a known camera height (flat ground).
    function groundDistance(K, up, aPx, bPx, H) {
        const B = groundBasis(up);
        const Pa = rayToPlane(K, up, aPx.x, aPx.y, -H), Pb = rayToPlane(K, up, bPx.x, bPx.y, -H);
        if (!Pa || !Pb) return null;
        const a = horiz(B, Pa), b = horiz(B, Pb);
        return Math.hypot(b.x - a.x, b.y - a.y);
    }

    // Full camera pose for this frame from: up vector, the two tracked pixels, their map positions,
    // a height function on the map, and either the map distance (solve H) or a fixed H.
    // Returns { project(mapX, mapZ) -> pixel|null, H, B, ... }
    function poseFromTaps(K, up, ballPx, holePx, mapBall, mapHole, heightAt, fixedH) {
        const zb = heightAt(mapBall.x, mapBall.z), zh = heightAt(mapHole.x, mapHole.z);
        const dh = zh - zb;
        const D = Math.hypot(mapHole.x - mapBall.x, mapHole.z - mapBall.z);
        const H = fixedH || solveCameraHeight(K, up, ballPx, holePx, D, dh);
        if (!H || !isFinite(H)) return null;
        const B = groundBasis(up);
        const Pb = rayToPlane(K, up, ballPx.x, ballPx.y, -H);
        const Ph = rayToPlane(K, up, holePx.x, holePx.y, -H + dh);
        if (!Pb || !Ph) return null;
        const gb = horiz(B, Pb), gh = horiz(B, Ph);
        // map (x, -z) -> ground: complex a*q + b
        const qb = { x: mapBall.x, y: -mapBall.z }, qh = { x: mapHole.x, y: -mapHole.z };
        const dq = { x: qh.x - qb.x, y: qh.y - qb.y }, dg = { x: gh.x - gb.x, y: gh.y - gb.y };
        const den = dq.x * dq.x + dq.y * dq.y;
        if (den < 1e-8) return null;
        const ar = (dg.x * dq.x + dg.y * dq.y) / den, ai = (dg.y * dq.x - dg.x * dq.y) / den;
        const bx = gb.x - (ar * qb.x - ai * qb.y), by = gb.y - (ar * qb.y + ai * qb.x);
        function toCam(mx, mz, hOverride) {
            const qx = mx, qy = -mz;
            const gx = ar * qx - ai * qy + bx, gy = ar * qy + ai * qx + by;
            const zz = (hOverride !== undefined ? hOverride : heightAt(mx, mz)) - zb;
            return add(add(mul(B.right, gx), mul(B.fwd, gy)), mul(up, -H + zz));
        }
        return {
            H, B, dh, D, scale: Math.hypot(ar, ai), rotDeg: Math.atan2(ai, ar) / DEG,
            toCam,
            project: (mx, mz, hOverride) => projectCam(K, toCam(mx, mz, hOverride))
        };
    }

    // Where a pixel moves to after a pure camera rotation R0 -> R1 (gyro prediction for the tracker).
    function predictPixel(K, px, py, R0, R1) {
        const dev0 = camToDev(pixelRay(K, px, py));
        const w = mulMV(R0, dev0);
        const c1 = camToDev(mulMtV(R1, w));
        return projectCam(K, c1);
    }

    // ---------- grayscale + NCC template tracker ----------
    function rgbaToGray(data, n, out) {
        const g = out && out.length === n ? out : new Float32Array(n);
        for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114;
        return g;
    }
    function patch(gray, w, h, cx, cy, size) {
        const half = size >> 1, x0 = Math.round(cx) - half, y0 = Math.round(cy) - half;
        const out = new Float32Array(size * size);
        let s = 0, s2 = 0;
        for (let y = 0; y < size; y++) {
            const yy = Math.min(h - 1, Math.max(0, y0 + y));
            for (let x = 0; x < size; x++) {
                const xx = Math.min(w - 1, Math.max(0, x0 + x));
                const v = gray[yy * w + xx]; out[y * size + x] = v; s += v; s2 += v * v;
            }
        }
        const n = size * size, mean = s / n, std = Math.sqrt(Math.max(1e-6, s2 / n - mean * mean));
        return { data: out, mean, std };
    }
    function makeTemplate(p) {
        const z = new Float32Array(p.data.length);
        for (let i = 0; i < z.length; i++) z[i] = p.data[i] - p.mean;
        return z;
    }
    function createTracker(gray, w, h, x, y, opts) {
        opts = opts || {};
        const size = opts.size || 31;
        const p = patch(gray, w, h, x, y, size);
        return {
            size, x, y, tpl: makeTemplate(p), std: Math.max(1e-3, p.std), base: makeTemplate(p), baseStd: Math.max(1e-3, p.std),
            score: 1, ok: true, lowTexture: p.std < 3, lostFrames: 0, search: opts.search || 36
        };
    }
    function nccAt(gray, w, tpl, size, std, x0, y0) {
        const n = size * size;
        let s = 0, s2 = 0, d = 0;
        for (let ty = 0; ty < size; ty++) {
            const row = (y0 + ty) * w + x0, tr = ty * size;
            for (let tx = 0; tx < size; tx++) { const v = gray[row + tx]; s += v; s2 += v * v; d += tpl[tr + tx] * v; }
        }
        const mean = s / n, var_ = Math.max(1e-6, s2 / n - mean * mean);
        return d / (n * std * Math.sqrt(var_));
    }
    // Search around (px, py) (the gyro-predicted spot). Coarse step 2, then step 1, then sub-pixel.
    function trackStep(tr, gray, w, h, px, py, minScore) {
        minScore = minScore || 0.5;
        const half = tr.size >> 1, S = tr.search;
        const cx = Math.round(px), cy = Math.round(py);
        const xMin = Math.max(half, cx - S), xMax = Math.min(w - half - 1, cx + S);
        const yMin = Math.max(half, cy - S), yMax = Math.min(h - half - 1, cy + S);
        tr.score = 0;
        if (px < half || py < half || px > w - half - 1 || py > h - half - 1) { // predicted point is off the frame: coast on the gyro
            tr.x = px; tr.y = py; tr.ok = false; tr.lostFrames++; tr.offscreen = true; return tr;
        }
        tr.offscreen = false;
        let best = -2, bx = cx, by = cy;
        for (let y = yMin; y <= yMax; y += 2) for (let x = xMin; x <= xMax; x += 2) {
            const sc = nccAt(gray, w, tr.tpl, tr.size, tr.std, x - half, y - half);
            if (sc > best) { best = sc; bx = x; by = y; }
        }
        const scores = {};
        for (let y = Math.max(yMin, by - 2); y <= Math.min(yMax, by + 2); y++) for (let x = Math.max(xMin, bx - 2); x <= Math.min(xMax, bx + 2); x++) {
            const sc = nccAt(gray, w, tr.tpl, tr.size, tr.std, x - half, y - half);
            scores[x + ',' + y] = sc;
            if (sc > best) { best = sc; bx = x; by = y; }
        }
        // parabolic sub-pixel refinement
        let sx = bx, sy = by;
        const g = (x, y) => scores[x + ',' + y];
        if (g(bx - 1, by) !== undefined && g(bx + 1, by) !== undefined) {
            const l = g(bx - 1, by), r = g(bx + 1, by), dd = l - 2 * best + r; if (dd < 0) sx = bx + 0.5 * (l - r) / dd;
        }
        if (g(bx, by - 1) !== undefined && g(bx, by + 1) !== undefined) {
            const u = g(bx, by - 1), d = g(bx, by + 1), dd = u - 2 * best + d; if (dd < 0) sy = by + 0.5 * (u - d) / dd;
        }
        tr.score = best;
        if (best >= minScore) {
            tr.x = sx; tr.y = sy; tr.ok = true; tr.lostFrames = 0;
            // Slow template refresh so it copes with the view changing as you walk, anchored to the original tap.
            if (best > 0.7) {
                const p = patch(gray, w, h, sx, sy, tr.size), nt = makeTemplate(p);
                for (let i = 0; i < nt.length; i++) tr.tpl[i] = 0.85 * tr.tpl[i] + 0.1 * nt[i] + 0.05 * tr.base[i];
                tr.std = 0.85 * tr.std + 0.1 * Math.max(1e-3, p.std) + 0.05 * tr.baseStd;
            }
        } else {
            tr.x = px; tr.y = py; tr.ok = false; tr.lostFrames++;
        }
        return tr;
    }


    // ---------- synthetic camera (demo mode + tests) ----------
    // World: x east, y north, z up; ground z = sx*x + sy*y. Renders grayscale grass with a ball and a cup.
    function hash2(i, j) { let h = (i * 374761393 + j * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
    function vnoise(x, y) {
        let v = 0, amp = 1, f = 1;
        for (let o = 0; o < 3; o++) {
            const X = x * f, Y = y * f, i = Math.floor(X), j = Math.floor(Y), tx = X - i, ty = Y - j;
            const a = hash2(i, j), b = hash2(i + 1, j), c = hash2(i, j + 1), d = hash2(i + 1, j + 1);
            const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
            v += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy); amp *= 0.5; f *= 2.3;
        }
        return v / 1.75;
    }
    function renderGround(K, R, C, scene, out) {
        const w = K.w, h = K.h; out = out || new Float32Array(w * h);
        const sx = scene.sx || 0, sy = scene.sy || 0;
        const R00 = R[0][0], R01 = R[0][1], R02 = R[0][2], R10 = R[1][0], R11 = R[1][1], R12 = R[1][2], R20 = R[2][0], R21 = R[2][1], R22 = R[2][2];
        for (let py = 0; py < h; py++) {
            const ry = (py + 0.5 - K.cy) / K.f;
            for (let px = 0; px < w; px++) {
                const rx = (px + 0.5 - K.cx) / K.f;
                // device = (rx, -ry, -1)
                const dx = R00 * rx - R01 * ry - R02, dy = R10 * rx - R11 * ry - R12, dz = R20 * rx - R21 * ry - R22;
                const den = dz - sx * dx - sy * dy;
                let v = 150;
                if (den < 0) {
                    const t = (sx * C.x + sy * C.y - C.z) / den;
                    if (t > 0) {
                        const X = C.x + t * dx, Y = C.y + t * dy;
                        v = 60 + 70 * vnoise(X * 25, Y * 25) + 25 * Math.sin(X * 3.1);
                        const db = Math.hypot(X - scene.ball.x, Y - scene.ball.y);
                        if (db < 0.0213) v = 235;
                        const dh = Math.hypot(X - scene.hole.x, Y - scene.hole.y);
                        if (dh < 0.054) v = 15; else if (dh < 0.062) v = 200;
                    }
                }
                out[py * w + px] = v;
            }
        }
        return out;
    }
    function worldToPixel(K, R, C, W) { return projectCam(K, camToDev(mulMtV(R, sub(W, C)))); }

    // Is the aim point to the golfer's left or right (standing at the ball, facing the hole)?
    function sideOf(ball, hole, p) {
        const ax = hole.x - ball.x, ay = -(hole.z - ball.z), bx = p.x - ball.x, by = -(p.z - ball.z);
        const c = ax * by - ay * bx; // > 0: counter-clockwise from the hole direction = left
        const L = Math.hypot(ax, ay) || 1;
        return { side: c > 0 ? 'left' : 'right', dist: Math.abs(c) / L };
    }

    const api = { DEG, rotationFromEuler, upInCamera, pitchDownDeg, intrinsics, pixelRay, projectCam, groundBasis, rayToPlane,
        solveCameraHeight, groundDistance, poseFromTaps, predictPixel, rgbaToGray, renderGround, worldToPixel, createTracker, trackStep, sideOf,
        camToDev, mulMV, mulMtV, V, dot, cross, unit, sub, add, mul };
    root.ARCore = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
