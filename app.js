/* ==========================================================================
   Dennis Poulios – Engineering & Research
   app.js
   Inhalt:
     1. Kern-Engine (Scroll-Fortschritt, rAF-Takt, Vektor-/Matrix-Helfer)
     2. Szene 1  – Torus-Wireframe mit Partikelwolke (Hero)
     3. Szene 2  – Strömungsfeld um ein Hindernis (Skills)
     4. Szene 3  – Zeitleisten-Knoten im Raum (Erfahrung)
     5. UI  – Reveal-Animationen, Header, Mobile-Menü, Karten-Glow, Jahr
   Alle Szenen laufen mit der Scrollrichtung:
     nach unten  -> Fortschritt + (vorwärts)
     nach oben   -> Fortschritt - (rückwärts)
   ========================================================================== */
(function () {
    "use strict";

    var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var DPR = Math.min(window.devicePixelRatio || 1, 2);

    /* ======================================================= 1. Kern-Engine */

    /* --- Farb-/Mathe-Helfer ------------------------------------------- */
    function rgb(r, g, b) { return "rgb(" + (r | 0) + "," + (g | 0) + "," + (b | 0) + ")"; }
    function rgba(r, g, b, a) { return "rgba(" + (r | 0) + "," + (g | 0) + "," + (b | 0) + "," + a + ")"; }
    function lerp(a, b, t) { return a + (b - a) * t; }
    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    function smooth(t) { return t * t * (3 - 2 * t); }

    /* --- Globale Scroll-Geometrie ------------------------------------- */
    var scrollY = window.scrollY || 0;
    var lastScrollY = scrollY;
    var scrollVel = 0;              /* px pro Takt, träge gefiltert   */
    var atTop = true, atBottom = false;
    var ticking = false;

    function readScroll() {
        var next = window.scrollY || window.pageYOffset || 0;
        scrollVel += (next - scrollY) * 0.35;
        scrollY = next;
        var doc = document.documentElement;
        var max = (doc.scrollHeight - window.innerHeight);
        atTop = scrollY <= 2;
        atBottom = max > 0 && scrollY >= max - 2;
    }
    window.addEventListener("scroll", readScroll, { passive: true });
    window.addEventListener("resize", readScroll, { passive: true });

    /* --- Scene-Klasse: Canvas-Setup + Fortschritts-Logik --------------- */
    function Scene(canvas, opts) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.w = 0; this.h = 0;
        this.progress = 0;          /* 0…1, an die Scrollposition gekoppelt */
        this.ready = false;
        this.visible = false;
        this.px = 0; this.py = 0;   /* Zeigerposition, -1…1                 */
        this.range = opts.range || 1.15;   /* Viewport-Höhen für vollen Durchlauf */
        this.maxDelta = opts.maxDelta || 0.16;
        this.reset();
    }

    Scene.prototype.reset = function () {};

    Scene.prototype.resize = function () {
        var rect = this.canvas.getBoundingClientRect();
        var w = Math.max(1, Math.round(rect.width));
        var h = Math.max(1, Math.round(rect.height));
        if (w === this.w && h === this.h) return;
        this.w = w; this.h = h;
        this.canvas.width = Math.round(w * DPR);
        this.canvas.height = Math.round(h * DPR);
        this.ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
        this.onResize();
    };

    Scene.prototype.onResize = function () {};

    /* Fortschritt folgt der Scrollposition – rückwärts wie vorwärts. */
    Scene.prototype.updateProgress = function () {
        var rect = this.canvas.getBoundingClientRect();
        var vh = window.innerHeight || 1;
        var raws = [
            1 - rect.top / vh,                        /* Eintritt von unten   */
            (vh - rect.top) / (vh + rect.height),     /* Durchlauf           */
            1 - rect.bottom / vh                      /* Austritt nach oben   */
        ];
        var raw = 0.45 * raws[1] + 0.35 * raws[0] + 0.20 * raws[2];
        var target = clamp((raw - 0.18) / 0.64, 0, 1);

        var diff = target - this.progress;
        if (diff > this.maxDelta) diff = this.maxDelta;
        if (diff < -this.maxDelta) diff = -this.maxDelta;
        this.progress += diff;
    };

    var scenes = [];

    /* ==================================================== 2. Torus-Szene */
    function TorusScene(canvas) {
        Scene.call(this, canvas, { range: 1.1, maxDelta: 0.03 });
        this.ringPulses = [];
    }
    TorusScene.prototype = Object.create(Scene.prototype);
    TorusScene.prototype.constructor = TorusScene;

    var RING_STEPS = 6;   /* Anzahl der Drahtgitter-Ringe am Torus */

    TorusScene.prototype.reset = function () {
        /* Partikelwolke im Volumen um den Torus */
        var n = 340, i;
        this.pt = new Float32Array(n * 3);
        this.ps = new Float32Array(n);
        for (i = 0; i < n; i++) {
            var a = Math.random() * Math.PI * 2;
            var b = Math.random() * Math.PI * 2;
            var R = 1 + (Math.random() - 0.5) * 0.85;
            var r = 0.42 * (0.35 + Math.random() * 0.9);
            this.pt[i * 3]     = (R + r * Math.cos(b)) * Math.cos(a) * (0.85 + Math.random() * 0.4);
            this.pt[i * 3 + 1] = r * Math.sin(b) * (0.85 + Math.random() * 0.5);
            this.pt[i * 3 + 2] = (R + r * Math.cos(b)) * Math.sin(a) * (0.85 + Math.random() * 0.4);
            this.ps[i] = 0.35 + Math.random() * 0.65;
        }
        /* Zufällige Atome der Partikelwolke – für rückwärts laufende Funkelpunkte */
        this.sparkPhase = new Float32Array(n);
        for (i = 0; i < n; i++) this.sparkPhase[i] = Math.random();

        this.rotX = 0.95;
        this.rotY = 0.45;
        this.popPoints = [];
        this.spawnAcc = 0;
    };

    /* 3D-Punkt rotieren (Y dann X) und perspektivisch projizieren */
    function project(p, cy, sy, cx, sx, zoom, cxpx, cypx) {
        var x1 = p[0] * cy + p[2] * sy;
        var z1 = -p[0] * sy + p[2] * cy;
        var y2 = p[1] * cx - z1 * sx;
        var z2 = p[1] * sx + z1 * cx;
        var persp = zoom / (zoom + z2 + 2.1);
        return [cxpx + x1 * persp * zoom, cypx - y2 * persp * zoom, z2];
    }

    TorusScene.prototype.draw = function () {
        var ctx = this.ctx, w = this.w, h = this.h;
        var p = this.progress;
        ctx.clearRect(0, 0, w, h);

        var base = Math.min(w, h);
        var zoom = base * (0.30 + 0.10 * Math.sin(p * Math.PI));
        var cx = w * (w < 720 ? 0.5 : 0.66);
        var cy = h * (w < 720 ? 0.34 : 0.46);

        /* Rotation: vollständig an den Scrollfortschritt gekoppelt */
        var ax = -0.55 + smooth(p) * 2.6 + this.py * 0.22;
        var ay = 2.2 * p + this.px * 0.5 + 0.2;
        var cX = Math.cos(ax), sX = Math.sin(ax);
        var cY = Math.cos(ay), sY = Math.sin(ay);

        /* ---- Torus-Drahtgitter: Ringe in beiden Richtungen ---- */
        var U = 58, V = 20, i, j;
        var major = 1.0, minor = 0.38;
        ctx.lineWidth = 1;

        for (i = 0; i < U; i += 2) {
            var a = (i / U) * Math.PI * 2 + p * 3.1;
            ctx.beginPath();
            var prev = null;
            for (j = 0; j <= V; j++) {
                var b = (j / V) * Math.PI * 2;
                var px3 = (major + minor * Math.cos(b)) * Math.cos(a);
                var py3 = minor * Math.sin(b);
                var pz3 = (major + minor * Math.cos(b)) * Math.sin(a);
                var pr = project([px3, py3, pz3], cY, sY, cX, sX, zoom, cx, cy);
                if (j === 0) { ctx.moveTo(pr[0], pr[1]); }
                else { ctx.lineTo(pr[0], pr[1]); }
                prev = pr;
            }
            var shade = (i % RING_STEPS) / RING_STEPS;
            var pulse = 0.5 + 0.5 * Math.sin(p * 6.283 + i * 0.42);
            ctx.strokeStyle = rgba(
                lerp(76, 123, shade),
                lerp(201, 140, shade),
                lerp(240, 255, shade),
                0.10 + 0.30 * pulse
            );
            ctx.stroke();
        }

        for (j = 0; j < V; j += 2) {
            var b2 = (j / V) * Math.PI * 2;
            ctx.beginPath();
            for (i = 0; i <= U; i++) {
                var a2 = (i / U) * Math.PI * 2 + p * 3.1;
                var qx = (major + minor * Math.cos(b2)) * Math.cos(a2);
                var qy = minor * Math.sin(b2);
                var qz = (major + minor * Math.cos(b2)) * Math.sin(a2);
                var qr = project([qx, qy, qz], cY, sY, cX, sX, zoom, cx, cy);
                if (i === 0) { ctx.moveTo(qr[0], qr[1]); }
                else { ctx.lineTo(qr[0], qr[1]); }
            }
            ctx.strokeStyle = rgba(140, 165, 220, 0.13);
            ctx.stroke();
        }

        /* ---- Glühende Knoten, die mit dem Scroll entstehen ---- */
        var nodes = 26;
        for (i = 0; i < nodes; i++) {
            var bi = (i / nodes) * Math.PI * 2;
            var loop = (i % RING_STEPS) / RING_STEPS;
            var ai = loop * Math.PI * 2 + p * 3.1;
            var rx = (major + minor * Math.cos(bi)) * Math.cos(ai);
            var ry = minor * Math.sin(bi);
            var rz = (major + minor * Math.cos(bi)) * Math.sin(ai);
            var rr = project([rx, ry, rz], cY, sY, cX, sX, zoom, cx, cy);

            /* Knoten erscheinen nacheinander – nach oben gescrollt verschwinden sie wieder */
            var life = clamp(p * 1.45 - (i / nodes) * 0.45, 0, 1);
            if (life <= 0.02) continue;

            var size = (1.1 + 2.4 * life) * (zoom / (base * 0.34));
            var glow = ctx.createRadialGradient(rr[0], rr[1], 0, rr[0], rr[1], size * 5);
            glow.addColorStop(0, rgba(140, 230, 255, 0.85 * life));
            glow.addColorStop(0.45, rgba(76, 201, 240, 0.32 * life));
            glow.addColorStop(1, rgba(76, 201, 240, 0));
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(rr[0], rr[1], size * 5, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = rgba(220, 245, 255, 0.9 * life);
            ctx.beginPath();
            ctx.arc(rr[0], rr[1], size, 0, Math.PI * 2);
            ctx.fill();
        }

        /* ---- Partikelwolke ---- */
        var n = this.pt.length / 3, k;
        for (k = 0; k < n; k++) {
            var pt = [this.pt[k * 3], this.pt[k * 3 + 1], this.pt[k * 3 + 2]];
            var sp = project(pt, cY, sY, cX, sX, zoom, cx, cy);
            var near = clamp(1.4 - (sp[2] + 1.2) * 0.35, 0.12, 1);
            var drift = this.ps[k];
            var flick = reduceMotion ? 0.6
                : 0.35 + 0.65 * Math.abs(Math.sin(p * 9.0 * drift + this.sparkPhase[k] * 6.283));
            ctx.fillStyle = rgba(
                lerp(123, 210, burn(sp[2])),
                lerp(140, 235, burn(sp[2])),
                255,
                (0.10 + 0.42 * flick) * near * (0.35 + 0.65 * p)
            );
            ctx.fillRect(sp[0], sp[1], 1.15, 1.15);
        }

        /* ---- Lichtpunkte, die beim Scrollen "verbrannt" werden ---- */
        if (!reduceMotion) {
            this.spawnAcc += Math.abs(scrollVel) * 0.28;
            while (this.spawnAcc > 1 && this.popPoints.length < 90) {
                this.spawnAcc -= 1;
                var ang = Math.random() * Math.PI * 2;
                var tub = Math.random() * Math.PI * 2;
                var rp = 1 + 0.38 * Math.cos(tub);
                this.popPoints.push({
                    p: [rp * Math.cos(ang), 0.38 * Math.sin(tub), rp * Math.sin(ang)],
                    life: 1
                });
            }
        }
        for (k = this.popPoints.length - 1; k >= 0; k--) {
            var pp = this.popPoints[k];
            pp.life -= 0.022;
            if (pp.life <= 0) { this.popPoints.splice(k, 1); continue; }
            var pr2 = project(pp.p, cY, sY, cX, sX, zoom, cx, cy);
            var rad = 2 + 10 * (1 - pp.life);
            var g2 = ctx.createRadialGradient(pr2[0], pr2[1], 0, pr2[0], pr2[1], rad);
            g2.addColorStop(0, rgba(255, 210, 170, 0.75 * pp.life));
            g2.addColorStop(1, rgba(255, 138, 92, 0));
            ctx.fillStyle = g2;
            ctx.beginPath();
            ctx.arc(pr2[0], pr2[1], rad, 0, Math.PI * 2);
            ctx.fill();
        }

        function burn(z) { return clamp((z + 1.2) / 2.2, 0, 1); }
    };

    /* ============================================== 3. Strömungs-Szene */
    function FlowScene(canvas) {
        Scene.call(this, canvas, { range: 1.05, maxDelta: 0.022 });
    }
    FlowScene.prototype = Object.create(Scene.prototype);
    FlowScene.prototype.constructor = FlowScene;

    var FIELD_W = 104, FIELD_H = 62;

    FlowScene.prototype.reset = function () {
        var n = FIELD_W * FIELD_H;
        this.fx = new Float32Array(n * 2);   /* aktuelle Position */
        this.f0 = new Float32Array(n * 2);   /* Startposition     */
        this.flife = new Float32Array(n);
        this.i = 0;
        for (var y = 0; y < FIELD_H; y++) {
            for (var x = 0; x < FIELD_W; x++) {
                var id = (y * FIELD_W + x) * 2;
                this.f0[id]     = -0.55 + (x / (FIELD_W - 1)) * 2.1;
                this.f0[id + 1] = -1.0 + (y / (FIELD_H - 1)) * 2.0;
                this.fx[id]     = this.f0[id];
                this.fx[id + 1] = this.f0[id + 1];
                this.flife[y * FIELD_W + x] = 0.05 + Math.random() * 0.35;
            }
        }
    };

    /* Zylinder im Ursprung, Radius 0.30 – Potentialströmung */
    var CYL = 0.30;

    FlowScene.prototype.velocity = function (x, y, t) {
        var r2 = x * x + y * y;
        var R2 = CYL * CYL;
        var u, v;
        if (r2 < R2 * 1.02) {
            u = 0; v = 0;
        } else {
            var f = R2 / r2;
            var ff = R2 * (x * x - y * y) / (r2 * r2);
            u = 1 - f + 2 * ff;
            v = -2 * R2 * x * y / (r2 * r2);
            /* leichte Verwirbelung hinter dem Körper */
            if (x > 0) {
                var wake = Math.exp(-x * 2.4) * Math.sin(y * 7 - t * 5);
                v += wake * 0.34;
                u -= Math.abs(wake) * 0.06;
            }
            /* sanfte Wellen in der freien Strömung */
            v += Math.sin(x * 4.2 + t * 3.1) * 0.05;
        }
        return [u, v];
    };

    FlowScene.prototype.draw = function () {
        var ctx = this.ctx, w = this.w, h = this.h;
        var p = this.progress;
        ctx.clearRect(0, 0, w, h);

        var scale = Math.min(w / 2.6, h / 1.95);
        var ox = w * 0.5, oy = h * 0.5;

        /* Mit dem Scrollen vor- und rückwärts laufende Simulationszeit */
        var t = p * 7.4;
        var step = reduceMotion ? 0.004 : 0.0055;
        var stride = this.i % 2 === 0 ? 1 : 2;   /* Zeilenversatz             */
        this.i++;

        var n = FIELD_W * FIELD_H, k;
        for (k = 0; k < n; k++) {
            var x = this.fx[k * 2], y = this.fx[k * 2 + 1];
            var v = this.velocity(x, y, t);
            var nx = x + v[0] * step;
            var ny = y + v[1] * step;

            /* Partikel, die das Feld verlassen, laufen am Eintritt wieder los –
               und zwar mit dem Fortschritt, sodass alles rückwärts rückwärts läuft */
            if (nx > 1.7 && ((k + this.i) % stride === 0)) {
                nx = -0.58;
                ny = this.f0[k * 2 + 1] + (p - 0.5) * 0.16;
            }
            if (ny > 1.25 || ny < -1.25 || nx < -0.92) {
                nx = this.f0[k * 2];
                ny = this.f0[k * 2 + 1];
            }
            this.fx[k * 2] = nx;
            this.fx[k * 2 + 1] = ny;

            var life = clamp((nx + 0.92) / 0.42, 0, 1) * clamp((1.7 - nx) / 0.5, 0, 1) * p;
            if (life <= 0.02) continue;

            var sx = ox + nx * scale;
            var sy = oy + ny * scale;
            var speed = Math.min(1, Math.hypot(v[0], v[1]) * 0.75);
            var alpha = (0.06 + 0.30 * speed) * life;
            var len = 0.012 + 0.075 * speed;

            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(ox + (nx + v[0] * len) * scale, oy + (ny + v[1] * len) * scale);
            ctx.strokeStyle = speed > 0.72
                ? rgba(150, 195, 255, alpha * 1.35)
                : rgba(76, 201, 240, alpha);
            ctx.lineWidth = 1.1;
            ctx.stroke();
        }

        /* ---- Hindernis mit Ablösezone ---- */
        var cx2 = ox, cy2 = oy, rc = CYL * scale;
        var halo = ctx.createRadialGradient(cx2, cy2, rc * 0.9, cx2, cy2, rc * 3.4);
        halo.addColorStop(0, rgba(76, 201, 240, 0.20 * p));
        halo.addColorStop(1, rgba(76, 201, 240, 0));
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(cx2, cy2, rc * 3.4, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.arc(cx2, cy2, rc, 0, Math.PI * 2);
        ctx.fillStyle = rgba(10, 16, 28, 0.85);
        ctx.fill();
        ctx.strokeStyle = rgba(123, 140, 255, 0.75 * p);
        ctx.lineWidth = 1.4;
        ctx.stroke();

        ctx.fillStyle = rgba(220, 235, 255, 0.75 * p);
        ctx.font = "500 " + Math.max(10, Math.round(w * 0.011)) + "px " + '"JetBrains Mono", monospace';
        ctx.textAlign = "center";
        ctx.fillText("U∞", cx2 - scale * 0.98, cy2 - scale * 0.30);
    };

    /* ============================================= 4. Zeitleisten-Szene */
    function TimelineScene(canvas) {
        Scene.call(this, canvas, { range: 1.15, maxDelta: 0.022 });
    }
    TimelineScene.prototype = Object.create(Scene.prototype);
    TimelineScene.prototype.constructor = TimelineScene;

    var TN = 9;

    TimelineScene.prototype.reset = function () {
        this.nodes = [];
        for (var i = 0; i < TN; i++) {
            this.nodes.push({
                t: i / (TN - 1),
                y: -0.85 + (i / (TN - 1)) * 1.7,
                sway: (Math.random() - 0.5) * 0.34,
                phase: Math.random() * Math.PI * 2,
                label: i === 0 ? "Abitur" : (i === TN - 1 ? "DLR" : "")
            });
        }
    };

    TimelineScene.prototype.draw = function () {
        var ctx = this.ctx, w = this.w, h = this.h;
        var p = this.progress;
        ctx.clearRect(0, 0, w, h);

        var cx = w < 900 ? w * 0.86 : w * 0.845;
        var cy = h * 0.5;
        var span = Math.min(h * 0.60, 300);
        var sway = Math.min(w * 0.10, 150);
        var t = p * 6.283;

        /* Der Faden "wächst" mit dem Fortschritt – nach oben gescrollt zieht er sich zurück */
        var grown = smooth(clamp(p * 1.15, 0, 1));

        var pts = [];
        for (var i = 0; i < this.nodes.length; i++) {
            var nd = this.nodes[i];
            var wobble = Math.sin(t + nd.phase) * 0.30 + nd.sway;
            pts.push([
                cx + wobble * sway,
                cy + nd.y * span,
                Math.abs(Math.cos(t * 0.6 + nd.phase)) * 0.6
            ]);
        }

        /* Kernlinie */
        ctx.beginPath();
        var drawn = clamp(grown * (pts.length - 1), 0, pts.length - 1);
        for (i = 0; i < pts.length; i++) {
            if (i > drawn + 0.001 && i > 0) {
                var seg = clamp(drawn - (i - 1), 0, 1);
                var bx = lerp(pts[i - 1][0], pts[i][0], seg);
                var by = lerp(pts[i - 1][1], pts[i][1], seg);
                ctx.lineTo(bx, by);
                break;
            }
            if (i === 0) ctx.moveTo(pts[i][0], pts[i][1]);
            else ctx.lineTo(pts[i][0], pts[i][1]);
        }
        ctx.strokeStyle = rgba(123, 140, 255, 0.30);
        ctx.lineWidth = 10;
        ctx.lineCap = "round";
        ctx.stroke();

        ctx.strokeStyle = "rgba(160, 205, 255, 0.65)";
        ctx.lineWidth = 1.6;
        ctx.stroke();

        /* Knoten */
        for (i = 0; i < pts.length; i++) {
            var life = clamp(grown * (pts.length - 1) - i + 1, 0, 1);
            if (life <= 0.02) continue;
            var x = pts[i][0], y = pts[i][1];
            var radius = 3.2 + 2.4 * (1 - Math.abs(0.5 - this.nodes[i].t) * 2);

            var glow = ctx.createRadialGradient(x, y, 0, x, y, radius * 6);
            glow.addColorStop(0, rgba(150, 225, 255, 0.42 * life));
            glow.addColorStop(1, rgba(76, 201, 240, 0));
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(x, y, radius * 6, 0, Math.PI * 2);
            ctx.fill();

            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fillStyle = rgba(230, 245, 255, 0.92 * life);
            ctx.fill();

            /* feine Verbindungslinien zur Textspalte */
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(cx + sway * 0.55, y);
            ctx.strokeStyle = rgba(76, 201, 240, 0.14 * life);
            ctx.lineWidth = 1;
            ctx.stroke();
        }
    };

    /* ======================================================== 5. UI-Teile */
    function initReveal() {
        var groups = [
            [".reveal", 0],
            [".timeline .reveal-item", 140],
            [".interest-grid .reveal-interest", 110]
        ];
        var supported = "IntersectionObserver" in window;

        groups.forEach(function (g) {
            var els = document.querySelectorAll(g[0]);
            if (!els.length) return;

            if (!supported || reduceMotion) {
                els.forEach(function (el) { el.classList.add("is-visible"); });
                return;
            }
            var obs = new IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    if (!entry.isIntersecting) return;
                    var idx = entry.target.__idx || 0;
                    entry.target.style.setProperty("--delay", (idx * g[1]) + "ms");
                    entry.target.classList.add("is-visible");
                    obs.unobserve(entry.target);
                });
            }, { threshold: 0.15, rootMargin: "0px 0px -8% 0px" });

            els.forEach(function (el, i) { el.__idx = i; obs.observe(el); });
        });
    }

    function initHeader() {
        var header = document.querySelector(".site-header");
        var bar = document.getElementById("scrollBar");
        var toggle = document.querySelector(".nav-toggle");
        var mobileMenu = document.getElementById("mobile-menu");

        function paint() {
            if (header) header.classList.toggle("is-scrolled", window.scrollY > 24);
            if (bar) {
                var max = document.documentElement.scrollHeight - window.innerHeight;
                bar.style.width = (max > 0 ? clamp(window.scrollY / max, 0, 1) * 100 : 0) + "%";
            }
        }

        if (toggle && header && mobileMenu) {
            toggle.addEventListener("click", function () {
                var open = header.classList.toggle("is-open");
                toggle.setAttribute("aria-expanded", String(open));
                toggle.setAttribute("aria-label", open ? "Menü schließen" : "Menü öffnen");
            });
            mobileMenu.querySelectorAll("a").forEach(function (a) {
                a.addEventListener("click", function () {
                    header.classList.remove("is-open");
                    toggle.setAttribute("aria-expanded", "false");
                    toggle.setAttribute("aria-label", "Menü öffnen");
                });
            });
        }
        return paint;
    }

    function initCards() {
        document.querySelectorAll(".interest-card").forEach(function (card) {
            card.addEventListener("pointermove", function (e) {
                var r = card.getBoundingClientRect();
                card.style.setProperty("--mx", ((e.clientX - r.left) / r.width) * 100 + "%");
                card.style.setProperty("--my", ((e.clientY - r.top) / r.height) * 100 + "%");
            });
        });

        var panel = document.querySelector(".hero-panel");
        if (panel && !reduceMotion) {
            window.addEventListener("pointermove", function (e) {
                var x = (e.clientX / window.innerWidth - 0.5);
                var y = (e.clientY / window.innerHeight - 0.5);
                panel.style.transform = "perspective(1100px) rotateY(" + (x * 5).toFixed(2) +
                    "deg) rotateX(" + (-y * 5).toFixed(2) + "deg)";
                scenes.forEach(function (s) { s.px = x * 2; s.py = y * 2; });
            }, { passive: true });
        }
    }

    /* ========================================================= 6. Start */
    function boot() {
        var paintHeader = initHeader();
        initReveal();
        initCards();

        document.querySelectorAll(".scene-canvas").forEach(function (canvas) {
            var kind = canvas.dataset.scene;
            var scene;
            if (kind === "torus") scene = new TorusScene(canvas);
            else if (kind === "flow") scene = new FlowScene(canvas);
            else if (kind === "timeline") scene = new TimelineScene(canvas);
            else return;
            scene.resize();
            scenes.push(scene);
        });

        if ("IntersectionObserver" in window) {
            var vis = new IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    for (var i = 0; i < scenes.length; i++) {
                        if (scenes[i].canvas === entry.target) scenes[i].visible = entry.isIntersecting;
                    }
                });
            }, { rootMargin: "180px 0px" });
            scenes.forEach(function (s) { vis.observe(s.canvas); });
        } else {
            scenes.forEach(function (s) { s.visible = true; });
        }

        var resizeTimer = null;
        window.addEventListener("resize", function () {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(function () {
                scenes.forEach(function (s) { s.reset(); s.resize(); });
            }, 150);
        }, { passive: true });

        var last = performance.now();
        function frame(now) {
            var dt = Math.min((now - last) / 1000, 0.05);
            last = now;

            readScroll();
            scrollVel *= 0.82;
            if (Math.abs(scrollVel) < 0.01) scrollVel = 0;

            paintHeader();

            for (var i = 0; i < scenes.length; i++) {
                var s = scenes[i];
                if (!s.visible) continue;
                s.updateProgress();
                if (!s.ready) {
                    s.ready = true;
                    s.canvas.classList.add("is-ready");
                }
                s.draw(dt, scrollVel);
            }
            requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);

        var yearEl = document.getElementById("year");
        if (yearEl) yearEl.textContent = String(new Date().getFullYear());

        /* Debug-Ausgabe wie im bisherigen Code – hilfreich beim Einrichten */
        console.log("[scenes] canvases:", scenes.length,
            "| reveal:", document.querySelectorAll(".reveal").length,
            "| timeline:", document.querySelectorAll(".timeline .reveal-item").length,
            "| interests:", document.querySelectorAll(".interest-grid .reveal-interest").length);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
