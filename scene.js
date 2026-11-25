/* ==========================================================================
   scene.js – Scroll-gesteuerter 3D-Hintergrund (Three.js / WebGL2)

   Eine durchgehende Szene mit sechs "Stationen", eine pro Abschnitt. Beim
   Scrollen fliegt die Kamera von Station zu Station; im Schaufenster nach
   jedem Abschnitt ist die Szene frei sichtbar und ihre Parameter laufen durch:

     Hero        → Raketentriebwerk, Abgasstrahl mit Mach-Diamanten
     Über mich   → Erde mit Satellit (Umlaufzeit nach Kepler)
     Skills      → Potentialströmung um ein Joukowski-Profil (α steigt)
     Werdegang   → Emissionsspektroskopie einer Methanflamme (φ steigt)
     Interessen  → Kernspaltung von U-235 als Kettenreaktion (k steigt)
     Kontakt     → Stern mit Exoplanetentransit

   Fällt WebGL2 oder das Laden von Three.js aus, bekommt <html> die Klasse
   "no-webgl" und das CSS zeigt den statischen Hintergrund.
   ========================================================================== */
(function () {
  'use strict';

  const canvas = document.getElementById('bg3d');
  if (!canvas) return;
  const root = document.documentElement;

  const probeCtx = document.createElement('canvas').getContext('webgl2');
  if (!probeCtx) {
    root.classList.add('no-webgl');
    return;
  }
  const lose = probeCtx.getExtension('WEBGL_lose_context');
  if (lose) lose.loseContext();

  Promise.all([
    import('three'),
    import('three/addons/postprocessing/EffectComposer.js'),
    import('three/addons/postprocessing/RenderPass.js'),
    import('three/addons/postprocessing/UnrealBloomPass.js'),
    import('three/addons/postprocessing/OutputPass.js'),
    import('three/addons/environments/RoomEnvironment.js'),
  ])
    .then(([THREE, ec, rp, ub, op, re]) => {
      init(THREE, ec.EffectComposer, rp.RenderPass, ub.UnrealBloomPass, op.OutputPass, re.RoomEnvironment);
      root.classList.add('has-webgl');
    })
    .catch((err) => {
      console.warn('3D-Hintergrund deaktiviert:', err);
      root.classList.add('no-webgl');
    });

  // ------------------------------------------------------------------------
  function init(THREE, EffectComposer, RenderPass, UnrealBloomPass, OutputPass, RoomEnvironment) {
    const lang = (root.lang || 'de').toLowerCase().startsWith('en') ? 'en' : 'de';
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const lowPower = matchMedia('(max-width: 767px)').matches || (navigator.hardwareConcurrency || 8) <= 4;
    const Q = lowPower ? 0.45 : 1; // Partikel-Qualität

    const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
    const lerp = (a, b, t) => a + (b - a) * t;
    const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    const rand = (a, b) => a + Math.random() * (b - a);

    // ---------- Renderer ----------
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: !lowPower, powerPreference: 'high-performance' });
    let pixelRatio = Math.min(window.devicePixelRatio || 1, lowPower ? 1.25 : 1.5);
    renderer.setPixelRatio(pixelRatio);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x02040b);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.45;

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 4000);

    // Feste Lichtanzahl (verhindert Shader-Neukompilierung beim Stationswechsel)
    const hemi = new THREE.HemisphereLight(0x9db8ff, 0x0b0b14, 0.5);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    const hot = new THREE.PointLight(0xff8a3d, 0, 0, 2);
    scene.add(hemi, key, key.target, hot);

    // ---------- Gemeinsame Shader-Bausteine ----------
    const common = { uTime: { value: 0 }, uHalfH: { value: 500 } };

    const GLSL_COMMON = /* glsl */ `
      attribute vec4 aSeed;
      uniform float uTime;
      uniform float uHalfH;
      uniform float uMaxSize;
      uniform float uIntensity;
      varying vec3 vColor;
      float pSize(float s, vec4 mv) {
        return clamp(s * projectionMatrix[1][1] * uHalfH / max(0.001, -mv.z), 1.0, uMaxSize);
      }
    `;
    const FRAG_GLOW = /* glsl */ `
      varying vec3 vColor;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = dot(c, c) * 4.0;
        if (d > 1.0) discard;
        gl_FragColor = vec4(vColor, exp(-d * 4.5));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `;

    function makeParticles(count, fill, vertexMain, uniforms = {}, maxSize = 64, extraAttr = null) {
      const geo = new THREE.BufferGeometry();
      const seeds = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) fill(seeds, i * 4, i);
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
      if (extraAttr) for (const k in extraAttr) geo.setAttribute(k, extraAttr[k]);
      const mat = new THREE.ShaderMaterial({
        uniforms: Object.assign(
          { uTime: common.uTime, uHalfH: common.uHalfH, uMaxSize: { value: maxSize }, uIntensity: { value: 1 } },
          uniforms
        ),
        vertexShader: GLSL_COMMON + vertexMain,
        fragmentShader: FRAG_GLOW,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      return pts;
    }

    function canvasTexture(w, h, draw, srgb = true) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      draw(c.getContext('2d'), w, h);
      const t = new THREE.CanvasTexture(c);
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    }

    // Materialien
    const M = {
      steel: new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 1, roughness: 0.32 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x2b3038, metalness: 0.85, roughness: 0.5 }),
      copper: new THREE.MeshStandardMaterial({ color: 0xb36d3d, metalness: 1, roughness: 0.34 }),
    };

    function cylinderBetween(a, b, r, mat) {
      const dir = new THREE.Vector3().subVectors(b, a);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, dir.length(), 12), mat);
      m.position.copy(a).addScaledVector(dir, 0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      return m;
    }
    function tube(points, r, mat, closed = false, seg = 48) {
      const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), closed);
      return new THREE.Mesh(new THREE.TubeGeometry(curve, seg, r, 10, closed), mat);
    }
    function ring(R, r, y, mat) {
      const m = new THREE.Mesh(new THREE.TorusGeometry(R, r, 12, 72), mat);
      m.rotation.x = Math.PI / 2;
      m.position.y = y;
      return m;
    }

    // ======================================================================
    //  Sternenhimmel (global)
    // ======================================================================
    (function buildStars() {
      const N = Math.round(7000 * Q);
      const col = new Float32Array(N * 3);
      const pos = new Float32Array(N * 3);
      const center = new THREE.Vector3(30, -140, -80);
      const band = new THREE.Vector3(0.3, 1, 0.2).normalize(); // Normale der "Milchstraße"
      const v = new THREE.Vector3();
      const tint = [[0.7, 0.8, 1.0], [1.0, 1.0, 1.0], [1.0, 0.92, 0.8], [1.0, 0.78, 0.6]];
      for (let i = 0; i < N; i++) {
        v.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
        if (i % 5 < 2) v.addScaledVector(band, -v.dot(band) * 0.9).normalize();
        v.multiplyScalar(rand(500, 1100)).add(center);
        pos.set([v.x, v.y, v.z], i * 3);
        col.set(tint[(Math.random() * tint.length) | 0], i * 3);
      }
      const stars = makeParticles(
        N,
        (s, o) => { s[o] = rand(0.6, 1.6); s[o + 1] = rand(0, 6.28); s[o + 2] = rand(0.5, 2.5); s[o + 3] = Math.pow(Math.random(), 2.2) * 1.6 + 0.15; },
        /* glsl */ `
          attribute vec3 aColor;
          void main() {
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * mv;
            float tw = 0.75 + 0.25 * sin(uTime * aSeed.z + aSeed.y);
            vColor = aColor * aSeed.w * tw;
            gl_PointSize = max(1.6, pSize(aSeed.x, mv));
          }`,
        {}, 8,
        { aColor: new THREE.BufferAttribute(col, 3) }
      );
      stars.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      scene.add(stars);
    })();

    // ======================================================================
    //  Station 1: Raketentriebwerk
    // ======================================================================
    function buildRocket() {
      const g = new THREE.Group();
      const eng = new THREE.Group();
      eng.rotation.z = 0.38;
      g.add(eng);

      const throatR = 0.55, exitR = 2.3, yThroat = 0.2, yExit = -5.2;
      const bellR = (s) => throatR + (exitR - throatR) * (1 - Math.pow(1 - s, 2.2));
      const rAtY = (y) => bellR(clamp((y - yThroat) / (yExit - yThroat), 0, 1));

      const prof = [];
      for (let k = 0; k <= 8; k++) { const a = (k / 8) * Math.PI / 2; prof.push(new THREE.Vector2(Math.max(0.001, Math.sin(a) * 1.15), 3.3 + Math.cos(a) * 0.55)); }
      prof.push(new THREE.Vector2(1.15, 1.45));
      for (let k = 1; k <= 10; k++) { const s = k / 10; prof.push(new THREE.Vector2(1.15 + (throatR - 1.15) * (0.5 - 0.5 * Math.cos(Math.PI * s)), 1.45 - s * (1.45 - yThroat))); }
      for (let k = 1; k <= 32; k++) { const s = k / 32; prof.push(new THREE.Vector2(bellR(s), yThroat + (yExit - yThroat) * s)); }

      // Glühen der Düsenendkante (strahlungsgekühlte Erweiterung)
      const heat = canvasTexture(4, 256, (ctx, w, h) => {
        for (let y = 0; y < h; y++) {
          const v = 1 - y / (h - 1);
          const f = smooth(0.8, 1.0, v);
          ctx.fillStyle = `rgb(${Math.round(255 * f)},${Math.round(110 * f * f)},${Math.round(30 * f * f * f)})`;
          ctx.fillRect(0, y, w, 1);
        }
      });
      // Kühlkanäle als Bump-Map
      const tubes = canvasTexture(256, 4, (ctx, w, h) => {
        for (let x = 0; x < w; x++) { const s = 0.5 + 0.5 * Math.cos((x / w) * Math.PI * 2 * 64); ctx.fillStyle = `rgb(${s * 255 | 0},${s * 255 | 0},${s * 255 | 0})`; ctx.fillRect(x, 0, 1, h); }
      }, false);
      tubes.wrapS = THREE.RepeatWrapping;
      tubes.repeat.set(3, 1);

      // Anlauffarben entlang der Düse (v = 0 Dom … 1 Austritt)
      const tint = canvasTexture(4, 512, (ctx, w, h) => {
        const gr = ctx.createLinearGradient(0, h, 0, 0); // v=0 unten im Bild (flipY)
        const stops = [[0, '#b8703f'], [0.3, '#b26a3c'], [0.36, '#a8683e'], [0.4, '#c9a25a'], [0.45, '#8a5a8f'],
          [0.5, '#4a5f9c'], [0.58, '#5a6068'], [0.8, '#44464b'], [0.95, '#2f2b29'], [1, '#2a2522']];
        stops.forEach(([o, c]) => gr.addColorStop(o, c));
        ctx.fillStyle = gr; ctx.fillRect(0, 0, w, h);
      });
      const nozzleMat = new THREE.MeshStandardMaterial({
        color: 0xffffff, map: tint, metalness: 0.88, roughness: 0.38,
        emissive: 0xffffff, emissiveMap: heat, emissiveIntensity: 1.6,
        bumpMap: tubes, bumpScale: 1.5, side: THREE.DoubleSide,
      });
      eng.add(new THREE.Mesh(new THREE.LatheGeometry(prof, 96), nozzleMat));

      // Heißgas im Inneren der Glocke
      const inner = [];
      for (let k = 0; k <= 32; k++) { const s = k / 32; inner.push(new THREE.Vector2(bellR(s) * 0.965, yThroat + (yExit - yThroat) * s)); }
      const innerTex = canvasTexture(4, 128, (ctx, w, h) => {
        const gr = ctx.createLinearGradient(0, h, 0, 0); // v=0 (Hals) unten
        gr.addColorStop(0, '#fff3e0'); gr.addColorStop(0.35, '#ffb070'); gr.addColorStop(1, '#a83c10');
        ctx.fillStyle = gr; ctx.fillRect(0, 0, w, h);
      });
      const innerMat = new THREE.MeshBasicMaterial({ map: innerTex, side: THREE.BackSide });
      innerMat.color.setRGB(2.2, 2.0, 1.9);
      eng.add(new THREE.Mesh(new THREE.LatheGeometry(inner, 64), innerMat));

      // Peripherie: Ringe, Turbopumpen, Leitungen, Kardanrahmen
      eng.add(ring(1.2, 0.09, 3.0, M.copper), ring(1.2, 0.08, 1.6, M.copper));
      eng.add(ring(rAtY(-1.6) + 0.06, 0.08, -1.6, M.dark), ring(rAtY(-3.6) + 0.06, 0.07, -3.6, M.dark));
      for (const sgn of [1, -1]) {
        const px = 1.95 * sgn, pz = 0.5 * sgn;
        const pump = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.7, 32), M.steel);
        pump.position.set(px, 2.4, pz); eng.add(pump);
        const dome = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), M.steel);
        dome.position.set(px, 3.25, pz); eng.add(dome);
        eng.add(tube([[px, 1.55, pz], [px * 0.85, 1.2, pz * 0.8], [px * 0.62, 1.55, pz * 0.4]], 0.12, M.steel));
        eng.add(tube([[px, 3.7, pz], [px * 0.8, 4.8, pz * 0.8], [px * 0.3, 5.6, pz * 0.4]], 0.14, M.steel));
        eng.add(tube([[px, 1.6, pz], [px * 1.25, 0.2, pz * 1.2], [px * 1.4, -1.6, pz * 1.5]], 0.16, M.dark));
      }
      const gimbal = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.5, 1.0), M.dark);
      gimbal.position.y = 4.1; eng.add(gimbal);
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        eng.add(cylinderBetween(new THREE.Vector3(0.9 * sx, 3.5, 0.9 * sz), new THREE.Vector3(0.25 * sx, 6.3, 0.25 * sz), 0.07, M.steel));
      }

      // Abgasstrahl als Volumen (Ray-Marching im Shader):
      //   Überschallkern (bläulich, Methan/Sauerstoff), Mach-Scheiben und schräge
      //   Stoßfronten im Zellabstand, turbulente Mischschicht mit Nachverbrennung.
      const PH = 30, PR = 5.6, STEPS = lowPower ? 18 : 30;
      const plumeGeo = new THREE.CylinderGeometry(PR, PR, PH, 48, 1, true);
      plumeGeo.translate(0, -PH / 2, 0);
      const plumeMat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: common.uTime, uCam: { value: new THREE.Vector3() }, uThrottle: { value: 1 },
          uExitR: { value: exitR * 0.94 }, uCell: { value: 3.1 }, uI: { value: 0.33 },
        },
        vertexShader: /* glsl */ `
          varying vec3 vObj;
          void main() { vObj = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: NOISE_GLSL + /* glsl */ `
          uniform vec3 uCam; uniform float uTime, uThrottle, uExitR, uCell, uI;
          varying vec3 vObj;
          float fbm2(vec3 p) { return 0.6 * vnoise(p) + 0.4 * vnoise(p * 2.13 + 5.1); }
          float jetR(float d) {
            float cells = d / uCell;
            float pinch = 1.0 - 0.2 * (0.5 - 0.5 * cos(6.2831853 * cells)) * exp(-cells * 0.3);
            return uExitR * pinch * (1.0 + 0.03 * d) + 0.004 * d * d;
          }
          void main() {
            vec3 rd = normalize(vObj - uCam);
            vec3 p0 = vObj;
            float a = dot(rd.xz, rd.xz), b = dot(p0.xz, rd.xz), c = dot(p0.xz, p0.xz) - ${PR.toFixed(2)} * ${PR.toFixed(2)};
            float tEx = (-b + sqrt(max(b * b - a * c, 0.0))) / max(a, 1e-4);
            if (rd.y < -1e-4) tEx = min(tEx, (-${PH.toFixed(1)} - p0.y) / rd.y);
            else if (rd.y > 1e-4) tEx = min(tEx, -p0.y / rd.y);
            tEx = clamp(tEx, 0.0, 60.0);
            float dt = tEx / float(${STEPS});
            float jit = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
            float stretch = mix(1.5, 1.0, uThrottle);
            vec3 col = vec3(0.0);
            for (int i = 0; i < ${STEPS}; i++) {
              vec3 p = p0 + rd * (float(i) + jit) * dt;
              float d = -p.y * stretch;
              float rj = jetR(d);
              float q = length(p.xz) / rj;
              if (q > 1.6) continue;
              float cells = d / uCell, f = fract(cells);
              float core = exp(-q * q * 2.5) * exp(-d * 0.09);
              float disk = exp(-pow((f - 0.5) * 7.0, 2.0)) * exp(-q * q * 6.0) * exp(-cells * 0.45);
              float oblique = exp(-pow((q - abs(1.0 - 2.0 * f) * 0.95) * 6.0, 2.0)) * exp(-cells * 0.5) * 0.35;
              float n = fbm2(vec3(p.x * 0.55, (p.y + uTime * 22.0) * 0.18, p.z * 0.55));
              float shell = smoothstep(1.45, 0.75, q) * smoothstep(0.3, 0.95, q + n * 0.5)
                          * smoothstep(3.0, 12.0, d) * exp(-d * 0.05) * n * n * 1.8;
              col += (vec3(0.3, 0.42, 1.0) * core * 1.7
                    + vec3(1.0, 0.72, 0.9) * (disk * 2.6 + oblique)
                    + vec3(1.0, 0.45, 0.16) * shell * 0.4) * dt;
            }
            gl_FragColor = vec4(col * uI * uThrottle, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const plume = new THREE.Mesh(plumeGeo, plumeMat);
      plume.position.y = yExit;
      plume.frustumCulled = false;
      eng.add(plume);
      const camLocal = new THREE.Vector3();

      const lightLocal = new THREE.Vector3(0, yExit - 0.6, 0);
      let throttle = 1;
      return {
        group: g, key: 1,
        light: { color: new THREE.Color(0xff8a3d), intensity: 70, pos: new THREE.Vector3() },
        update(dt, p, t) {
          throttle = p;
          plumeMat.uniforms.uThrottle.value = p;
          plume.updateMatrixWorld();
          plumeMat.uniforms.uCam.value.copy(plume.worldToLocal(camLocal.copy(camera.position)));
          eng.rotation.x = Math.sin(t * 0.7) * 0.035;
          eng.rotation.y = t * 0.05;
          this.light.intensity = 70 * p * (0.85 + 0.15 * Math.sin(t * 37) * Math.sin(t * 23));
          this.light.pos.copy(lightLocal);
          eng.localToWorld(this.light.pos);
        },
        hud() {
          const th = Math.round(throttle * 100);
          return lang === 'en'
            ? ['Rocket engine · exhaust plume with Mach diamonds', `Throttle ${th} % · expansion ratio ε = 17.5`]
            : ['Raketentriebwerk · Abgasstrahl mit Mach-Diamanten', `Schubniveau ${th} % · Expansionsverhältnis ε = 17,5`];
        },
      };
    }

    // ======================================================================
    //  Station 2: Potentialströmung um ein Joukowski-Profil
    //  Exakte Lösung: Zylinderumströmung mit Zirkulation (Kutta-Bedingung),
    //  konform abgebildet mit z = ζ + c²/ζ. Partikel werden im ζ-Raum
    //  integriert (RK2) und in den z-Raum abgebildet.
    // ======================================================================
    function buildAirfoil() {
      const g = new THREE.Group();
      const S = 2.2;
      const wing = new THREE.Group();
      wing.scale.setScalar(S);
      g.add(wing);

      // <joukowski>
      const c2 = 1, z0x = -0.09, z0y = 0.06, U = 1;
      const R = Math.hypot(1 - z0x, z0y), R2 = R * R;
      const thTE = Math.atan2(-z0y, 1 - z0x);
      let alpha = 0, ca = 1, sa = 0, Gam = 0;
      function setAlpha(a) { alpha = a; ca = Math.cos(a); sa = Math.sin(a); Gam = 4 * Math.PI * U * R * Math.sin(a - thTE); }

      // dζ/dt und Betrag der physikalischen Geschwindigkeit im Punkt ζ
      function flow(sx, sy, out) {
        const px = sx - z0x, py = sy - z0y;
        const p2x = px * px - py * py, p2y = 2 * px * py, d2 = p2x * p2x + p2y * p2y;
        const ax = R2 * ca, ay = R2 * sa;
        const qx = (ax * p2x + ay * p2y) / d2, qy = (ay * p2x - ax * p2y) / d2;
        const m = px * px + py * py, gg = Gam / (2 * Math.PI);
        const Wx = U * (ca - qx) + gg * py / m, Wy = U * (-sa - qy) + gg * px / m;
        const s2x = sx * sx - sy * sy, s2y = 2 * sx * sy, sd = s2x * s2x + s2y * s2y;
        let fx = 1 - c2 * s2x / sd, fy = c2 * s2y / sd, fm = fx * fx + fy * fy;
        if (fm < 0.0025) { const k = 0.05 / Math.sqrt(fm + 1e-12); fx *= k; fy *= k; fm = 0.0025; }
        const u = (Wx * fx + Wy * fy) / fm, v = -(Wy * fx - Wx * fy) / fm;
        out[0] = (u * fx + v * fy) / fm;
        out[1] = (v * fx - u * fy) / fm;
        out[2] = Math.hypot(u, v);
      }
      function J(sx, sy, out) { const m = sx * sx + sy * sy; out[0] = sx + c2 * sx / m; out[1] = sy - c2 * sy / m; }
      // Umkehrung: Wurzel außerhalb des Kreises; gibt |ζ-ζ0|² zurück
      function invJ(zx, zy, out) {
        const ax = zx * zx - zy * zy - 4 * c2, ay = 2 * zx * zy, m = Math.hypot(ax, ay);
        const rx = Math.sqrt(Math.max(0, (m + ax) / 2)), ry = (ay < 0 ? -1 : 1) * Math.sqrt(Math.max(0, (m - ax) / 2));
        const ax1 = (zx + rx) / 2, ay1 = (zy + ry) / 2, ax2 = (zx - rx) / 2, ay2 = (zy - ry) / 2;
        const d1 = (ax1 - z0x) ** 2 + (ay1 - z0y) ** 2, d2 = (ax2 - z0x) ** 2 + (ay2 - z0y) ** 2;
        if (d1 >= d2) { out[0] = ax1; out[1] = ay1; return d1; }
        out[0] = ax2; out[1] = ay2; return d2;
      }
      // </joukowski>

      setAlpha(THREE.MathUtils.degToRad(4));
      const tmp = [0, 0, 0], tz = [0, 0];

      // Farbskala nach Geschwindigkeit |v|/U (schnell = warm = Unterdruck)
      const stops = [[0, 0.05, 0.12, 0.55], [0.8, 0.1, 0.5, 1.0], [1.0, 0.5, 0.82, 1.0], [1.3, 1.0, 0.85, 0.5], [1.7, 1.0, 0.45, 0.1], [2.2, 1.0, 0.15, 0.05]];
      function speedColor(s, out, o, f) {
        let k = 0;
        while (k < stops.length - 2 && s > stops[k + 1][0]) k++;
        const a = stops[k], b = stops[k + 1], t = clamp((s - a[0]) / (b[0] - a[0]), 0, 1);
        out[o] = lerp(a[1], b[1], t) * f; out[o + 1] = lerp(a[2], b[2], t) * f; out[o + 2] = lerp(a[3], b[3], t) * f;
      }

      // Profilkontur und Flügel
      const SPAN = 4.6;
      const outline = [];
      let xmin = Infinity, xmax = -Infinity;
      for (let k = 0; k < 240; k++) {
        const th = thTE + (k / 240) * Math.PI * 2;
        J(z0x + R * Math.cos(th), z0y + R * Math.sin(th), tz);
        outline.push(new THREE.Vector2(tz[0], tz[1]));
        xmin = Math.min(xmin, tz[0]); xmax = Math.max(xmax, tz[0]);
      }
      const chord = xmax - xmin;
      const wingGeo = new THREE.ExtrudeGeometry(new THREE.Shape(outline), { depth: SPAN, bevelEnabled: false, steps: 1 });
      wingGeo.translate(0, 0, -SPAN / 2);
      const wpos = wingGeo.attributes.position;
      const wcol = new Float32Array(wpos.count * 3);
      wingGeo.setAttribute('color', new THREE.BufferAttribute(wcol, 3));
      const side = wingGeo.groups[1] || { start: 0, count: wpos.count };
      const wz = new Float32Array(wpos.count * 2);
      for (let i = side.start; i < side.start + side.count; i++) { invJ(wpos.getX(i), wpos.getY(i), tz); wz[i * 2] = tz[0]; wz[i * 2 + 1] = tz[1]; }
      function colorWing() {
        for (let i = side.start; i < side.start + side.count; i++) { flow(wz[i * 2], wz[i * 2 + 1], tmp); speedColor(tmp[2], wcol, i * 3, 1); }
        wingGeo.attributes.color.needsUpdate = true;
      }
      colorWing();
      const capMat = new THREE.MeshStandardMaterial({ color: 0x1f242c, metalness: 0.8, roughness: 0.4 });
      const sideMat = new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: 0.15, roughness: 0.4, clearcoat: 0.8, clearcoatRoughness: 0.2 });
      wing.add(new THREE.Mesh(wingGeo, [capMat, sideMat]));

      // Rechengitter im Hintergrund
      const grid = new THREE.GridHelper(30, 30, 0x2a6f9a, 0x173247);
      grid.rotation.x = Math.PI / 2;
      grid.position.z = -SPAN * S / 2 - 2.5;
      grid.material.transparent = true; grid.material.opacity = 0.35; grid.material.depthWrite = false;
      g.add(grid);

      // Partikel mit Spurhistorie
      const N = Math.round(3000 * Q), H = 10;
      const X0 = 6, Y0 = 3.2;
      const sx = new Float32Array(N), sy = new Float32Array(N), zs = new Float32Array(N), age = new Float32Array(N), sp = new Float32Array(N);
      const hist = new Float32Array(N * H * 3);
      let hp = 0, sampleAcc = 0;

      function spawn(i, anywhere) {
        for (let tries = 0; tries < 30; tries++) {
          const X = anywhere ? rand(-X0, X0) : -X0 - Math.random() * 0.4, Y = rand(-Y0, Y0);
          const d = invJ(X * ca - Y * sa, X * sa + Y * ca, tz);
          if (d > R2 * 1.002) break;
        }
        sx[i] = tz[0]; sy[i] = tz[1]; zs[i] = rand(-SPAN / 2, SPAN / 2); age[i] = 0;
        flow(sx[i], sy[i], tmp); sp[i] = tmp[2];
        J(sx[i], sy[i], tz);
        for (let k = 0; k < H; k++) { const o = (i * H + k) * 3; hist[o] = tz[0]; hist[o + 1] = tz[1]; hist[o + 2] = sp[i]; }
      }
      function step(i, h) {
        flow(sx[i], sy[i], tmp);
        let kx = tmp[0], ky = tmp[1];
        const lim = 0.15 / Math.max(1e-6, Math.hypot(kx, ky) * h);
        if (lim < 1) { kx *= lim; ky *= lim; }
        flow(sx[i] + kx * h * 0.5, sy[i] + ky * h * 0.5, tmp);
        let vx = tmp[0], vy = tmp[1];
        const lim2 = 0.15 / Math.max(1e-6, Math.hypot(vx, vy) * h);
        if (lim2 < 1) { vx *= lim2; vy *= lim2; }
        sx[i] += vx * h; sy[i] += vy * h; sp[i] = tmp[2]; age[i] += h;
        const dx = sx[i] - z0x, dy = sy[i] - z0y, dd = Math.hypot(dx, dy);
        if (dd < R * 1.001) { sx[i] = z0x + dx / dd * R * 1.001; sy[i] = z0y + dy / dd * R * 1.001; }
      }

      const lpos = new Float32Array(N * H * 2 * 3), lcol = new Float32Array(N * H * 2 * 3);
      const lgeo = new THREE.BufferGeometry();
      lgeo.setAttribute('position', new THREE.BufferAttribute(lpos, 3).setUsage(THREE.DynamicDrawUsage));
      lgeo.setAttribute('color', new THREE.BufferAttribute(lcol, 3).setUsage(THREE.DynamicDrawUsage));
      const lines = new THREE.LineSegments(lgeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      lines.frustumCulled = false;
      wing.add(lines);

      for (let i = 0; i < N; i++) spawn(i, true);
      // Vorlauf, damit Spuren schon beim ersten Bild existieren
      for (let n = 0; n < 12; n++) advance(0.045);

      function advance(h) {
        for (let i = 0; i < N; i++) {
          step(i, h);
          J(sx[i], sy[i], tz);
          const X = tz[0] * ca + tz[1] * sa, Y = -tz[0] * sa + tz[1] * ca;
          if (X > X0 || Math.abs(Y) > Y0 + 0.6 || age[i] > 40) spawn(i, false);
        }
        sampleAcc += h;
        if (sampleAcc >= 0.045) {
          sampleAcc = 0;
          hp = (hp + 1) % H;
          for (let i = 0; i < N; i++) { J(sx[i], sy[i], tz); const o = (i * H + hp) * 3; hist[o] = tz[0]; hist[o + 1] = tz[1]; hist[o + 2] = sp[i]; }
        }
      }
      function buildLines() {
        let v = 0;
        for (let i = 0; i < N; i++) {
          J(sx[i], sy[i], tz);
          let px = tz[0], py = tz[1], ps = sp[i];
          const z = zs[i];
          for (let k = 0; k < H; k++) {
            const o = (i * H + ((hp - k + H) % H)) * 3;
            const f0 = (1 - k / H) ** 2 * 0.95, f1 = (1 - (k + 1) / H) ** 2 * 0.95;
            lpos[v * 3] = px; lpos[v * 3 + 1] = py; lpos[v * 3 + 2] = z; speedColor(ps, lcol, v * 3, f0); v++;
            px = hist[o]; py = hist[o + 1]; ps = hist[o + 2];
            lpos[v * 3] = px; lpos[v * 3 + 1] = py; lpos[v * 3 + 2] = z; speedColor(ps, lcol, v * 3, f1); v++;
          }
        }
        lgeo.attributes.position.needsUpdate = true;
        lgeo.attributes.color.needsUpdate = true;
      }
      buildLines();

      let lastColored = alpha;
      return {
        group: g, key: 1,
        light: { color: new THREE.Color(0x7fc8ff), intensity: 0, pos: new THREE.Vector3() },
        update(dt, pDeg) {
          setAlpha(THREE.MathUtils.degToRad(pDeg));
          wing.rotation.z = -alpha;
          if (Math.abs(alpha - lastColored) > 0.002) { colorWing(); lastColored = alpha; }
          let h = dt * 1.5;
          while (h > 1e-5) { const s = Math.min(h, 0.03); advance(s); h -= s; }
          buildLines();
        },
        hud() {
          const a = THREE.MathUtils.radToDeg(alpha).toFixed(1), cl = (2 * Gam / (U * chord)).toFixed(2);
          return lang === 'en'
            ? ['Potential flow around a Joukowski airfoil', `Angle of attack α = ${a}° · lift coefficient c_L = ${cl}`]
            : ['Potentialströmung um ein Joukowski-Profil', `Anstellwinkel α = ${a.replace('.', ',')}° · Auftriebsbeiwert c_L = ${cl.replace('.', ',')}`];
        },
      };
    }

    // ======================================================================
    //  Station: Erde mit Satellit (Raumfahrt & Weltraumnutzung)
    //  Prozedurale Erde (Kontinente, Eis, Ozean-Glanz, Stadtlichter, Wolken,
    //  Atmosphäre). Umlaufzeit des Satelliten nach Kepler aus der Bahnhöhe.
    // ======================================================================
    const NOISE_GLSL = /* glsl */ `
      float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float vnoise(vec3 x) {
        vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash3(i), hash3(i + vec3(1.0, 0.0, 0.0)), f.x),
                       mix(hash3(i + vec3(0.0, 1.0, 0.0)), hash3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
                   mix(mix(hash3(i + vec3(0.0, 0.0, 1.0)), hash3(i + vec3(1.0, 0.0, 1.0)), f.x),
                       mix(hash3(i + vec3(0.0, 1.0, 1.0)), hash3(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
      }
      float fbm(vec3 p) {
        float a = 0.5, s = 0.0;
        for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
        return s;
      }
    `;
    const SPHERE_VS = /* glsl */ `
      varying vec3 vP; varying vec3 vWN; varying vec3 vWPos; varying vec2 vUv;
      void main() {
        vP = normalize(position);
        vUv = uv;
        vWN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`;

    function buildEarth() {
      const g = new THREE.Group();
      const RE = 6;
      const sunDir = new THREE.Vector3(-0.75, 0.25, 0.6).normalize();

      // NASA Blue Marble (Tag), Black Marble (Nacht), Wassermaske – aus dem npm-Paket three-globe.
      // Wenn sie nicht laden (offline), bleibt die prozedurale Erde aktiv.
      const TEX = 'https://cdn.jsdelivr.net/npm/three-globe@2/example/img/';
      const earthU = {
        uSun: { value: sunDir }, uUseTex: { value: 0 },
        uDay: { value: null }, uNight: { value: null }, uWater: { value: null },
      };
      const loader = new THREE.TextureLoader();
      loader.setCrossOrigin('anonymous');
      const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      Promise.all(['earth-blue-marble.jpg', 'earth-night.jpg', 'earth-water.png'].map((f) => loader.loadAsync(TEX + f)))
        .then(([day, night, water]) => {
          day.colorSpace = night.colorSpace = THREE.SRGBColorSpace;
          [day, night, water].forEach((t) => { t.anisotropy = aniso; });
          earthU.uDay.value = day; earthU.uNight.value = night; earthU.uWater.value = water;
          earthU.uUseTex.value = 1;
        })
        .catch((e) => console.info('Erdtexturen nicht geladen, prozedurale Erde aktiv.', e));

      const earthMat = new THREE.ShaderMaterial({
        uniforms: earthU,
        vertexShader: SPHERE_VS,
        fragmentShader: NOISE_GLSL + /* glsl */ `
          uniform vec3 uSun; uniform float uUseTex;
          uniform sampler2D uDay, uNight, uWater;
          varying vec3 vP; varying vec3 vWN; varying vec3 vWPos; varying vec2 vUv;
          void main() {
            vec3 N = normalize(vWN);
            vec3 V = normalize(cameraPosition - vWPos);
            float ndl = dot(N, uSun);
            vec3 dayCol, nightCol; float water;
            if (uUseTex > 0.5) {
              dayCol = texture2D(uDay, vUv).rgb;
              nightCol = texture2D(uNight, vUv).rgb;
              nightCol = max(nightCol - 0.02, 0.0) * 1.6;          // dunkles Land unterdrücken, Lichter betonen
              water = texture2D(uWater, vUv).r;
            } else {
              vec3 p = vP;
              float n = fbm(p * 1.6 + vec3(3.1, 1.7, 0.4));
              float lat = abs(p.y);
              float land = smoothstep(0.5, 0.53, n);
              float ice = smoothstep(0.8, 0.88, lat + 0.08 * (n - 0.5));
              float dry = smoothstep(0.45, 0.7, fbm(p * 4.0 + 7.0)) * (1.0 - smoothstep(0.1, 0.35, abs(lat - 0.3)));
              vec3 ocean = mix(vec3(0.004, 0.02, 0.07), vec3(0.01, 0.06, 0.14), smoothstep(0.3, 0.5, n));
              vec3 green = mix(vec3(0.03, 0.09, 0.03), vec3(0.11, 0.13, 0.05), fbm(p * 9.0));
              dayCol = mix(mix(ocean, mix(green, vec3(0.35, 0.27, 0.15), dry), land), vec3(0.8, 0.85, 0.9), ice);
              float city = smoothstep(0.66, 0.85, vnoise(p * 70.0)) * smoothstep(0.45, 0.65, fbm(p * 5.0 + 2.0)) * land * (1.0 - ice);
              nightCol = vec3(1.0, 0.68, 0.32) * city;
              water = 1.0 - land;
            }
            float day = smoothstep(-0.08, 0.22, ndl);
            vec3 c = dayCol * max(ndl, 0.0) * 1.75;
            // Sonnenreflex auf dem Ozean (Glanzpunkt mit Fresnel)
            vec3 H = normalize(uSun + V);
            float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
            c += vec3(1.0, 0.9, 0.75) * (pow(max(dot(N, H), 0.0), 60.0) * 1.1 + fres * 0.25 * max(ndl, 0.0)) * water;
            // Stadtlichter auf der Nachtseite
            c += nightCol * 1.2 * (1.0 - day);
            // Dämmerungszone: Licht wird rötlich
            float tw = exp(-pow(ndl / 0.14, 2.0));
            c *= mix(vec3(1.0), vec3(1.25, 0.72, 0.5), tw * 0.6);
            // Streulicht der Atmosphäre auf der Scheibe, zum Rand hin stärker
            float rim = pow(1.0 - max(dot(N, V), 0.0), 2.4);
            vec3 sky = mix(vec3(1.0, 0.5, 0.25), vec3(0.32, 0.58, 1.0), smoothstep(-0.05, 0.35, ndl));
            c = mix(c, sky * max(ndl + 0.15, 0.0) * 1.1, rim * 0.6) + vec3(0.04, 0.09, 0.2) * max(ndl, 0.0) * 0.5;
            gl_FragColor = vec4(c, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      });
      const tilt = new THREE.Group();
      tilt.rotation.z = 0.41; // Achsneigung 23,4°
      g.add(tilt);
      const earth = new THREE.Mesh(new THREE.SphereGeometry(RE, 160, 80), earthMat);
      tilt.add(earth);

      // Wolken: verwirbeltes fbm (Domain Warping), mehr Wolken am Äquator und
      // in mittleren Breiten, weniger in den Subtropen
      const cloudMat = new THREE.ShaderMaterial({
        uniforms: { uSun: { value: sunDir }, uTime: common.uTime },
        vertexShader: SPHERE_VS,
        fragmentShader: NOISE_GLSL + /* glsl */ `
          uniform vec3 uSun; uniform float uTime;
          varying vec3 vP; varying vec3 vWN; varying vec3 vWPos; varying vec2 vUv;
          void main() {
            vec3 p = vP;
            vec3 q = p * 2.3;
            vec3 w = vec3(fbm(q + vec3(0.0, uTime * 0.01, 0.0)), fbm(q + vec3(5.2, 1.3, 2.8)), fbm(q + vec3(1.7, 9.2, 0.3)));
            float c = fbm(q * 1.4 + w * 1.7 + vec3(uTime * 0.006, 0.0, 0.0));
            float lat = abs(p.y);
            float band = 0.9 + 0.22 * exp(-pow(lat / 0.12, 2.0)) + 0.18 * exp(-pow((lat - 0.75) / 0.15, 2.0))
                       - 0.22 * exp(-pow((lat - 0.42) / 0.12, 2.0));
            float a = smoothstep(0.5, 0.74, c * band) * 0.92;
            float ndl = dot(normalize(vWN), uSun);
            float tw = exp(-pow(ndl / 0.15, 2.0));
            vec3 col = vec3(1.0) * (max(ndl, 0.0) * 1.6 + 0.008);
            col *= mix(vec3(1.0), vec3(1.3, 0.7, 0.45), tw * 0.6);
            gl_FragColor = vec4(col, a);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
        transparent: true, depthWrite: false,
      });
      const clouds = new THREE.Mesh(new THREE.SphereGeometry(RE * 1.01, 128, 64), cloudMat);
      tilt.add(clouds);

      // Atmosphärensaum außerhalb der Scheibe; an der Tag-Nacht-Grenze rötlich
      const atmo = new THREE.Mesh(
        new THREE.SphereGeometry(RE * 1.06, 96, 48),
        new THREE.ShaderMaterial({
          uniforms: { uSun: { value: sunDir } },
          vertexShader: SPHERE_VS,
          fragmentShader: /* glsl */ `
            uniform vec3 uSun;
            varying vec3 vP; varying vec3 vWN; varying vec3 vWPos; varying vec2 vUv;
            void main() {
              vec3 N = normalize(vWN);
              vec3 V = normalize(cameraPosition - vWPos);
              float f = clamp(-dot(N, V) / 0.34, 0.0, 1.0);
              f = pow(f, 1.6) * (1.0 - smoothstep(0.8, 1.0, f) * 0.75);
              float s = dot(N, uSun);
              vec3 col = mix(vec3(1.0, 0.5, 0.25), vec3(0.3, 0.6, 1.0), smoothstep(-0.15, 0.35, s));
              gl_FragColor = vec4(col * f * smoothstep(-0.4, 0.3, s) * 1.5, 1.0);
              #include <tonemapping_fragment>
              #include <colorspace_fragment>
            }`,
          side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        })
      );
      g.add(atmo);

      // ---------- Satellit: Bus mit Thermalfolie (MLI), Solarflügel, Antenne ----------
      const sat = new THREE.Group();
      const crinkle = canvasTexture(256, 256, (ctx, w, h) => {
        ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, w, h);
        for (let i = 0; i < 900; i++) {
          const v = 90 + Math.random() * 90;
          ctx.strokeStyle = `rgb(${v},${v},${v})`; ctx.lineWidth = 1 + Math.random() * 2;
          ctx.beginPath(); const x = Math.random() * w, y = Math.random() * h;
          ctx.moveTo(x, y); ctx.lineTo(x + rand(-30, 30), y + rand(-30, 30)); ctx.stroke();
        }
      }, false);
      const mli = new THREE.MeshStandardMaterial({ color: 0xd8a640, metalness: 1, roughness: 0.28, bumpMap: crinkle, bumpScale: 3 });
      const cells = canvasTexture(512, 256, (ctx, w, h) => {
        ctx.fillStyle = '#c9ccd2'; ctx.fillRect(0, 0, w, h);
        const nx = 16, ny = 8, gx = w / nx, gy = h / ny;
        for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
          const gr = ctx.createLinearGradient(i * gx, j * gy, (i + 1) * gx, (j + 1) * gy);
          gr.addColorStop(0, '#16224f'); gr.addColorStop(1, '#1d2d66');
          ctx.fillStyle = gr; ctx.fillRect(i * gx + 2, j * gy + 2, gx - 4, gy - 4);
          ctx.strokeStyle = 'rgba(200,205,215,0.35)'; ctx.lineWidth = 1;
          for (let k = 1; k < 4; k++) { ctx.beginPath(); ctx.moveTo(i * gx + 2, j * gy + (k * gy) / 4); ctx.lineTo((i + 1) * gx - 2, j * gy + (k * gy) / 4); ctx.stroke(); }
        }
      });
      const panelMat = new THREE.MeshStandardMaterial({ map: cells, metalness: 0.55, roughness: 0.22 });
      const panelBack = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, metalness: 0.2, roughness: 0.6 });
      sat.add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 1.0), mli));
      const deck = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.06, 1.06), M.steel);
      deck.position.y = 0.33; sat.add(deck);
      for (const s of [1, -1]) {
        sat.add(cylinderBetween(new THREE.Vector3(0.3 * s, 0, 0), new THREE.Vector3(0.75 * s, 0, 0), 0.025, M.steel));
        for (let k = 0; k < 3; k++) {
          const panel = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.025, 0.72), [panelBack, panelBack, panelMat, panelBack, panelBack, panelBack]);
          panel.position.x = s * (1.25 + k * 0.94);
          sat.add(panel);
        }
      }
      const dish = new THREE.Mesh(new THREE.SphereGeometry(0.34, 32, 12, 0, Math.PI * 2, 0, Math.PI / 3.2), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.5, side: THREE.DoubleSide }));
      dish.rotation.x = -Math.PI / 2;
      dish.position.z = 0.78;
      sat.add(dish, cylinderBetween(new THREE.Vector3(0, 0, 0.5), new THREE.Vector3(0, 0, 0.75), 0.03, M.steel));
      const tracker = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.22, 16), M.dark);
      tracker.position.set(0.18, 0.45, -0.3); sat.add(tracker);
      sat.scale.setScalar(0.4);

      const plane = new THREE.Group();
      plane.rotation.set(0, 0.5, THREE.MathUtils.degToRad(51.6)); // Inklination wie die ISS
      plane.add(sat);
      const circ = [];
      for (let k = 0; k <= 180; k++) { const a = (k / 180) * Math.PI * 2; circ.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a))); }
      const orbitLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(circ),
        new THREE.LineBasicMaterial({ color: 0x6fb8ff, transparent: true, opacity: 0.25, depthWrite: false })
      );
      plane.add(orbitLine);
      g.add(plane);

      const MU = 398600.4418, R_EARTH = 6371, LAPSE = 240;
      let h = 420, period = 92.6, theta = 0.6;
      const center = new THREE.Vector3(), up = new THREE.Vector3();
      return {
        group: g, key: 0.15,
        light: { color: new THREE.Color(0xfff4e6), intensity: 22000, pos: new THREE.Vector3() },
        update(dt, p, t) {
          h = p;
          const a = R_EARTH + h;
          period = (2 * Math.PI * Math.sqrt((a * a * a) / MU)) / 60; // Minuten
          theta += (dt * 2 * Math.PI) / ((period * 60) / LAPSE);
          const r = RE * (1 + (4 * h) / R_EARTH); // Bahnhöhe 4-fach überhöht dargestellt
          orbitLine.scale.setScalar(r);
          sat.position.set(r * Math.cos(theta), 0, r * Math.sin(theta));
          g.getWorldPosition(center);
          // Antenne zur Erde, Solarflügel quer zur Flugrichtung
          up.set(-Math.sin(theta), 0, Math.cos(theta)).applyQuaternion(plane.quaternion);
          sat.up.copy(up);
          sat.lookAt(center);
          earth.rotation.y += (dt * 2 * Math.PI) / (86164 / LAPSE) ;  // Erdrotation im selben Zeitraffer
          clouds.rotation.y = earth.rotation.y * 1.04;
          this.light.pos.copy(sunDir).multiplyScalar(80).add(g.position);
        },
        hud() {
          const hh = Math.round(h), T = period.toFixed(1);
          return lang === 'en'
            ? ['Earth orbit · satellite at 51.6° inclination', `Altitude ${hh} km · orbital period ${T} min · time-lapse ${LAPSE}×`]
            : ['Erdorbit · Satellit mit 51,6° Bahnneigung', `Bahnhöhe ${hh} km · Umlaufzeit ${T.replace('.', ',')} min · Zeitraffer ${LAPSE}×`];
        },
      };
    }

    // ======================================================================
    //  Station: Emissionsspektroskopie einer Methanflamme
    //  Flammenleuchten → Lichtleiter → Beugungsgitter → Detektor.
    //  Darüber das Live-Spektrum (Chemilumineszenz OH*, CH*, C2*); mit
    //  steigendem Äquivalenzverhältnis φ verschieben sich die Banden.
    // ======================================================================
    function textSprite(text, height, color = '#e6ebf5') {
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d');
      const font = '600 64px Inter, system-ui, sans-serif';
      ctx.font = font;
      const w = Math.ceil(ctx.measureText(text).width) + 24;
      c.width = w; c.height = 88;
      ctx.font = font; ctx.fillStyle = color; ctx.textBaseline = 'middle';
      ctx.fillText(text, 12, 46);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
      m.color.setScalar(0.72); // unter der Bloom-Schwelle, bleibt scharf
      const s = new THREE.Sprite(m);
      s.scale.set((height * w) / 88, height, 1);
      return s;
    }

    function buildSpectro() {
      const g = new THREE.Group();
      const L0 = 290, L1 = 600, X0 = -8, X1 = 10, ZD = -8, Y0 = 0.45, HP = 5.2;
      const GR = new THREE.Vector3(-3, 0, 6), SRC = new THREE.Vector3(-15, 0, 6);
      const xOf = (l) => X0 + ((l - L0) / (L1 - L0)) * (X1 - X0);

      function wlColor(l, out, o, f) {
        let r = 0, gg = 0, b = 0;
        if (l < 380) { r = 0.35; b = 0.6; }
        else if (l < 440) { r = -(l - 440) / 60; b = 1; }
        else if (l < 490) { gg = (l - 440) / 50; b = 1; }
        else if (l < 510) { gg = 1; b = -(l - 510) / 20; }
        else if (l < 580) { r = (l - 510) / 70; gg = 1; }
        else if (l < 645) { r = 1; gg = -(l - 645) / 65; }
        else r = 1;
        const k = (l < 380 ? 0.5 : l < 420 ? 0.3 + (0.7 * (l - 380)) / 40 : 1) * f;
        out[o] = r * k; out[o + 1] = gg * k; out[o + 2] = b * k;
      }

      // Banden: [Zentrum nm, Breite σ nm, Spezies, Gewicht]
      const bands = [
        [306.4, 1.3, 0, 0.55], [309.0, 2.2, 0, 1.0], [314.5, 4.5, 0, 0.25],   // OH*  A–X
        [387.1, 1.6, 1, 0.18], [431.4, 1.8, 1, 1.0],                          // CH*  B–X, A–X
        [473.7, 1.6, 2, 0.35], [516.5, 1.9, 2, 1.0], [563.5, 1.9, 2, 0.45],   // C2*  Swan
      ];
      const k = [1, 1, 1], flick = [1, 1, 1];
      let phi = 0.8;
      function setPhi(f) {
        phi = f;
        k[0] = Math.exp(-(((f - 1.05) / 0.42) ** 2));
        k[1] = 0.12 + 0.5 * clamp((f - 0.6) / 0.6, 0, 1.2);
        k[2] = 0.02 + 0.8 * clamp((f - 0.85) / 0.4, 0, 1) ** 2;
      }
      function spec(l) {
        let s = 0.07 * Math.exp(-(((l - 420) / 110) ** 2)) * (0.5 + 0.6 * k[0]); // CO2*-Kontinuum
        for (const [c, sg, sp, w] of bands) s += w * k[sp] * flick[sp] * Math.exp(-0.5 * ((l - c) / sg) ** 2);
        return s;
      }
      setPhi(0.8);

      // Lichtleiter mit Kollimator
      const tubeMesh = cylinderBetween(SRC.clone().add(new THREE.Vector3(-2.4, 0, 0)), SRC, 0.42, M.dark);
      g.add(tubeMesh);
      g.add(cylinderBetween(SRC.clone().add(new THREE.Vector3(-0.25, 0, 0)), SRC.clone().add(new THREE.Vector3(0.05, 0, 0)), 0.47, M.steel));
      g.add(tube([[SRC.x - 2.4, 0, 6], [SRC.x - 4.5, -0.6, 6.8], [SRC.x - 7, -2.5, 9]], 0.11, new THREE.MeshStandardMaterial({ color: 0xd9822b, roughness: 0.6 })));
      const lab0 = textSprite(lang === 'en' ? 'Flame emission via optical fibre' : 'Flammenleuchten über Lichtleiter', 0.55);
      lab0.position.copy(SRC).add(new THREE.Vector3(-1.5, 1.3, 0));
      g.add(lab0);

      // Eintretender Strahl
      const beamMat = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      beamMat.color.setRGB(0.9, 0.95, 1.2);
      g.add(cylinderBetween(SRC, GR, 0.05, beamMat));

      // Beugungsgitter (schillernde Oberfläche)
      const outC = new THREE.Vector3(xOf(445), 0, ZD).sub(GR).normalize();
      const nrm = new THREE.Vector3(-1, 0, 0).add(outC).normalize();
      const grating = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, 2.4, 2.4),
        new THREE.MeshPhysicalMaterial({ color: 0xb8bec8, metalness: 1, roughness: 0.12, iridescence: 1, iridescenceIOR: 1.8, iridescenceThicknessRange: [250, 900] })
      );
      grating.position.copy(GR);
      grating.rotation.y = Math.atan2(-nrm.z, nrm.x);
      g.add(grating);
      const holder = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 1.6, 16), M.dark);
      holder.position.copy(GR).add(new THREE.Vector3(0, -2, 0));
      g.add(holder);
      const lab1 = textSprite(lang === 'en' ? 'Diffraction grating' : 'Beugungsgitter', 0.5);
      lab1.position.copy(GR).add(new THREE.Vector3(0, 1.8, 0.6));
      g.add(lab1);

      // Detektorzeile mit dynamischer Spektral-Textur
      const det = new THREE.Mesh(new THREE.BoxGeometry(X1 - X0 + 1.2, 0.6, 0.8), M.dark);
      det.position.set((X0 + X1) / 2, 0, ZD);
      g.add(det);
      const TW = 512;
      const texData = new Uint8Array(TW * 4);
      const dtex = new THREE.DataTexture(texData, TW, 1, THREE.RGBAFormat);
      dtex.magFilter = THREE.LinearFilter;
      const stripMat = new THREE.MeshBasicMaterial({ map: dtex });
      stripMat.color.setScalar(2.2);
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(X1 - X0, 0.36), stripMat);
      strip.position.set((X0 + X1) / 2, 0, ZD + 0.41);
      g.add(strip);

      // Gebeugte Strahlen
      const NR = 140;
      const rpos = new Float32Array(NR * 6), rcol = new Float32Array(NR * 6), rl = new Float32Array(NR);
      for (let i = 0; i < NR; i++) {
        rl[i] = L0 + ((i + 0.5) / NR) * (L1 - L0);
        rpos.set([GR.x, GR.y, GR.z, xOf(rl[i]), 0.1, ZD + 0.45], i * 6);
      }
      const rgeo = new THREE.BufferGeometry();
      rgeo.setAttribute('position', new THREE.BufferAttribute(rpos, 3));
      rgeo.setAttribute('color', new THREE.BufferAttribute(rcol, 3).setUsage(THREE.DynamicDrawUsage));
      g.add(new THREE.LineSegments(rgeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));

      // Spektrum-Diagramm (Kurve + Füllung), steht auf der Detektorzeile
      const NS = L1 - L0 + 1;
      const cpos = new Float32Array(NS * 3), ccol = new Float32Array(NS * 3);
      const fpos = new Float32Array(NS * 6), fcol = new Float32Array(NS * 6);
      const fidx = [];
      for (let i = 0; i < NS; i++) {
        const x = xOf(L0 + i);
        cpos.set([x, Y0, ZD], i * 3);
        fpos.set([x, Y0, ZD, x, Y0, ZD], i * 6);
        if (i < NS - 1) { const a = i * 2; fidx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
      const cgeo = new THREE.BufferGeometry();
      cgeo.setAttribute('position', new THREE.BufferAttribute(cpos, 3).setUsage(THREE.DynamicDrawUsage));
      cgeo.setAttribute('color', new THREE.BufferAttribute(ccol, 3));
      const curve = new THREE.Line(cgeo, new THREE.LineBasicMaterial({ vertexColors: true }));
      curve.frustumCulled = false;
      g.add(curve);
      const fgeo = new THREE.BufferGeometry();
      fgeo.setAttribute('position', new THREE.BufferAttribute(fpos, 3).setUsage(THREE.DynamicDrawUsage));
      fgeo.setAttribute('color', new THREE.BufferAttribute(fcol, 3));
      fgeo.setIndex(fidx);
      const fill = new THREE.Mesh(fgeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      fill.frustumCulled = false;
      g.add(fill);
      for (let i = 0; i < NS; i++) {
        wlColor(L0 + i, ccol, i * 3, 1.35);
        wlColor(L0 + i, fcol, i * 6, 0.05);
        wlColor(L0 + i, fcol, i * 6 + 3, 0.32);
      }

      // Achsen, Gitterlinien, Beschriftung
      const gl = [];
      for (const f of [0, 0.25, 0.5, 0.75, 1]) gl.push(X0, Y0 + HP * f, ZD - 0.02, X1, Y0 + HP * f, ZD - 0.02);
      for (let l = 300; l <= 600; l += 50) gl.push(xOf(l), Y0, ZD - 0.02, xOf(l), Y0 + HP, ZD - 0.02);
      const ggeo = new THREE.BufferGeometry();
      ggeo.setAttribute('position', new THREE.Float32BufferAttribute(gl, 3));
      g.add(new THREE.LineSegments(ggeo, new THREE.LineBasicMaterial({ color: 0x2a6f9a, transparent: true, opacity: 0.35, depthWrite: false })));
      for (let l = 300; l <= 600; l += 100) {
        const s = textSprite(String(l), 0.42, '#a9b4c8');
        s.position.set(xOf(l), -0.75, ZD + 0.6);
        g.add(s);
      }
      const axis = textSprite(lang === 'en' ? 'Wavelength / nm' : 'Wellenlänge / nm', 0.45, '#a9b4c8');
      axis.position.set((X0 + X1) / 2, -1.45, ZD + 0.6);
      g.add(axis);
      const peaks = [
        { l: 309.0, s: textSprite('OH*', 0.55) },
        { l: 431.4, s: textSprite('CH*', 0.55) },
        { l: 516.5, s: textSprite('C₂*', 0.55) },
      ];
      for (const pk of peaks) g.add(pk.s);

      // Photonen auf dem Weg Quelle → Gitter → Detektor
      const NPH = Math.round(700 * Q);
      const php = new Float32Array(NPH * 3), phc = new Float32Array(NPH * 3);
      const phS = new Float32Array(NPH), phL = new Float32Array(NPH), phV = new Float32Array(NPH);
      function pickLambda() {
        for (let n = 0; n < 40; n++) { const l = rand(L0, L1); if (Math.random() * 1.3 < spec(l)) return l; }
        return 309;
      }
      for (let i = 0; i < NPH; i++) { phS[i] = Math.random(); phL[i] = pickLambda(); phV[i] = rand(0.25, 0.4); }
      const phgeo = new THREE.BufferGeometry();
      phgeo.setAttribute('position', new THREE.BufferAttribute(php, 3).setUsage(THREE.DynamicDrawUsage));
      phgeo.setAttribute('color', new THREE.BufferAttribute(phc, 3).setUsage(THREE.DynamicDrawUsage));
      const glow = canvasTexture(64, 64, (ctx, w, h) => {
        const gr = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
        gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gr; ctx.fillRect(0, 0, w, h);
      });
      const photons = new THREE.Points(phgeo, new THREE.PointsMaterial({ size: 0.32, map: glow, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      photons.frustumCulled = false;
      g.add(photons);
      const lenIn = SRC.distanceTo(GR);

      const tmpC = [0, 0, 0];
      let ratio = 0;
      return {
        group: g, key: 0.7,
        light: { color: new THREE.Color(0xa8c4ff), intensity: 14, pos: new THREE.Vector3() },
        update(dt, p, t) {
          setPhi(p);
          for (let s = 0; s < 3; s++) flick[s] = 1 + 0.07 * Math.sin(t * (11 + s * 3.7) + s) + 0.04 * Math.sin(t * (27 + s * 5.1) + 2 * s);

          // Kurve, Füllung, Peak-Beschriftung
          for (let i = 0; i < NS; i++) {
            const y = Y0 + HP * spec(L0 + i);
            cpos[i * 3 + 1] = y;
            fpos[i * 6 + 4] = y;
          }
          cgeo.attributes.position.needsUpdate = true;
          fgeo.attributes.position.needsUpdate = true;
          for (const pk of peaks) {
            const v = spec(pk.l);
            pk.s.position.set(xOf(pk.l), Y0 + HP * v + 0.55, ZD + 0.1);
            pk.s.material.opacity = smooth(0.04, 0.12, v);
          }
          ratio = spec(431.4) / Math.max(1e-3, spec(309.0));

          // Detektorzeile
          for (let i = 0; i < TW; i++) {
            const l = L0 + ((i + 0.5) / TW) * (L1 - L0);
            wlColor(l, tmpC, 0, clamp(spec(l) * 1.1, 0, 1));
            texData[i * 4] = Math.min(255, tmpC[0] * 255); texData[i * 4 + 1] = Math.min(255, tmpC[1] * 255);
            texData[i * 4 + 2] = Math.min(255, tmpC[2] * 255); texData[i * 4 + 3] = 255;
          }
          dtex.needsUpdate = true;

          // Strahlen
          for (let i = 0; i < NR; i++) {
            const v = spec(rl[i]);
            wlColor(rl[i], rcol, i * 6, clamp(v * 1.6, 0, 1.4));
            wlColor(rl[i], rcol, i * 6 + 3, clamp(v * 1.6, 0, 1.4));
          }
          rgeo.attributes.color.needsUpdate = true;

          // Photonen
          for (let i = 0; i < NPH; i++) {
            phS[i] += dt * phV[i];
            if (phS[i] >= 1) { phS[i] -= 1; phL[i] = pickLambda(); }
            const s = phS[i];
            if (s < 0.45) {
              const u = s / 0.45;
              php[i * 3] = SRC.x + (GR.x - SRC.x) * u; php[i * 3 + 1] = 0; php[i * 3 + 2] = SRC.z;
              phc[i * 3] = phc[i * 3 + 1] = phc[i * 3 + 2] = 0.8;
            } else {
              const u = (s - 0.45) / 0.55;
              php[i * 3] = GR.x + (xOf(phL[i]) - GR.x) * u; php[i * 3 + 1] = 0.1 * u; php[i * 3 + 2] = GR.z + (ZD + 0.45 - GR.z) * u;
              wlColor(phL[i], phc, i * 3, 1.2);
            }
          }
          phgeo.attributes.position.needsUpdate = true;
          phgeo.attributes.color.needsUpdate = true;

          this.light.pos.copy(GR).add(new THREE.Vector3(2, 1.5, -2));
          g.localToWorld(this.light.pos);
        },
        hud() {
          const f = phi.toFixed(2), r = ratio.toFixed(2);
          return lang === 'en'
            ? ['Emission spectroscopy of a methane flame', `Equivalence ratio φ = ${f} · CH*/OH* = ${r}`]
            : ['Emissionsspektroskopie einer Methanflamme', `Äquivalenzverhältnis φ = ${f.replace('.', ',')} · CH*/OH* = ${r.replace('.', ',')}`];
        },
      };
    }

    // ======================================================================
    //  Station: Kernspaltung von U-235 – Kettenreaktion
    //  n + U-235 → U-236* → Ba-141 + Kr-92 + 3 n  (≈ 200 MeV je Spaltung)
    //  Kerne aus einzelnen Nukleonen (92 p, 143 n). Ablauf je Kern:
    //  Einfang → Schwingung → Einschnürung → Spaltung; die Bruchstücke
    //  trennen sich mit Impulserhaltung (leichteres Kr ist schneller).
    //  Scroll steuert den Multiplikationsfaktor k.
    // ======================================================================
    function buildFission() {
      const g = new THREE.Group();
      const RN = 0.5, SLOTS = 236, NN = 9;
      const MA = 141, MB = 92, MT = MA + MB;

      // Dichte Kugelpackung (kubisch-flächenzentriert), die n Punkte nächst am Zentrum
      function packing(n) {
        const s = (2 * RN * 1.03) / Math.SQRT2, pts = [];
        for (let i = -7; i <= 7; i++) for (let j = -7; j <= 7; j++) for (let k = -7; k <= 7; k++) {
          if ((i + j + k) & 1) continue;
          const v = new THREE.Vector3(i * s, j * s, k * s);
          v.l = v.length() + Math.random() * 0.15;
          pts.push(v);
        }
        pts.sort((a, b) => a.l - b.l);
        const out = pts.slice(0, n);
        const cen = new THREE.Vector3();
        out.forEach((p) => cen.add(p));
        cen.divideScalar(n);
        out.forEach((p) => p.sub(cen).add(new THREE.Vector3(rand(-0.04, 0.04), rand(-0.04, 0.04), rand(-0.04, 0.04))));
        return out;
      }
      const packU = packing(235), packA = packing(MA), packB = packing(MB);
      const radius = (pk) => pk.reduce((m, p) => Math.max(m, p.length()), 0) + RN;
      const RU = radius(packU), RA = radius(packA), RB = radius(packB);

      // Nukleonen als InstancedMesh
      const seg = lowPower ? [8, 6] : [12, 9];
      const nucMesh = new THREE.InstancedMesh(
        new THREE.SphereGeometry(RN, seg[0], seg[1]),
        new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.05 }),
        NN * SLOTS
      );
      nucMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      nucMesh.frustumCulled = false;
      g.add(nucMesh);
      const colP = new THREE.Color(0.85, 0.17, 0.13), colN = new THREE.Color(0.55, 0.62, 0.72);

      const labU = canvasLabelTex('U-235'), labBa = canvasLabelTex('Ba-141'), labKr = canvasLabelTex('Kr-92');

      // Kerne im Gitter
      const nuclei = [];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
        const n = {
          c: new THREE.Vector3((c - 1) * 13 + rand(-1.2, 1.2), (1 - r) * 11 + rand(-1, 1), rand(-3, 3)),
          base: Array.from({ length: SLOTS }, () => new THREE.Vector3()),
          tgt: Array.from({ length: SLOTS }, () => new THREE.Vector3()),
          cur: Array.from({ length: SLOTS }, () => new THREE.Vector3()),
          grp: new Int8Array(SLOTS), isP: new Uint8Array(SLOTS), phase: new Float32Array(SLOTS),
          axis: new THREE.Vector3(), state: 'idle', t: 0, free: [], targeted: false,
          sU: makeLabel(labU), sA: makeLabel(labBa), sB: makeLabel(labKr),
        };
        g.add(n.sU, n.sA, n.sB);
        nuclei.push(n);
      }
      const q = new THREE.Quaternion(), e = new THREE.Euler();
      function resetNucleus(n, idx) {
        q.setFromEuler(e.set(rand(0, 6.28), rand(0, 6.28), rand(0, 6.28)));
        const protons = new Set();
        while (protons.size < 92) protons.add((Math.random() * 235) | 0);
        for (let k = 0; k < 235; k++) {
          n.base[k].copy(packU[k]).applyQuaternion(q);
          n.isP[k] = protons.has(k) ? 1 : 0;
          n.phase[k] = rand(0, 6.28);
        }
        n.isP[235] = 0;
        n.base[235].set(0, 0, 0);
        n.grp.fill(-1);
        n.state = 'idle'; n.t = 0; n.targeted = false; n.free = [];
        for (let k = 0; k < SLOTS; k++) nucMesh.setColorAt(idx * SLOTS + k, n.isP[k] ? colP : colN);
        nucMesh.instanceColor.needsUpdate = true;
      }

      // Einfang: Nukleonen auf die beiden Bruchstücke und 3 freie Neutronen aufteilen
      function capture(n, dirIn) {
        n.base[235].copy(dirIn).multiplyScalar(-(RU - RN * 0.6));
        n.axis.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
        const proj = (k) => n.base[k].dot(n.axis);
        const order = [...Array(SLOTS).keys()].sort((a, b) => proj(a) - proj(b));
        const split = proj(order[MA]);
        const neutrons = order.filter((k) => !n.isP[k]).sort((a, b) => Math.abs(proj(a) - split) - Math.abs(proj(b) - split));
        n.free = neutrons.slice(0, 3);
        const rest = order.filter((k) => !n.free.includes(k));
        const A = rest.slice(0, MA), B = rest.slice(MA);
        // Protonenzahlen exakt einstellen: Ba hat 56, Kr hat 36 Protonen
        let pA = A.filter((k) => n.isP[k]).length;
        while (pA !== 56) {
          const fromA = pA > 56 ? 1 : 0;
          let ia = -1, ib = -1;
          for (let i = A.length - 1; i >= 0; i--) if (n.isP[A[i]] === fromA) { ia = i; break; }
          for (let i = 0; i < B.length; i++) if (n.isP[B[i]] === 1 - fromA) { ib = i; break; }
          if (ia < 0 || ib < 0) break;
          const t = A[ia]; A[ia] = B[ib]; B[ib] = t;
          pA += fromA ? -1 : 1;
        }
        // Zielpositionen in den kugelförmigen Bruchstücken (Rang entlang der Achse)
        const cA = n.axis.clone().multiplyScalar((-(RA + RB) * MB) / MT);
        const cB = n.axis.clone().multiplyScalar(((RA + RB) * MA) / MT);
        const assign = (members, pack, cen, gid) => {
          const ms = members.slice().sort((a, b) => proj(a) - proj(b));
          const ps = pack.slice().sort((a, b) => a.dot(n.axis) - b.dot(n.axis));
          ms.forEach((k, i) => { n.tgt[k].copy(ps[i]).add(cen); n.grp[k] = gid; });
        };
        assign(A, packA, cA, 0);
        assign(B, packB, cB, 1);
        for (const k of n.free) { n.tgt[k].copy(n.base[k]).multiplyScalar(0.3); n.grp[k] = 2; }
        n.state = 'excited'; n.t = 0;
      }

      // Neutronen (Projektile) mit Leuchtspur
      const NMAX = 48, TR = 8;
      const neuMat = new THREE.MeshBasicMaterial();
      neuMat.color.setRGB(1.5, 1.6, 1.9);
      const neuMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(RN * 1.05, 12, 8), neuMat, NMAX);
      neuMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      neuMesh.frustumCulled = false;
      g.add(neuMesh);
      const neutronsArr = Array.from({ length: NMAX }, () => ({ alive: false, p: new THREE.Vector3(), v: new THREE.Vector3(), target: -1, life: 0, tr: Array.from({ length: TR }, () => new THREE.Vector3()) }));
      const tpos = new Float32Array(NMAX * (TR - 1) * 6), tcol = new Float32Array(NMAX * (TR - 1) * 6);
      const tgeo = new THREE.BufferGeometry();
      tgeo.setAttribute('position', new THREE.BufferAttribute(tpos, 3).setUsage(THREE.DynamicDrawUsage));
      tgeo.setAttribute('color', new THREE.BufferAttribute(tcol, 3).setUsage(THREE.DynamicDrawUsage));
      const trails = new THREE.LineSegments(tgeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      trails.frustumCulled = false;
      g.add(trails);

      function spawnNeutron(pos, dir, target, speed) {
        const nn = neutronsArr.find((x) => !x.alive);
        if (!nn) return;
        nn.alive = true; nn.p.copy(pos); nn.target = target; nn.life = 4;
        if (target >= 0) { dir = nuclei[target].c.clone().sub(pos).normalize(); nuclei[target].targeted = true; }
        nn.v.copy(dir).multiplyScalar(speed);
        nn.tr.forEach((t) => t.copy(pos));
      }

      // Gammablitze bei der Spaltung (Billboard-Shader, weich auslaufend)
      const flashes = Array.from({ length: 6 }, () => {
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(2, 2),
          new THREE.ShaderMaterial({
            uniforms: { uA: { value: 0 } },
            vertexShader: /* glsl */ `varying vec2 vXY;
              void main(){ vXY = position.xy; vec4 mv = modelViewMatrix * vec4(0.0,0.0,0.0,1.0);
                mv.xy += position.xy * vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
                gl_Position = projectionMatrix * mv; }`,
            fragmentShader: /* glsl */ `uniform float uA; varying vec2 vXY;
              void main(){ float r = length(vXY);
                float I = uA * exp(-r * r * 5.0) * (1.0 - smoothstep(0.75, 1.0, r));
                gl_FragColor = vec4(vec3(0.75, 0.85, 1.0) * I, 1.0);
                #include <tonemapping_fragment>
                #include <colorspace_fragment> }`,
            transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
          })
        );
        m.visible = false; m.frustumCulled = false; m.age = 9;
        g.add(m);
        return m;
      });
      function flash(pos) {
        const f = flashes.reduce((a, b) => (a.age > b.age ? a : b));
        f.position.copy(pos); f.age = 0; f.visible = true;
      }

      let k = 1, fissions = 0, quiet = 0;
      const tmpV = new THREE.Vector3(), m4 = new THREE.Matrix4();
      const lastFlash = new THREE.Vector3();
      nuclei.forEach((n, i) => resetNucleus(n, i));
      const ease = (x) => x * x * (3 - 2 * x);
      const sep = (t) => 10 * (t - (1 - Math.exp(-3 * t)) / 3);

      function launchSource() {
        const idle = nuclei.map((n, i) => i).filter((i) => nuclei[i].state === 'idle' && !nuclei[i].targeted);
        if (!idle.length) return false;
        const ti = idle[(Math.random() * idle.length) | 0];
        const from = nuclei[ti].c.clone().add(new THREE.Vector3(-26, rand(-6, 6), rand(-4, 4)));
        spawnNeutron(from, null, ti, 9);
        return true;
      }

      function scission(n) {
        fissions++;
        flash(n.c); lastFlash.copy(n.c);
        for (const idx of n.free) {
          const p = n.cur[idx].clone().add(n.c);
          let target = -1;
          if (Math.random() < Math.min(1, k / 3)) {
            const cands = nuclei.map((m, i) => i).filter((i) => nuclei[i].state === 'idle' && !nuclei[i].targeted && nuclei[i] !== n);
            if (cands.length) {
              cands.sort((a, b) => nuclei[a].c.distanceTo(n.c) - nuclei[b].c.distanceTo(n.c));
              target = cands[(Math.random() * Math.min(3, cands.length)) | 0];
            }
          }
          const dir = tmpV.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().clone();
          spawnNeutron(p, dir, target, 15);
        }
      }

      return {
        group: g, key: 0.75, bloom: 0.12,   // wenig Überstrahlung: Nukleonen bleiben klar und farbig
        light: { color: new THREE.Color(0xbcd0ff), intensity: 0, pos: new THREE.Vector3() },
        update(dt, p, t) {
          k = p;
          // Kerne
          let busy = false, idleCount = 0;
          nuclei.forEach((n, ni) => {
            n.t += dt;
            if (n.state === 'idle') idleCount++;
            else if (n.state !== 'gone') busy = true;
            if (n.state === 'excited' && n.t > 0.55) { n.state = 'elongate'; n.t = 0; }
            else if (n.state === 'elongate' && n.t > 0.65) { n.state = 'split'; n.t = 0; for (let s = 0; s < SLOTS; s++) n.cur[s].copy(n.tgt[s]); scission(n); }
            else if (n.state === 'split' && n.t > 2.3) { n.state = 'gone'; }

            const osc = Math.sin(n.t * 18);
            const sA = (sep(n.t) * MB) / MT, sB = (sep(n.t) * MA) / MT;
            const shrink = n.state === 'split' ? 1 - smooth(1.6, 2.3, n.t) : 1;
            for (let s = 0; s < SLOTS; s++) {
              const v = n.cur[s];
              let scale = 1;
              if (n.state === 'idle') {
                if (s === 235) scale = 0;
                v.copy(n.base[s]).multiplyScalar(1 + 0.012 * Math.sin(t * 3 + n.phase[s]));
              } else if (n.state === 'excited') {
                const a = n.base[s].dot(n.axis);
                v.copy(n.base[s]).multiplyScalar(1 - 0.07 * osc).addScaledVector(n.axis, a * 0.21 * osc);
              } else if (n.state === 'elongate') {
                v.copy(n.base[s]).lerp(n.tgt[s], ease(Math.min(1, n.t / 0.65)));
              } else if (n.state === 'split') {
                if (n.grp[s] === 2) scale = 0;
                else v.copy(n.tgt[s]).addScaledVector(n.axis, n.grp[s] === 0 ? -sA : sB);
                scale *= shrink;
              } else scale = 0;
              m4.makeScale(scale, scale, scale).setPosition(v.x + n.c.x, v.y + n.c.y, v.z + n.c.z);
              nucMesh.setMatrixAt(ni * SLOTS + s, m4);
            }
            // Beschriftungen
            const showU = n.state === 'idle' || n.state === 'excited';
            n.sU.visible = showU;
            n.sU.position.set(n.c.x, n.c.y + RU + 1.0, n.c.z);
            const showF = n.state === 'split';
            n.sA.visible = n.sB.visible = showF;
            if (showF) {
              n.sA.position.copy(n.c).addScaledVector(n.axis, (-(RA + RB) * MB) / MT - sA).add(tmpV.set(0, RA + 0.9, 0));
              n.sB.position.copy(n.c).addScaledVector(n.axis, ((RA + RB) * MA) / MT + sB).add(tmpV.set(0, RB + 0.9, 0));
              n.sA.material.opacity = n.sB.material.opacity = 0.9 * shrink;
            }
          });
          nucMesh.instanceMatrix.needsUpdate = true;

          // Neutronen
          let alive = 0, vi = 0;
          neutronsArr.forEach((nn, i) => {
            if (nn.alive) {
              nn.p.addScaledVector(nn.v, dt);
              nn.life -= dt;
              for (let j = TR - 1; j > 0; j--) nn.tr[j].lerp(nn.tr[j - 1], Math.min(1, dt * 22));
              nn.tr[0].copy(nn.p);
              if (nn.target >= 0) {
                const tn = nuclei[nn.target];
                if (nn.p.distanceTo(tn.c) < RU) {
                  if (tn.state === 'idle') { capture(tn, nn.v.clone().normalize()); nn.alive = false; }
                  tn.targeted = false;
                  nn.target = -1;
                }
              }
              if (nn.life <= 0) nn.alive = false;
            }
            const sc = nn.alive ? 1 : 0;
            if (nn.alive) alive++;
            m4.makeScale(sc, sc, sc).setPosition(nn.p.x, nn.p.y, nn.p.z);
            neuMesh.setMatrixAt(i, m4);
            for (let j = 0; j < TR - 1; j++) {
              const a = nn.tr[j], b = nn.tr[j + 1];
              const f0 = nn.alive ? (1 - j / TR) * 0.9 : 0, f1 = nn.alive ? (1 - (j + 1) / TR) * 0.9 : 0;
              tpos.set([a.x, a.y, a.z, b.x, b.y, b.z], vi * 3);
              tcol.set([0.6 * f0, 0.7 * f0, 1.0 * f0, 0.6 * f1, 0.7 * f1, 1.0 * f1], vi * 3);
              vi += 2;
            }
          });
          neuMesh.instanceMatrix.needsUpdate = true;
          tgeo.attributes.position.needsUpdate = true;
          tgeo.attributes.color.needsUpdate = true;

          // Blitze
          let glow = 0;
          for (const f of flashes) {
            f.age += dt;
            f.visible = f.age < 0.9;
            if (f.visible) {
              f.scale.setScalar(4 + f.age * 14);
              f.material.uniforms.uA.value = 2.2 * Math.exp(-f.age * 5);
              glow += Math.exp(-f.age * 5);
            }
          }
          this.light.intensity = 120 * glow;
          this.light.pos.copy(lastFlash);
          g.localToWorld(this.light.pos);

          // Nächster Zyklus: Ruhe → neues Quellneutron, ggf. Brennstoff erneuern
          if (!busy && alive === 0) {
            quiet += dt;
            if (quiet > 1.2) {
              quiet = 0;
              if (idleCount < 3 || !launchSource()) {
                nuclei.forEach((n, i) => resetNucleus(n, i));
                fissions = 0;
                launchSource();
              }
            }
          } else quiet = 0;
        },
        hud() {
          const kk = k.toFixed(2), E = (fissions * 0.2).toFixed(1);
          const st = k < 0.97 ? (lang === 'en' ? 'subcritical' : 'unterkritisch') : k <= 1.03 ? (lang === 'en' ? 'critical' : 'kritisch') : (lang === 'en' ? 'supercritical' : 'überkritisch');
          return lang === 'en'
            ? ['Nuclear fission: n + U-235 → Ba-141 + Kr-92 + 3 n', `Fissions ${fissions} · ≈ ${E} GeV released · k = ${kk} (${st})`]
            : ['Kernspaltung: n + U-235 → Ba-141 + Kr-92 + 3 n', `Spaltungen ${fissions} · ≈ ${E.replace('.', ',')} GeV freigesetzt · k = ${kk.replace('.', ',')} (${st})`];
        },
      };
    }

    // Beschriftungs-Textur einmal erzeugen, mehrfach verwenden
    function canvasLabelTex(text) {
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d');
      const font = '600 64px Inter, system-ui, sans-serif';
      ctx.font = font;
      c.width = Math.ceil(ctx.measureText(text).width) + 24; c.height = 88;
      ctx.font = font; ctx.fillStyle = '#e6ebf5'; ctx.textBaseline = 'middle';
      ctx.fillText(text, 12, 46);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.userData.aspect = c.width / c.height;
      return tex;
    }
    function makeLabel(tex, height = 0.9) {
      const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
      m.color.setScalar(0.72);
      const s = new THREE.Sprite(m);
      s.scale.set(height * tex.userData.aspect, height, 1);
      return s;
    }

    // ======================================================================
    //  Station 5: Stern mit Exoplanetentransit
    // ======================================================================
    function buildStar() {
      const g = new THREE.Group();
      const Rs = 8, Rp = 2.0, orbitR = 16, Dc = 36;   // Rp: Planetenradius (größer = deutlicher)
      const starMat = new THREE.ShaderMaterial({
        uniforms: { uTime: common.uTime, uBright: { value: 2.4 } },   // Sternhelligkeit
        vertexShader: /* glsl */ `
          varying vec3 vN; varying vec3 vP; varying vec3 vView;
          void main() {
            vN = normalize(normalMatrix * normal);
            vP = normalize(position);
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vView = -mv.xyz;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          uniform float uTime; uniform float uBright;
          varying vec3 vN; varying vec3 vP; varying vec3 vView;
          float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
          float vnoise(vec3 x) {
            vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
            return mix(mix(mix(hash3(i), hash3(i + vec3(1.0, 0.0, 0.0)), f.x),
                           mix(hash3(i + vec3(0.0, 1.0, 0.0)), hash3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
                       mix(mix(hash3(i + vec3(0.0, 0.0, 1.0)), hash3(i + vec3(1.0, 0.0, 1.0)), f.x),
                           mix(hash3(i + vec3(0.0, 1.0, 1.0)), hash3(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
          }
          void main() {
            float mu = clamp(dot(normalize(vN), normalize(vView)), 0.0, 1.0);
            float limb = 1.0 - 0.56 * (1.0 - mu) - 0.2 * (1.0 - mu) * (1.0 - mu);   // Randverdunkelung
            vec3 q = vP * 3.0;
            float gr = vnoise(q * 2.2 + vec3(0.0, uTime * 0.15, 0.0)) * 0.6
                     + vnoise(q * 5.5 - vec3(uTime * 0.2)) * 0.3
                     + vnoise(q * 13.0 + vec3(uTime * 0.3)) * 0.1;            // Granulation
            vec3 col = mix(vec3(1.0, 0.55, 0.22), vec3(1.0, 0.88, 0.66), smoothstep(0.25, 0.75, gr)) * (0.75 + 0.5 * gr);
            col = mix(col * vec3(1.0, 0.7, 0.45), col, mu);
            gl_FragColor = vec4(col * limb * uBright, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      });
      g.add(new THREE.Mesh(new THREE.SphereGeometry(Rs, 96, 64), starMat));

      // Lichthof als Shader: pro Pixel berechnet (keine 8-Bit-Stufen), stetig bis null.
      //   innen: heller Schein direkt am Sternrand (exponentieller Abfall)
      //   außen: Korona mit ~ r^-3-Abfall und leichten Strahlenstrukturen
      const coronaMat = new THREE.ShaderMaterial({
        uniforms: { uTime: common.uTime, uRs: { value: Rs }, uI: { value: 1.0 } },
        vertexShader: /* glsl */ `
          varying vec2 vXY;
          void main() {
            vXY = position.xy;
            vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);   // Billboard: immer zur Kamera
            mv.xy += position.xy;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          uniform float uTime; uniform float uRs; uniform float uI;
          varying vec2 vXY;
          float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
          void main() {
            float r = length(vXY) / uRs;                 // Abstand in Sternradien
            float x = max(r - 1.0, 0.0);
            float ang = atan(vXY.y, vXY.x);
            float rays = 1.0 + 0.18 * sin(ang * 5.0 + 0.7) * sin(ang * 3.0 - 1.1)
                             + 0.10 * sin(ang * 11.0 + uTime * 0.03) + 0.06 * sin(ang * 19.0 - 0.4);
            float inner = 0.55 * exp(-x * 7.0);
            float outer = 0.22 * pow(1.0 + x * 2.0, -3.0) * mix(1.0, rays, smoothstep(0.05, 0.6, x));
            float fade = 1.0 - smoothstep(2.2, 3.85, r);  // läuft weich auf exakt null aus
            float I = (inner + outer) * fade * uI;
            vec3 col = mix(vec3(1.0, 0.55, 0.25), vec3(1.0, 0.86, 0.66), clamp(inner * 1.6, 0.0, 1.0));
            I += (hash(gl_FragCoord.xy) - 0.5) / 255.0;  // Dithering gegen Farbstufen
            gl_FragColor = vec4(col * max(I, 0.0), 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const corona = new THREE.Mesh(new THREE.PlaneGeometry(Rs * 8, Rs * 8), coronaMat);
      corona.frustumCulled = false;
      g.add(corona);

      const planet = new THREE.Group();
      // Planet fast schwarz: maximaler Kontrast vor der hellen Sternscheibe
      planet.add(new THREE.Mesh(new THREE.SphereGeometry(Rp, 64, 32), new THREE.MeshStandardMaterial({ color: 0x05070b, roughness: 1, metalness: 0 })));
      const atmo = new THREE.Mesh(
        new THREE.SphereGeometry(Rp * 1.08, 64, 32),
        new THREE.ShaderMaterial({
          uniforms: { uBack: { value: 0 } },
          vertexShader: /* glsl */ `varying vec3 vN; varying vec3 vV;
            void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
          fragmentShader: /* glsl */ `uniform float uBack; varying vec3 vN; varying vec3 vV;
            void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 3.0);
              gl_FragColor = vec4(vec3(0.45, 0.75, 1.0) * f * (0.35 + 0.9 * uBack), f);
              #include <tonemapping_fragment>
              #include <colorspace_fragment> }`,
          transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        })
      );
      planet.add(atmo);
      g.add(planet);

      function overlap(d, k) { // überdeckter Anteil der Sternscheibe
        if (d >= 1 + k) return 0;
        if (d <= 1 - k) return k * k;
        const k0 = Math.acos(clamp((k * k + d * d - 1) / (2 * k * d), -1, 1));
        const k1 = Math.acos(clamp((1 - k * k + d * d) / (2 * d), -1, 1));
        return (k * k * k0 + k1 - 0.5 * Math.sqrt(Math.max(0, 4 * d * d - (1 + d * d - k * k) ** 2))) / Math.PI;
      }
      let flux = 1;
      return {
        group: g, key: 0.12, bloom: 0.35,   // weniger Überstrahlung über die Planetenscheibe
        light: { color: new THREE.Color(0xffc890), intensity: 900, pos: new THREE.Vector3() },
        update(dt, p, t) {
          const ph = t * 0.157 + p * 1.2 - 0.6;
          const px = orbitR * Math.sin(ph), pz = orbitR * Math.cos(ph), py = 1.6;
          planet.position.set(px, py, pz);
          planet.rotation.y = t * 0.2;
          flux = 1;
          let back = 0;
          if (pz > 0) {
            const s = Dc / (Dc - pz);
            const d = (Math.hypot(px, py) * s) / Rs, k = (Rp * s) / Rs;
            const mu = Math.sqrt(1 - Math.min(1, d) ** 2);
            const I = (1 - 0.56 * (1 - mu) - 0.2 * (1 - mu) ** 2) / (1 - 0.56 / 3 - 0.2 / 6);
            const ov = overlap(d, k);
            flux = 1 - ov * I;
            back = smooth(1 + k + 0.6, 1 - k, d);
          }
          atmo.material.uniforms.uBack.value = back;
          this.light.pos.set(0, 0, 0);
          g.localToWorld(this.light.pos);
        },
        hud() {
          const f = flux.toFixed(4);
          return lang === 'en'
            ? ['Exoplanet transit · stellar limb darkening', `Relative flux ${f}`]
            : ['Exoplanetentransit · Randverdunkelung des Sterns', `Relativer Strahlungsfluss ${f.replace('.', ',')}`];
        },
      };
    }

    // ======================================================================
    //  Stationen platzieren
    // ======================================================================
    const ST = {
      rocket: Object.assign(buildRocket(), { pos: new THREE.Vector3(0, 0, 0) }),
      earth: Object.assign(buildEarth(), { pos: new THREE.Vector3(90, -60, -50) }),
      airfoil: Object.assign(buildAirfoil(), { pos: new THREE.Vector3(-30, -130, -40) }),
      spectro: Object.assign(buildSpectro(), { pos: new THREE.Vector3(70, -200, -70) }),
      fission: Object.assign(buildFission(), { pos: new THREE.Vector3(0, -280, -170) }),
      star: Object.assign(buildStar(), { pos: new THREE.Vector3(-60, -360, -120) }),
    };
    for (const k in ST) { ST[k].group.position.copy(ST[k].pos); scene.add(ST[k].group); }

    // Eine Station pro Abschnitt. Ablauf beim Scrollen:
    //   Abschnitt beginnt  → seine Szene ist schon da (hinter dem Text)
    //   Schaufenster danach → Szene frei sichtbar, Parameter laufen durch
    //   nächster Abschnitt  → Kamera fliegt zur nächsten Szene
    // shift = [Start, Ende] seitliche Bildverschiebung, p = Parameterbereich
    const KEYS = [
      { sel: '.hero', st: 'rocket', cam: [3, -4, 26], look: [2.5, -7, 0], orbit: 0.6, shift: [0.12, 0], p: [1.0, 0.8] },
      { sel: '#about', st: 'earth', cam: [0, 2.5, 29], look: [0, 0, 0], orbit: 0.5, shift: [0, 0], p: [420, 1200] },
      { sel: '#skills', st: 'airfoil', cam: [-3, 3, 24], look: [0, 0, 0], orbit: 0.5, shift: [0, 0], p: [3, 11] },
      { sel: '#experience', st: 'spectro', cam: [0, 9, 22], look: [1, 2, -3], orbit: 0.45, shift: [0, 0], p: [0.7, 1.25] },
      { sel: '#projects', st: 'fission', cam: [0, 4, 52], look: [0, 0, 0], orbit: 0.45, shift: [0, 0], p: [0.8, 1.3] },
      { sel: '#contact', st: 'star', cam: [0, 1.5, 36], look: [0, 0, 0], orbit: 0.0, shift: [0, 0], p: [0, 1] },
    ].filter((k) => document.querySelector(k.sel));
    if (!KEYS.length) return;

    // ---------- Scroll-Ankerpunkte ----------
    let anchors = [], holdEnds = [], maxFocus = 1, vw = 1, vh = 1;
    function measure() {
      vh = window.innerHeight;
      const docH = document.documentElement.scrollHeight;
      maxFocus = Math.max(1, docH - vh * 0.5);
      const top = (el) => el.getBoundingClientRect().top + window.scrollY;
      const els = KEYS.map((k) => document.querySelector(k.sel));
      // Ankunft, wenn der Abschnittsanfang ca. 35 % unter der Bildschirmoberkante liegt
      anchors = els.map((el, i) => (i === 0 ? 0 : top(el) + vh * 0.15));
      for (let i = anchors.length - 1; i >= 0; i--) {
        const cap = i === anchors.length - 1 ? maxFocus - 40 : anchors[i + 1] - 40;
        anchors[i] = Math.min(anchors[i], cap);
      }
      // Halten, bis das folgende Schaufenster mittig im Bild steht
      holdEnds = els.map((el, i) => {
        const gap = el.nextElementSibling;
        if (gap && gap.classList.contains('scene-gap')) return top(gap) + gap.offsetHeight * 0.5;
        return i < els.length - 1 ? anchors[i + 1] - vh * 0.3 : maxFocus;
      });
    }
    const focusTarget = () => window.scrollY + vh * 0.5;

    function computeState(f) {
      const n = anchors.length;
      if (n === 1 || f <= anchors[0]) return { i: 0, t: 0, blend: 0 };
      for (let i = 0; i < n - 1; i++) {
        if (f < anchors[i + 1]) {
          const h0 = clamp(holdEnds[i], anchors[i], anchors[i + 1] - 1);
          // t: Fortschritt innerhalb des Schaufensters (steuert Parameter und Kameraschwenk)
          const t = h0 - anchors[i] > 50
            ? clamp((f - anchors[i]) / (h0 - anchors[i]), 0, 1)
            : (f - anchors[i]) / (anchors[i + 1] - anchors[i]);
          const fly = clamp((f - h0) / (anchors[i + 1] - h0), 0, 1);
          return { i, t, blend: reduceMotion ? (fly > 0.5 ? 1 : 0) : smooth(0, 1, fly) };
        }
      }
      return { i: n - 1, t: clamp((f - anchors[n - 1]) / Math.max(1, maxFocus - anchors[n - 1]), 0, 1), blend: 0 };
    }

    const _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _la = new THREE.Vector3(), _lb = new THREE.Vector3();
    function pose(k, local, outPos, outLook) {
      const key = KEYS[k], st = ST[key.st];
      const portrait = vw / vh < 1;
      const zoom = portrait ? 1.55 : 1;
      const ang = key.orbit * (local - 0.5);
      _v.set(key.cam[0] * zoom, key.cam[1], key.cam[2] * zoom).applyAxisAngle(THREE.Object3D.DEFAULT_UP, ang);
      outPos.copy(st.pos).add(_v);
      outLook.set(...key.look).add(st.pos);
      return portrait || vw < 768 ? 0 : lerp(key.shift[0], key.shift[1], local);
    }

    // ---------- Postprocessing ----------
    let composer = null;
    let bloom = null;
    if (!lowPower) {
      composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.85, 0.55, 0.62);
      composer.addPass(bloom);
      composer.addPass(new OutputPass());
    }

    function resize() {
      vw = canvas.clientWidth || window.innerWidth;
      const ch = canvas.clientHeight || window.innerHeight;
      renderer.setSize(vw, ch, false);
      camera.aspect = vw / ch;
      camera.updateProjectionMatrix();
      if (composer) { composer.setPixelRatio(pixelRatio); composer.setSize(vw, ch); }
      common.uHalfH.value = (ch * pixelRatio) / 2;
      measure();
      dirty = true;
    }

    // ---------- HUD ----------
    const hudEl = document.querySelector('.sim-hud');
    const hudTitle = hudEl && hudEl.querySelector('.sim-hud__title');
    const hudParam = hudEl && hudEl.querySelector('.sim-hud__param');
    let hudTimer = 0, hudKey = '';

    // ---------- Loop ----------
    let focus = 0, last = performance.now(), simT = 0, dirty = true, lastFocus = -1;
    let frames = 0, frameAcc = 0, degraded = 0;

    new ResizeObserver(resize).observe(canvas);
    new ResizeObserver(() => { measure(); dirty = true; }).observe(document.body);
    window.addEventListener('scroll', () => { dirty = true; }, { passive: true });
    resize();
    focus = focusTarget();

    // Alle Shader vorab kompilieren (kein Ruckeln beim ersten Stationswechsel)
    camera.position.set(0, 0, 30);
    renderer.compile(scene, camera);

    function frame(now) {
      requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      const tf = focusTarget();
      focus = reduceMotion ? tf : focus + (tf - focus) * (1 - Math.exp(-dt * 5));
      if (reduceMotion && !dirty && Math.abs(focus - lastFocus) < 0.5) return;
      lastFocus = focus; dirty = false;
      if (!reduceMotion) simT += dt;
      common.uTime.value = simT;

      const s = computeState(focus);
      const kA = KEYS[s.i], kB = KEYS[Math.min(s.i + 1, KEYS.length - 1)];
      let shift = pose(s.i, s.t, _a, _la);
      if (s.blend > 0) {
        const shB = pose(s.i + 1, 0, _b, _lb);
        const e = s.blend;
        _a.lerp(_b, e); _la.lerp(_lb, e);
        _a.y += Math.sin(Math.PI * e) * 6;
        shift = lerp(shift, shB, e);
      }
      camera.position.copy(_a);
      camera.lookAt(_la);
      const ch = canvas.clientHeight || vh;
      if (Math.abs(shift) > 0.001) camera.setViewOffset(vw, ch, -shift * vw, 0, vw, ch);
      else camera.clearViewOffset();

      // Parameter je Station
      const params = {};
      params[kA.st] = lerp(kA.p[0], kA.p[1], s.t);
      if (s.blend > 0) {
        const pB = kB.p[0];
        params[kB.st] = kB.st === kA.st ? lerp(params[kA.st], pB, s.blend) : pB;
      }
      const dominant = ST[s.blend < 0.5 ? kA.st : kB.st];
      for (const k in ST) {
        const st = ST[k];
        const vis = k in params;
        st.group.visible = vis;
        if (vis) st.update(reduceMotion ? 0 : dt, params[k], simT);
      }

      hot.color.copy(dominant.light.color);
      hot.intensity = dominant.light.intensity;
      if (bloom) bloom.strength = lerp(ST[kA.st].bloom ?? 0.85, ST[kB.st].bloom ?? 0.85, s.blend);
      hot.position.copy(dominant.light.pos);
      const keyA = ST[kA.st].key, keyB = ST[kB.st].key;
      key.intensity = 2.2 * lerp(keyA, keyB, s.blend);
      hemi.intensity = 0.5 * lerp(keyA, keyB, s.blend);
      key.position.copy(camera.position).add(_v.set(12, 16, 6));
      key.target.position.copy(_la);

      if (composer) composer.render(); else renderer.render(scene, camera);

      // HUD
      if (hudEl) {
        hudEl.style.opacity = (1 - Math.sin(Math.PI * s.blend)).toFixed(2);
        hudTimer -= dt;
        const kd = s.blend < 0.5 ? kA.st : kB.st;
        if (hudTimer <= 0 || kd !== hudKey) {
          hudTimer = 0.15; hudKey = kd;
          const [tt, pp] = dominant.hud();
          if (hudTitle.textContent !== tt) hudTitle.textContent = tt;
          if (hudParam.textContent !== pp) hudParam.textContent = pp;
        }
      }

      // Adaptive Qualität: bei zu langsamen Frames Bloom aus, dann Auflösung runter
      if (!reduceMotion && degraded < 2) {
        frames++; frameAcc += dt;
        if (frames === 90) {
          const avg = frameAcc / frames;
          frames = 0; frameAcc = 0;
          if (avg > 0.028) {
            degraded++;
            if (composer && degraded === 1) composer = null;
            else { pixelRatio = Math.max(0.75, pixelRatio * 0.75); renderer.setPixelRatio(pixelRatio); resize(); }
          }
        }
      }
    }
    requestAnimationFrame(frame);
  }
})();
