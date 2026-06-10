/* moots — full WebGL2 renderer. Everything heavy is on the GPU:
   - every node is an instanced quad; the fragment shader makes it a circle,
     fills it with an AVATAR sampled from a dynamic texture atlas (or a solid
     colour when zoomed out / no pic), and draws a coloured ring.
   - links are GPU geometry: arched (Bézier-tessellated) faint base lines, plus
     anti-aliased gold ribbons for the selection.
   Only the text labels live on a thin 2D overlay (GPU text isn't worth it).
   Returns null if WebGL2 is unavailable -> caller falls back to canvas 2D. */
(function (root) {
  function compile(gl, t, src) {
    const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  }
  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
    return p;
  }

  // instance: pos(2) size(1) color(4) uv(4) flags(1: hasTex) = 12 floats
  const FLOATS = 12, STRIDE = FLOATS * 4;
  const NODE_VS = `#version 300 es
  layout(location=0) in vec2 aQuad;
  layout(location=1) in vec2 aPos;
  layout(location=2) in float aSize;
  layout(location=3) in vec4 aColor;
  layout(location=4) in vec4 aUV;       // x0,y0,x1,y1 in atlas
  layout(location=5) in float aTex;     // 1 = has avatar
  uniform vec2 uRes; uniform vec3 uXform;
  out vec2 vQuad; out vec4 vColor; out vec2 vUV; out float vTex; out float vR;
  void main(){
    vQuad = aQuad; vColor = aColor; vTex = aTex;
    vec2 t = aQuad*0.5 + 0.5;            // 0..1 (t.y=0 at the top of the on-screen circle)
    // image-top is uploaded to the LOW v of the cell (no UNPACK_FLIP_Y), so map top->aUV.y directly
    vUV = mix(aUV.xy, aUV.zw, vec2(t.x, t.y));
    vR = aSize * uXform.x;               // on-screen radius (device px)
    vec2 screen = aPos*uXform.x + uXform.yz + aQuad*(aSize*uXform.x);
    vec2 clip = (screen/uRes)*2.0 - 1.0; clip.y = -clip.y;
    gl_Position = vec4(clip, 0.0, 1.0);
  }`;
  const NODE_FS = `#version 300 es
  precision mediump float;
  in vec2 vQuad; in vec4 vColor; in vec2 vUV; in float vTex; in float vR;
  uniform sampler2D uAtlas; uniform float uRing;   // ring fraction (0..)
  uniform float uAA;                                // 1 = smooth edges, 0 = hard
  out vec4 o;
  void main(){
    float d = length(vQuad);
    // edge softness in d-space (~1 device px when smooth, near-hard when off)
    float aa = mix(0.0015, fwidth(d) + 0.0015, uAA);
    float circle = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
    if (circle < 0.003) discard;
    float rw = max(uRing, 2.5 / max(vR, 1.0));      // ring thickness
    float edge = 1.0 - rw;
    vec3 rgb = vColor.rgb;
    if (vTex > 0.5) {
      vec3 face = texture(uAtlas, vUV).rgb;
      float inRing = smoothstep(edge - aa, edge + aa, d);   // 0 inside face, 1 in ring band
      rgb = mix(face, vColor.rgb, inRing);
    }
    float a = circle * vColor.a;
    o = vec4(rgb * a, a);                            // premultiplied
  }`;

  // plain arched lines (faint base links)
  const LINK_VS = `#version 300 es
  layout(location=0) in vec2 aPos;
  uniform vec2 uRes; uniform vec3 uXform;
  void main(){ vec2 s=aPos*uXform.x+uXform.yz; vec2 c=(s/uRes)*2.0-1.0; c.y=-c.y; gl_Position=vec4(c,0.,1.); }`;
  const LINK_FS = `#version 300 es
  precision mediump float; uniform vec4 uColor; out vec4 o;
  void main(){ o = vec4(uColor.rgb*uColor.a, uColor.a); }`;

  // anti-aliased ribbons (selection links): each vertex carries a signed across-width
  // coordinate; the fragment feathers alpha toward the edge.
  const RIB_VS = `#version 300 es
  layout(location=0) in vec3 aPV;     // x, y, side(-1..1)
  uniform vec2 uRes; uniform vec3 uXform;
  out float vSide;
  void main(){ vSide=aPV.z; vec2 s=aPV.xy*uXform.x+uXform.yz; vec2 c=(s/uRes)*2.0-1.0; c.y=-c.y; gl_Position=vec4(c,0.,1.); }`;
  const RIB_FS = `#version 300 es
  precision mediump float; in float vSide; uniform vec4 uColor; uniform float uFeather; out vec4 o;
  void main(){ float a = uColor.a * (1.0 - smoothstep(1.0-uFeather, 1.0, abs(vSide))); o = vec4(uColor.rgb*a, a); }`;

  function GLRenderer(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: true, alpha: true });
    if (!gl) return null;
    let nodeProg, linkProg, ribProg;
    try {
      nodeProg = program(gl, NODE_VS, NODE_FS);
      linkProg = program(gl, LINK_VS, LINK_FS);
      ribProg  = program(gl, RIB_VS, RIB_FS);
    } catch (e) { console.warn('moots gl:', e.message); return null; }

    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const MAXTEX = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    const MAXDIM = Math.min(MAXTEX, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || MAXTEX);  // largest drawing buffer (for screenshots)
    // sniff the GPU so we can default High-res avatars only where they'll run well
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const RENDERER = (dbg ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '').toString();
    const SOFTWARE = /swiftshader|software|llvmpipe|basic render|microsoft basic|warp/i.test(RENDERER);
    // 128px atlas wants an 8192 texture (256MB). Only recommend it on a real GPU with the
    // headroom; otherwise the High atlas overflows / thrashes -> stay at 64px Standard.
    function recommendedCell() {
      if (SOFTWARE) return 64;
      if (MAXTEX < 8192) return 64;
      if (navigator.deviceMemory && navigator.deviceMemory < 4) return 64;
      return 128;
    }

    /* ---------- avatar atlas (resolution configurable at runtime) ---------- */
    let ATLAS = 4096, CELL = 64, COLS = ATLAS / CELL, NCELLS = COLS * COLS;
    let atlas = null;
    const cellOf = new Map();          // sn -> {uv, cell}
    let nextCell = 0;
    let cellSn = [], cellUsed = null, frame = 0;   // per-cell owner + last-drawn stamp (LRU eviction)
    let WANT = 4096;                   // face capacity to aim for (set from archive size)
    // smallest atlas edge whose cell grid covers WANT faces. 8192 RGBA = 268MB of GPU
    // memory, so it's only allocated when the archive actually needs it; software
    // renderers stay at 4096. At 64px cells an 8192 atlas = 16,384 resident faces.
    function atlasEdge(cellPx) {
      const cap = Math.min(MAXTEX, SOFTWARE ? 4096 : 8192);
      let a = 2048;
      while (a < cap && (a / cellPx) * (a / cellPx) < WANT) a *= 2;
      return a;
    }
    const scratch = document.createElement('canvas');
    const sctx = scratch.getContext('2d');
    function makeAtlas(cellPx) {
      CELL = cellPx;
      ATLAS = atlasEdge(cellPx);
      COLS = (ATLAS / CELL) | 0; NCELLS = COLS * COLS;
      scratch.width = scratch.height = CELL;
      if (atlas) gl.deleteTexture(atlas);
      atlas = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, atlas);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ATLAS, ATLAS, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      cellOf.clear(); nextCell = 0;
      cellSn = new Array(NCELLS); cellUsed = new Float64Array(NCELLS); frame = 0;
    }
    makeAtlas(64);
    // Upload a face to the atlas EXACTLY ONCE — call from the image's onload, never
    // from the render loop. The lone texSubImage2D here is the cost; per-frame it 4fps'd.
    function addAvatar(sn, img) {
      const e = cellOf.get(sn);
      if (e) return e.uv;
      let cell;
      if (nextCell < NCELLS) cell = nextCell++;
      else {
        // atlas full: evict the least-recently-drawn face — but only one that hasn't been
        // needed for a while; slots in active use stay put (no thrash). Big archives
        // (>NCELLS people) get whichever faces are actually on screen.
        let best = -1, bestUsed = frame - 30;
        for (let c = 0; c < NCELLS; c++) if (cellUsed[c] < bestUsed) { bestUsed = cellUsed[c]; best = c; }
        if (best < 0) return null;
        cellOf.delete(cellSn[best]);
        cell = best;
      }
      const cx = (cell % COLS) * CELL, cy = ((cell / COLS) | 0) * CELL;
      sctx.clearRect(0, 0, CELL, CELL);
      try { sctx.drawImage(img, 0, 0, CELL, CELL); } catch (_) { return null; }
      gl.bindTexture(gl.TEXTURE_2D, atlas);
      try { gl.texSubImage2D(gl.TEXTURE_2D, 0, cx, cy, gl.RGBA, gl.UNSIGNED_BYTE, scratch); }
      catch (_) { return null; }
      const uv = [cx / ATLAS, cy / ATLAS, (cx + CELL) / ATLAS, (cy + CELL) / ATLAS];
      cellOf.set(sn, { uv, cell }); cellSn[cell] = sn; cellUsed[cell] = frame;
      return uv;
    }
    // render-loop lookup; stamps the cell as in-use so the LRU never evicts a visible face
    const uvOf = (sn) => { const e = cellOf.get(sn); if (!e) return null; cellUsed[e.cell] = frame; return e.uv; };
    const hasAvatar = (sn) => cellOf.has(sn);
    // change resolution and/or capacity: rebuild the atlas; caller re-uploads loaded faces.
    // want = how many faces the archive could ask for (sizes the atlas, within GPU limits).
    function setCellSize(px, want) {
      if (want) WANT = want;
      if (px !== CELL || atlasEdge(px) !== ATLAS) makeAtlas(px);
    }

    /* ---------- GL objects ---------- */
    const quad = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]);
    const quadBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf); gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    const nodeVAO = gl.createVertexArray(); gl.bindVertexArray(nodeVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const instBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE, 0);  gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 8);  gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, STRIDE, 12); gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 4, gl.FLOAT, false, STRIDE, 28); gl.vertexAttribDivisor(4, 1);
    gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 1, gl.FLOAT, false, STRIDE, 44); gl.vertexAttribDivisor(5, 1);
    gl.bindVertexArray(null);
    const nU = { res: gl.getUniformLocation(nodeProg, 'uRes'), xf: gl.getUniformLocation(nodeProg, 'uXform'),
                 atlas: gl.getUniformLocation(nodeProg, 'uAtlas'), ring: gl.getUniformLocation(nodeProg, 'uRing'),
                 aa: gl.getUniformLocation(nodeProg, 'uAA') };

    const linkVAO = gl.createVertexArray(); gl.bindVertexArray(linkVAO);
    const linkBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, linkBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    const lU = { res: gl.getUniformLocation(linkProg, 'uRes'), xf: gl.getUniformLocation(linkProg, 'uXform'), color: gl.getUniformLocation(linkProg, 'uColor') };

    const ribVAO = gl.createVertexArray(); gl.bindVertexArray(ribVAO);
    const ribBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ribBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    const rU = { res: gl.getUniformLocation(ribProg, 'uRes'), xf: gl.getUniformLocation(ribProg, 'uXform'),
                 color: gl.getUniformLocation(ribProg, 'uColor'), feather: gl.getUniformLocation(ribProg, 'uFeather') };

    let cw = 0, ch = 0, dpr = 1;
    return {
      FLOATS, addAvatar, uvOf, hasAvatar, setCellSize, recommendedCell, maxDim: MAXDIM, renderer: RENDERER,
      get cell() { return CELL; },
      get bufferWidth() { return gl.drawingBufferWidth; },     // actual backing store (browser may cap below request)
      get bufferHeight() { return gl.drawingBufferHeight; },
      resize(w, h, ratio) { dpr = ratio; cw = Math.round(w * dpr); ch = Math.round(h * dpr); canvas.width = cw; canvas.height = ch; },
      begin() { frame++; gl.viewport(0, 0, cw, ch); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); },
      links(verts, nLines, t, color) {
        if (!nLines) return;
        gl.useProgram(linkProg); gl.bindVertexArray(linkVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, linkBuf); gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
        gl.uniform2f(lU.res, cw, ch); gl.uniform3f(lU.xf, t.k * dpr, t.x * dpr, t.y * dpr); gl.uniform4fv(lU.color, color);
        gl.drawArrays(gl.LINES, 0, nLines * 2);
        gl.bindVertexArray(null);
      },
      ribbons(verts, nVerts, t, color, feather) {
        if (!nVerts) return;
        gl.useProgram(ribProg); gl.bindVertexArray(ribVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, ribBuf); gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
        gl.uniform2f(rU.res, cw, ch); gl.uniform3f(rU.xf, t.k * dpr, t.x * dpr, t.y * dpr);
        gl.uniform4fv(rU.color, color); gl.uniform1f(rU.feather, feather == null ? 0.45 : feather);
        gl.drawArrays(gl.TRIANGLES, 0, nVerts);
        gl.bindVertexArray(null);
      },
      nodes(inst, n, t, ring, aa) {
        if (!n) return;
        gl.useProgram(nodeProg); gl.bindVertexArray(nodeVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, instBuf); gl.bufferData(gl.ARRAY_BUFFER, inst, gl.DYNAMIC_DRAW);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, atlas); gl.uniform1i(nU.atlas, 0);
        gl.uniform1f(nU.ring, ring || 0.0); gl.uniform1f(nU.aa, aa == null ? 1.0 : aa);
        gl.uniform2f(nU.res, cw, ch); gl.uniform3f(nU.xf, t.k * dpr, t.x * dpr, t.y * dpr);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
        gl.bindVertexArray(null);
      },
    };
  }
  root.GLRenderer = GLRenderer;
})(window);
