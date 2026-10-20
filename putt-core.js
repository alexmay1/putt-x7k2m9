// putt-core.js - GENERATED from green-sim.html by tests/build_core.py. Do not edit by hand.
// Same putt solver (a = -(5/7) g grad z - Stimp friction) and scan loader as the simulator.
// Globals the extracted code expects:
let selectedPreset = null;
let stimp = 10;
let realGreens = [];
// Synthetic greens: fixed 10 m x 14 m area (the simulator sizes this to its canvas).
function greenBounds() {
    if (selectedPreset && selectedPreset.kind === 'grid') return selectedPreset.bounds;
    return { x0: -5, x1: 5, z0: -7, z1: 7 };
}

        const G = 9.81;
        const ROLL = 5 / 7;
        function rollDecel() {
            const d = Math.max(1, stimp) * 0.3048;
            return 1.83 * 1.83 / (2 * d);
        }

        const PRESETS = [
            { id: 'flat', name: 'Flat', heightField: (x, z) => x * 0.001 },
            { id: 'slope-rl', name: 'Slope R→L', heightField: (x, z) => x * 0.025 }, // sidehill: a putt down the screen breaks left
            { id: 'slope-lr', name: 'Slope L→R', heightField: (x, z) => -x * 0.025 }, // sidehill: a putt down the screen breaks right
            { id: 'ridge', name: 'Ridge', heightField: (x, z) => 0.12 - Math.sqrt(x * x + 0.36) * 0.03 },
            { id: 'bowl', name: 'Bowl', heightField: (x, z) => Math.sqrt(x * x + 0.36) * 0.03 - 0.06 },
            { id: 'double', name: 'S-Curve', heightField: (x, z) => Math.sin(z / 3 * Math.PI * 2) * 0.015 + x * 0.01 }
        ];
        PRESETS.forEach(p => { p.kind = 'fn'; });

        function makeGridGreen(json, id) {
            const cols = json.cols, rows = json.rows;
            const csx = json.cellSizeX || json.cellSize, csz = json.cellSizeZ || json.cellSize;
            const scale = json.heightUnits === 'mm' ? 0.001 : (json.heightUnits === 'cm' ? 0.01 : 1);
            const n = cols * rows;
            const h = new Float32Array(n);
            const mask = new Uint8Array(n);
            for (let i = 0; i < n; i++) {
                const v = json.heights[i];
                h[i] = (v === null || v === undefined) ? NaN : v * scale;
            }
            for (let r = 0; r < rows; r++) {
                const row = json.mask ? json.mask[r] : null;
                for (let c = 0; c < cols; c++) mask[r * cols + c] = row ? (row.charCodeAt(c) === 49 ? 1 : 0) : 1;
            }
            const low = new Uint8Array(n);
            if (json.lowConfidence) {
                for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++)
                    low[r * cols + c] = json.lowConfidence[r].charCodeAt(c) === 49 ? 1 : 0;
            }
            // Masked/missing cells take the nearest measured height so interpolation is stable at edges.
            fillNearest(h, cols, rows);
            // Gradient at cell centres (central differences), interpolated during the roll.
            const gx = new Float32Array(n), gz = new Float32Array(n);
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const c0 = Math.max(0, c - 1), c1 = Math.min(cols - 1, c + 1);
                    const r0 = Math.max(0, r - 1), r1 = Math.min(rows - 1, r + 1);
                    gx[r * cols + c] = (h[r * cols + c1] - h[r * cols + c0]) / ((c1 - c0) * csx || 1);
                    gz[r * cols + c] = (h[r1 * cols + c] - h[r0 * cols + c]) / ((r1 - r0) * csz || 1);
                }
            }
            const ox = json.origin ? json.origin.x : 0, oz = json.origin ? json.origin.z : 0;
            // Stats over on-green cells.
            let hmin = Infinity, hmax = -Infinity, sgx = 0, sgz = 0, cnt = 0, slopes = [], lowCnt = 0;
            for (let i = 0; i < n; i++) {
                if (!mask[i]) continue;
                hmin = Math.min(hmin, h[i]); hmax = Math.max(hmax, h[i]);
                sgx += gx[i]; sgz += gz[i]; cnt++;
                slopes.push(Math.hypot(gx[i], gz[i]));
                if (low[i]) lowCnt++;
            }
            slopes.sort((a, b) => a - b);
            const g = {
                id: id || ('grid-' + Date.now()), name: json.name || 'Scanned green', kind: 'grid',
                cols, rows, csx, csz, ox, oz, h, gx, gz, mask, low,
                bounds: { x0: ox, x1: ox + cols * csx, z0: oz, z1: oz + rows * csz },
                stats: {
                    areaM2: cnt * csx * csz,
                    rangeM: hmax - hmin, hmin, hmax,
                    medianSlope: slopes.length ? slopes[Math.floor(slopes.length / 2)] : 0,
                    meanGx: cnt ? sgx / cnt : 0, meanGz: cnt ? sgz / cnt : 0,
                    lowM2: lowCnt * csx * csz
                },
                captureDate: json.captureDate || ''
            };
            // Bounding box of the on-green cells (used for the view).
            let c0 = cols, c1 = -1, r0 = rows, r1 = -1;
            for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (mask[r * cols + c]) {
                c0 = Math.min(c0, c); c1 = Math.max(c1, c); r0 = Math.min(r0, r); r1 = Math.max(r1, r);
            }
            if (c1 >= 0) g.bounds = { x0: ox + c0 * csx, x1: ox + (c1 + 1) * csx, z0: oz + r0 * csz, z1: oz + (r1 + 1) * csz };
            return g;
        }

        function fillNearest(h, cols, rows) {
            const n = cols * rows;
            const q = new Int32Array(n);
            let qh = 0, qt = 0;
            const seen = new Uint8Array(n);
            for (let i = 0; i < n; i++) if (!isNaN(h[i])) { seen[i] = 1; q[qt++] = i; }
            if (!qt) { h.fill(0); return; }
            while (qh < qt) {
                const i = q[qh++], r = (i / cols) | 0, c = i - r * cols;
                const nb = [r > 0 ? i - cols : -1, r < rows - 1 ? i + cols : -1, c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1];
                for (const j of nb) if (j >= 0 && !seen[j]) { seen[j] = 1; h[j] = h[i]; q[qt++] = j; }
            }
        }

        function checkerJsonToHeightmap(j) {
            const grid = j.heightData;
            const rows = grid.length, cols = grid[0].length;
            const heights = [];
            for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
                const v = grid[r][c];
                heights.push(v === null || v === undefined ? null : Math.round(v * 1000));
            }
            return {
                format: 'puttguide-heightmap', version: 1,
                name: j.name || 'Checker height map', captureDate: j.captureDate || '',
                cols, rows, cellSizeX: (j.widthMeters || cols * 0.1) / cols, cellSizeZ: (j.heightMeters || rows * 0.1) / rows,
                origin: { x: -(j.widthMeters || 0) / 2, z: -(j.heightMeters || 0) / 2 },
                heightUnits: 'mm', heights, mask: null, lowCoverage: true
            };
        }

        function distance(p1, p2) {
            const dx = p2.x - p1.x;
            const dz = p2.z - p1.z;
            return Math.sqrt(dx * dx + dz * dz);
        }

        function normalize(vec) {
            const len = Math.sqrt(vec.x * vec.x + vec.z * vec.z);
            if (len < 0.0001) return { x: 0, z: 0 };
            return { x: vec.x / len, z: vec.z / len };
        }

        function gridSample(arr, g, x, z) {
            let fx = (x - g.ox) / g.csx - 0.5, fz = (z - g.oz) / g.csz - 0.5;
            fx = Math.max(0, Math.min(g.cols - 1.001, fx));
            fz = Math.max(0, Math.min(g.rows - 1.001, fz));
            const c = fx | 0, r = fz | 0, tx = fx - c, tz = fz - r;
            const i = r * g.cols + c;
            const c1 = c + 1 < g.cols ? 1 : 0, r1 = r + 1 < g.rows ? g.cols : 0;
            const a = arr[i] * (1 - tx) + arr[i + c1] * tx;
            const b = arr[i + r1] * (1 - tx) + arr[i + r1 + c1] * tx;
            return a * (1 - tz) + b * tz;
        }

        function getHeight(x, z) {
            if (selectedPreset.kind === 'grid') return gridSample(selectedPreset.h, selectedPreset, x, z);
            return selectedPreset.heightField(x, z);
        }

        function getGradient(x, z, delta = 0.02) {
            const g = selectedPreset;
            if (g.kind === 'grid') return { x: gridSample(g.gx, g, x, z), z: gridSample(g.gz, g, x, z) };
            return {
                x: (getHeight(x + delta, z) - getHeight(x - delta, z)) / (2 * delta),
                z: (getHeight(x, z + delta) - getHeight(x, z - delta)) / (2 * delta)
            };
        }

        function isOnGreen(x, z) {
            const g = selectedPreset;
            if (g.kind !== 'grid') {
                const b = greenBounds();
                return x >= b.x0 - 1 && x <= b.x1 + 1 && z >= b.z0 - 1 && z <= b.z1 + 1;
            }
            const c = Math.floor((x - g.ox) / g.csx), r = Math.floor((z - g.oz) / g.csz);
            if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return false;
            return g.mask[r * g.cols + c] === 1;
        }

        function paceForPower(power) {
            const p = Math.max(0, Math.min(1, power / 100));
            return 0.05 + Math.pow(p, 2.2) * 1.05;
        }

        function launchSpeed(targetDist, power, ball, hole) {
            const d = rollDecel();
            const dist = Math.max(0.25, targetDist);
            let climb = 0;
            if (ball && hole) climb = getHeight(hole.x, hole.z) - getHeight(ball.x, ball.z);
            const path = dist * 1.05; // break makes the roll a bit longer than the straight line
            const energy = d * path + ROLL * G * climb + d * paceForPower(power);
            return Math.sqrt(2 * Math.max(0.03, energy));
        }

        function distPointToSegment(p, a, b) {
            const abx = b.x - a.x, abz = b.z - a.z;
            const apx = p.x - a.x, apz = p.z - a.z;
            const ab2 = abx * abx + abz * abz;
            if (ab2 < 1e-12) return Math.hypot(apx, apz);
            let t = (apx * abx + apz * abz) / ab2;
            t = Math.max(0, Math.min(1, t));
            return Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
        }

        function simulatePuttWithAim(ball, aimAngle, power, maxDist = 22, cupPos = null, cupRadius = 0.08, v0Override = null, record = true) {
            const d = rollDecel();
            let dt = 0.008;
            const targetDist = cupPos ? distance(ball, cupPos) : maxDist;
            const v0 = v0Override !== null ? v0Override : launchSpeed(targetDist, power, ball, cupPos);
            // Unit vector ball -> cup, used to stop early once a miss is well past the cup.
            const ux = cupPos ? (cupPos.x - ball.x) / Math.max(1e-6, targetDist) : 0;
            const uz = cupPos ? (cupPos.z - ball.z) / Math.max(1e-6, targetDist) : 0;
            const cx = cupPos ? cupPos.x : 0, cz = cupPos ? cupPos.z : 0, cr2 = cupRadius * cupRadius;
            const farLimit = Math.max(maxDist, targetDist * 3);
            const g = selectedPreset;
            const isGrid = g.kind === 'grid';
            const hf = g.heightField;
            const b = isGrid ? null : greenBounds();
            const k = ROLL * G;
            let px = ball.x, pz = ball.z;
            let vx = v0 * Math.cos(aimAngle), vz = v0 * Math.sin(aimAngle);
            const points = [{ x: px, z: pz }];
            let captureIndex = null, capturedSpeed = null;
            let time = 0, step = 0;
            let stopped = false, offGreen = false, passed = false;
            let gxv = 0, gzv = 0;
            let closest = Infinity, closestStep = 0;
            while (time < 18) {
                if (isGrid) { gxv = gridSample(g.gx, g, px, pz); gzv = gridSample(g.gz, g, px, pz); }
                else {
                    gxv = (hf(px + 0.02, pz) - hf(px - 0.02, pz)) / 0.04;
                    gzv = (hf(px, pz + 0.02) - hf(px, pz - 0.02)) / 0.04;
                }
                const speed = Math.sqrt(vx * vx + vz * vz);
                if (speed < 0.02 && k * Math.sqrt(gxv * gxv + gzv * gzv) <= d) { stopped = true; break; }
                dt = Math.min(0.02, Math.max(0.004, 0.015 / (speed + 1e-6))); // ~1.5 cm steps
                const inv = speed > 1e-6 ? 1 / speed : 0;
                vx += (-k * gxv - d * vx * inv) * dt;
                vz += (-k * gzv - d * vz * inv) * dt;
                const qx = px, qz = pz;
                px += vx * dt; pz += vz * dt;
                step++;
                const on = isGrid ? isOnGreen(px, pz)
                    : (px >= b.x0 - 1 && px <= b.x1 + 1 && pz >= b.z0 - 1 && pz <= b.z1 + 1);
                if (!on) { offGreen = true; if (record) points.push({ x: px, z: pz }); break; }
                if (record && (step & 1) === 0) points.push({ x: px, z: pz });
                if (cupPos && captureIndex === null) {
                    // distance from cup to the segment just travelled
                    const sx = px - qx, sz = pz - qz, l2 = sx * sx + sz * sz;
                    let t = l2 > 1e-12 ? ((cx - qx) * sx + (cz - qz) * sz) / l2 : 0;
                    t = t < 0 ? 0 : (t > 1 ? 1 : t);
                    const ex = qx + sx * t - cx, ez = qz + sz * t - cz;
                    const e2 = ex * ex + ez * ez;
                    if (e2 < closest) { closest = e2; closestStep = step; }
                    if (e2 < cr2) {
                        capturedSpeed = speed;
                        if (!record) { captureIndex = 0; break; }
                        if ((step & 1) !== 0) points.push({ x: px, z: pz });
                        captureIndex = points.length - 1;
                        points[captureIndex] = { x: cx, z: cz };
                    } else if ((step & 7) === 0) {
                        const along = (px - ball.x) * ux + (pz - ball.z) * uz;
                        if (along > targetDist + 0.6) { passed = true; break; }
                    }
                }
                time += dt;
                if ((step & 15) === 0 && Math.hypot(px - ball.x, pz - ball.z) > farLimit) break;
            }
            if (record && !offGreen) points.push({ x: px, z: pz });
            return { path: points, captureIndex, capturedSpeed, v0, stopped, offGreen, passed,
                     closest: captureIndex !== null ? 0 : Math.sqrt(closest), closestAtEnd: captureIndex === null && step - closestStep <= 2 };
        }

        function pathLength(pts, from) {
            let L = 0;
            for (let i = (from || 0) + 1; i < pts.length; i++) L += distance(pts[i - 1], pts[i]);
            return L;
        }

        function searchAimAtSpeed(ball, hole, power, v0, cupRadius, around = null) {
            const naiveAngle = Math.atan2(hole.z - ball.z, hole.x - ball.x);
            const distBH = Math.max(0.3, distance(ball, hole));
            const perp = { x: Math.cos(naiveAngle + Math.PI / 2), z: Math.sin(naiveAngle + Math.PI / 2) };
            const maxOffset = Math.min(4.2, Math.max(1.2, distBH * 1.1));
            const lo = around === null ? -maxOffset : Math.max(-maxOffset, around - 0.45);
            const hi = around === null ? maxOffset : Math.min(maxOffset, around + 0.45);
            function rollAt(offset) {
                const aimPoint = { x: hole.x + perp.x * offset, z: hole.z + perp.z * offset };
                const angle = Math.atan2(aimPoint.z - ball.z, aimPoint.x - ball.x);
                const result = simulatePuttWithAim(ball, angle, power, 22, hole, cupRadius, v0, false);
                return { offset, angle, result, closest: result.closest };
            }
            const coarse = around === null ? 41 : 13;
            let samples = [];
            for (let i = 0; i < coarse; i++) samples.push(rollAt(lo + (hi - lo) * (i / (coarse - 1))));
            samples.sort((a, b) => a.closest - b.closest);
            const seeds = samples.slice(0, around === null ? 3 : 2);
            let best = null;
            for (const seed of seeds) {
                for (let k = -8; k <= 8; k++) {
                    const offset = seed.offset + k * 0.025;
                    if (Math.abs(offset) > maxOffset + 0.05) continue;
                    const hit = rollAt(offset);
                    if (hit.result.captureIndex === null) continue;
                    if (!best || Math.abs(hit.offset) < Math.abs(best.offset) - 1e-4) best = hit;
                }
            }
            return { best, closest: samples[0], perp, naiveAngle };
        }

        function overrunOf(result) {
            if (result.captureIndex === null) return null;
            if (!result.stopped) return Infinity;
            return pathLength(result.path, result.captureIndex);
        }

        function solveAimAngle(ball, hole, power, cupRadius = 0.08) {
            const d = rollDecel();
            const pace = paceForPower(power);
            // Target speed as the ball reaches the cup: the speed that would roll `pace`
            // metres further on flat green. Soft = dying at the cup, hard = firm.
            const vt = Math.sqrt(2 * d * pace);
            let v0 = launchSpeed(distance(ball, hole), power, ball, hole);
            let chosen = null, chosenErr = Infinity, lastSearch = null, around = null;
            // Speed search: bracket [lo, hi] on launch speed, energy-based guesses, bisection fallback.
            let lo = 0, hi = Infinity;
            for (let iter = 0; iter < 8; iter++) {
                let s = searchAimAtSpeed(ball, hole, power, v0, cupRadius, around);
                if (!s.best && around !== null) s = searchAimAtSpeed(ball, hole, power, v0, cupRadius, null);
                lastSearch = s;
                let guess;
                if (s.best) {
                    const vc = s.best.result.capturedSpeed;
                    const err = Math.abs(vc - vt);
                    if (err < chosenErr) { chosen = s; chosenErr = err; }
                    if (err < 0.03 + 0.08 * vt) break;
                    if (vc > vt) hi = Math.min(hi, v0); else lo = Math.max(lo, v0);
                    // Energy correction: changing v0^2 changes the speed^2 at the cup by about the same amount.
                    guess = Math.sqrt(Math.max(0.01, v0 * v0 + (vt * vt - vc * vc)));
                    around = s.best.offset;
                } else {
                    const c = s.closest;
                    const atEnd = c.result.closestAtEnd;
                    if (c.result.offGreen && atEnd && !chosen) {
                        hi = Math.min(hi, v0); guess = v0 * 0.85; // ran off the scanned green first
                    } else if (c.result.stopped && atEnd) {
                        lo = Math.max(lo, v0); guess = Math.sqrt(v0 * v0 + 2 * d * (c.closest + pace) * 1.1); // short
                    } else {
                        // Passed the hole wide at every aim: too soft to hold this line.
                        lo = Math.max(lo, v0); guess = v0 * 1.1;
                    }
                }
                if (hi - lo < 0.012) break;
                v0 = (guess > lo && guess < hi) ? guess : (isFinite(hi) ? (lo + hi) / 2 : Math.max(guess, lo * 1.1));
            }
            const s = chosen || lastSearch;
            const naiveResult = simulatePuttWithAim(ball, s.naiveAngle, power, 22, hole, cupRadius, v0);
            if (chosen) {
                const best = chosen.best;
                const result = simulatePuttWithAim(ball, best.angle, power, 22, hole, cupRadius, best.result.v0, true);
                if (result.captureIndex === null) { result.captureIndex = result.path.length - 1; } // numerical edge case
                const idx = result.captureIndex;
                const sinkPath = result.path.slice(0, idx + 1);
                sinkPath[sinkPath.length - 1] = { x: hole.x, z: hole.z };
                let overrunPath = null;
                if (idx < result.path.length - 2) {
                    const tail = result.path.slice(idx);
                    const over = distance(tail[tail.length - 1], hole);
                    if (over >= 0.22) overrunPath = tail;
                }
                const off = best.offset;
                return {
                    aimAngle: best.angle,
                    aimPoint: { x: hole.x + chosen.perp.x * off, z: hole.z + chosen.perp.z * off },
                    sinkPath, overrunPath,
                    naivePath: naiveResult.path,
                    aimOffset: Math.abs(off),
                    offsetDir: off > 0.03 ? 'R' : (off < -0.03 ? 'L' : ''),
                    captureSpeed: result.capturedSpeed,
                    v0: result.v0,
                    overrun: overrunOf(result),
                    runsOff: result.offGreen,
                    missed: false
                };
            }
            return {
                aimAngle: s.naiveAngle, aimPoint: hole,
                sinkPath: naiveResult.path, overrunPath: null, naivePath: naiveResult.path,
                aimOffset: 0, offsetDir: '', captureSpeed: null, v0,
                runsOff: naiveResult.offGreen, missed: true
            };
        }

        var PLY_TYPES = {
            char: 1, int8: 1, uchar: 1, uint8: 1,
            short: 2, int16: 2, ushort: 2, uint16: 2,
            int: 4, int32: 4, uint: 4, uint32: 4,
            float: 4, float32: 4, double: 8, float64: 8
        };

        function findHeaderEnd(bytes) {
            var marker = [101,110,100,95,104,101,97,100,101,114];
            var limit = Math.min(bytes.length, 2000000);
            for (var i = 0; i < limit; i++) {
                var ok = true;
                for (var k = 0; k < marker.length; k++) { if (bytes[i + k] !== marker[k]) { ok = false; break; } }
                if (!ok) continue;
                var j = i + marker.length;
                if (bytes[j] === 13) j++;
                if (bytes[j] === 10) j++;
                else if (bytes[j] !== 10 && bytes[j] !== undefined) continue;
                return j;
            }
            return -1;
        }

        function parsePLYPoints(arrayBuffer) {
            var bytes = new Uint8Array(arrayBuffer);
            var headerEnd = findHeaderEnd(bytes);
            if (headerEnd < 0) throw new Error('Not a PLY file (no end_header)');
            var header = new TextDecoder('utf-8').decode(bytes.subarray(0, headerEnd));
            var lines = header.split(/\r?\n/);
            var format = 'ascii', vertexCount = 0, inVertex = false, props = [];
            for (var li = 0; li < lines.length; li++) {
                var line = lines[li].trim();
                if (!line || line.indexOf('comment') === 0) continue;
                if (line.indexOf('format ') === 0) format = line.split(/\s+/)[1];
                else if (line.indexOf('element ') === 0) {
                    var ep = line.split(/\s+/);
                    inVertex = ep[1] === 'vertex';
                    if (inVertex) vertexCount = parseInt(ep[2], 10) || 0;
                } else if (inVertex && line.indexOf('property ') === 0) {
                    var pp = line.split(/\s+/);
                    if (pp[1] === 'list') throw new Error('This PLY is a mesh, not a point cloud. Export Point Cloud, then PLY.');
                    props.push({ type: pp[1], name: pp[2] });
                }
            }
            if (!vertexCount) throw new Error('PLY has no vertices');
            var xi = -1, yi = -1, zi = -1;
            for (var pi = 0; pi < props.length; pi++) {
                if (props[pi].name === 'x') xi = pi;
                if (props[pi].name === 'y') yi = pi;
                if (props[pi].name === 'z') zi = pi;
            }
            if (xi < 0 || yi < 0 || zi < 0) throw new Error('PLY has no x y z');
            var offsets = [], stride = 0;
            for (var ti = 0; ti < props.length; ti++) {
                var sz = PLY_TYPES[props[ti].type];
                if (!sz) throw new Error('Unsupported PLY property type: ' + props[ti].type);
                offsets.push(stride); stride += sz;
            }
            var MAX_POINTS = 300000;
            var step = Math.max(1, Math.ceil(vertexCount / MAX_POINTS));
            var cap = Math.ceil(vertexCount / step) + 1;
            var X = new Float32Array(cap), Y = new Float32Array(cap), Z = new Float32Array(cap), n = 0;
            function push(x, y, z) { if (isFinite(x) && isFinite(y) && isFinite(z) && n < cap) { X[n] = x; Y[n] = y; Z[n] = z; n++; } }
            if (format === 'ascii') {
                var text = new TextDecoder('utf-8').decode(bytes.subarray(headerEnd));
                var pos = 0, seen = 0, L = text.length;
                while (pos < L && seen < vertexCount) {
                    var nl = text.indexOf('\n', pos); if (nl < 0) nl = L;
                    if (seen % step === 0) {
                        var parts = text.substring(pos, nl).trim().split(/\s+/);
                        if (parts.length >= props.length) push(+parts[xi], +parts[yi], +parts[zi]);
                    }
                    seen++; pos = nl + 1;
                }
            } else if (format === 'binary_little_endian' || format === 'binary_big_endian') {
                var view = new DataView(arrayBuffer, headerEnd);
                var little = format === 'binary_little_endian';
                function readNum(type, off) {
                    if (type === 'float' || type === 'float32') return view.getFloat32(off, little);
                    if (type === 'double' || type === 'float64') return view.getFloat64(off, little);
                    if (type === 'char' || type === 'int8') return view.getInt8(off);
                    if (type === 'uchar' || type === 'uint8') return view.getUint8(off);
                    if (type === 'short' || type === 'int16') return view.getInt16(off, little);
                    if (type === 'ushort' || type === 'uint16') return view.getUint16(off, little);
                    if (type === 'int' || type === 'int32') return view.getInt32(off, little);
                    if (type === 'uint' || type === 'uint32') return view.getUint32(off, little);
                    return NaN;
                }
                var avail = Math.min(vertexCount, Math.floor(view.byteLength / stride));
                for (var vi = 0; vi < avail; vi += step) {
                    var base = vi * stride;
                    push(readNum(props[xi].type, base + offsets[xi]), readNum(props[yi].type, base + offsets[yi]), readNum(props[zi].type, base + offsets[zi]));
                }
            } else throw new Error('Unsupported PLY format: ' + format);
            return { x: X.subarray(0, n), y: Y.subarray(0, n), z: Z.subarray(0, n), total: vertexCount };
        }

        function pickUpAxis(P) {
            // Dominant plane by RANSAC, snapped to the closest axis (ARKit/LiDARo = Y up).
            var s = 12345 >>> 0;
            function rnd() { s = (s + 0x6D2B79F5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
            var n = P.x.length, best = [0, 1, 0], bestCount = -1, sample = [];
            for (var k = 0; k < Math.min(n, 3000); k++) sample.push(Math.floor(rnd() * n));
            for (var it = 0; it < 200; it++) {
                var a = Math.floor(rnd() * n), b = Math.floor(rnd() * n), c = Math.floor(rnd() * n);
                var ux = P.x[b] - P.x[a], uy = P.y[b] - P.y[a], uz = P.z[b] - P.z[a];
                var vx = P.x[c] - P.x[a], vy = P.y[c] - P.y[a], vz = P.z[c] - P.z[a];
                var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
                var len = Math.hypot(nx, ny, nz); if (len < 1e-9) continue;
                nx /= len; ny /= len; nz /= len;
                var d = -(nx * P.x[a] + ny * P.y[a] + nz * P.z[a]), cnt = 0;
                for (var q = 0; q < sample.length; q++) { var i = sample[q]; if (Math.abs(nx * P.x[i] + ny * P.y[i] + nz * P.z[i] + d) < 0.03) cnt++; }
                if (cnt > bestCount) { bestCount = cnt; best = [nx, ny, nz]; }
            }
            var comps = best.map(Math.abs), up = 1;
            if (comps[2] > comps[up]) up = 2;
            if (comps[0] > comps[up]) up = 0;
            return up;
        }

        function pctl(sortedArr, p) {
            if (!sortedArr.length) return 0;
            var idx = (sortedArr.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
            return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
        }

        function cellMedians(U, V, H, keep, ox, oz, cs, cols, rows, minCount) {
            var n = U.length, ncell = cols * rows;
            var counts = new Int32Array(ncell + 1);
            var cellOf = new Int32Array(n).fill(-1);
            for (var i = 0; i < n; i++) {
                if (keep && !keep[i]) continue;
                var c = Math.floor((U[i] - ox) / cs), r = Math.floor((V[i] - oz) / cs);
                if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
                cellOf[i] = r * cols + c; counts[r * cols + c + 1]++;
            }
            for (var k = 0; k < ncell; k++) counts[k + 1] += counts[k];
            var fillPos = counts.slice(0, ncell), vals = new Float32Array(counts[ncell]);
            for (var i2 = 0; i2 < n; i2++) if (cellOf[i2] >= 0) vals[fillPos[cellOf[i2]]++] = H[i2];
            var out = new Float32Array(ncell).fill(NaN);
            for (var k2 = 0; k2 < ncell; k2++) {
                var a = counts[k2], b = counts[k2 + 1];
                if (b - a < minCount) continue;
                var arr = Array.prototype.slice.call(vals.subarray(a, b)).sort(function (p, q) { return p - q; });
                out[k2] = pctl(arr, 0.5);
            }
            return out;
        }

        function pointsToHeightmap(P, name) {
            var up = pickUpAxis(P);
            var A = [P.x, P.y, P.z];
            // Screen axes: Y-up -> (x, z); Z-up -> (x, -y); X-up -> (y, z)
            var n = P.x.length;
            var U = up === 0 ? A[1] : A[0];
            var V = new Float32Array(n), H = A[up];
            for (var i = 0; i < n; i++) V[i] = up === 2 ? -A[1][i] : A[2][i];
            var us = Array.prototype.slice.call(U).sort(function (a, b) { return a - b; });
            var vs = Array.prototype.slice.call(V).sort(function (a, b) { return a - b; });
            var u0 = pctl(us, 0.002), u1 = pctl(us, 0.998), v0 = pctl(vs, 0.002), v1 = pctl(vs, 0.998);
            var cs = Math.max(0.1, Math.max(u1 - u0, v1 - v0) / 160);
            var ox = Math.floor(u0 / cs) * cs, oz = Math.floor(v0 / cs) * cs;
            var cols = Math.ceil((u1 - ox) / cs) + 1, rows = Math.ceil((v1 - oz) / cs) + 1;
            // Coarse 40 cm surface, then drop points > 8 cm off it (people, bag, flagstick, noise).
            var C = Math.max(0.4, cs * 4), ccols = Math.ceil((u1 - ox) / C) + 1, crows = Math.ceil((v1 - oz) / C) + 1;
            var coarse = cellMedians(U, V, H, null, ox, oz, C, ccols, crows, 8);
            var keep = new Uint8Array(n);
            var dropped = 0;
            for (var i3 = 0; i3 < n; i3++) {
                var cc = Math.floor((U[i3] - ox) / C), cr = Math.floor((V[i3] - oz) / C);
                var ref = (cc >= 0 && cr >= 0 && cc < ccols && cr < crows) ? coarse[cr * ccols + cc] : NaN;
                if (isFinite(ref) && Math.abs(H[i3] - ref) < 0.08) keep[i3] = 1; else dropped++;
            }
            var G = cellMedians(U, V, H, keep, ox, oz, cs, cols, rows, 3);
            // Fill small gaps: a cell with >= 5 of 8 measured neighbours gets their mean.
            for (var it = 0; it < 6; it++) {
                var add = [];
                for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
                    if (isFinite(G[r * cols + c])) continue;
                    var s = 0, m = 0;
                    for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
                        if (!dr && !dc) continue;
                        var rr = r + dr, c2 = c + dc;
                        if (rr < 0 || c2 < 0 || rr >= rows || c2 >= cols) continue;
                        var vv = G[rr * cols + c2]; if (isFinite(vv)) { s += vv; m++; }
                    }
                    if (m >= 5) add.push([r * cols + c, s / m]);
                }
                if (!add.length) break;
                add.forEach(function (e) { G[e[0]] = e[1]; });
            }
            // Mask: measured cells, minus specks under 1 m^2.
            var ncell = cols * rows, mask = new Uint8Array(ncell), lab = new Int32Array(ncell), minCells = Math.round(1 / (cs * cs));
            for (var k = 0; k < ncell; k++) mask[k] = isFinite(G[k]) ? 1 : 0;
            var cur = 0;
            for (var k2 = 0; k2 < ncell; k2++) {
                if (!mask[k2] || lab[k2]) continue;
                cur++; var stack = [k2], comp = []; lab[k2] = cur;
                while (stack.length) {
                    var q = stack.pop(); comp.push(q);
                    var qr = (q / cols) | 0, qc = q - qr * cols;
                    var nb = [qr > 0 ? q - cols : -1, qr < rows - 1 ? q + cols : -1, qc > 0 ? q - 1 : -1, qc < cols - 1 ? q + 1 : -1];
                    for (var t = 0; t < 4; t++) { var j = nb[t]; if (j >= 0 && mask[j] && !lab[j]) { lab[j] = cur; stack.push(j); } }
                }
                if (comp.length < minCells) comp.forEach(function (q2) { mask[q2] = 0; });
            }
            // Masked Gaussian smoothing, sigma 1.5 cells.
            var sig = 1.5, R = 4, ker = [];
            for (var d = -R; d <= R; d++) ker.push(Math.exp(-0.5 * (d / sig) * (d / sig)));
            function blur(src, w, horiz) {
                var out = new Float32Array(ncell), wout = new Float32Array(ncell);
                for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
                    var s = 0, ws = 0;
                    for (var d = -R; d <= R; d++) {
                        var rr = horiz ? r : r + d, c2 = horiz ? c + d : c;
                        if (rr < 0 || c2 < 0 || rr >= rows || c2 >= cols) continue;
                        var kk = ker[d + R]; s += src[rr * cols + c2] * kk; ws += w[rr * cols + c2] * kk;
                    }
                    out[r * cols + c] = s; wout[r * cols + c] = ws;
                }
                return [out, wout];
            }
            var A0 = new Float32Array(ncell), W0 = new Float32Array(ncell);
            for (var k3 = 0; k3 < ncell; k3++) if (mask[k3]) { A0[k3] = G[k3]; W0[k3] = 1; }
            var h1 = blur(A0, W0, true), h2 = blur(h1[0], h1[1], false);
            var hmin = Infinity;
            var Hs = new Float32Array(ncell);
            for (var k4 = 0; k4 < ncell; k4++) {
                Hs[k4] = mask[k4] && h2[1][k4] > 1e-6 ? h2[0][k4] / h2[1][k4] : NaN;
                if (mask[k4] && isFinite(Hs[k4])) hmin = Math.min(hmin, Hs[k4]); else mask[k4] = 0;
            }
            var heights = [], maskRows = [];
            for (var k5 = 0; k5 < ncell; k5++) heights.push(isFinite(Hs[k5]) ? Math.round((Hs[k5] - hmin) * 1000) : null);
            for (var r2 = 0; r2 < rows; r2++) {
                var srow = '';
                for (var c3 = 0; c3 < cols; c3++) srow += mask[r2 * cols + c3] ? '1' : '0';
                maskRows.push(srow);
            }
            return {
                format: 'puttguide-heightmap', version: 1, name: name || 'Loaded scan',
                cellSize: cs, cols: cols, rows: rows, origin: { x: ox, z: oz }, heightUnits: 'mm',
                heights: heights, mask: maskRows, upAxis: 'xyz'.charAt(up), droppedPoints: dropped, totalPoints: P.total
            };
        }

        function loadHeightmapObject(json, id) {
            if (json && json.heightData && !json.heights) json = checkerJsonToHeightmap(json);
            if (!json || !json.heights || !json.cols || !json.rows) throw new Error('Not a PuttGuide height map');
            const g = makeGridGreen(json, id);
            g.fromChecker = !!json.lowCoverage;
            const existing = realGreens.findIndex(r => r.id === g.id);
            if (existing >= 0) realGreens[existing] = g; else realGreens.push(g);
            return g;
        }
selectedPreset = PRESETS[1];
