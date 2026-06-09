/* moots — full WebGL2 renderer. Everything heavy is on the GPU:
   - every node is an instanced quad; the fragment shader makes it a circle,
     fills it with an AVATAR sampled from a dynamic texture atlas (or a solid
     colour when zoomed out / no pic), and draws a coloured ring.
   - links are GPU lines.
   Only the text labels live on a thin 2D overlay (GPU text isn't worth it).
   Returns null if WebGL2 is unavailable -> caller falls back to canvas 2D. */
(function (root) {
  const ATLAS = 4096, CELL = 128, COLS = ATLAS / CELL, NCELLS = COLS * COLS;

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
    vec2 t = aQuad*0.5 + 0.5;            // 0..1
    vUV = mix(aUV.xy, aUV.zw, vec2(t.x, 1.0 - t.y));
    vR = aSize * uXform.x;               // on-screen radius (device px)
    vec2 screen = aPos*uXform.x + uXform.yz + aQuad*(aSize*uXform.x);
    vec2 clip = (screen/uRes)*2.0 - 1.0; clip.y = -clip.y;
    gl_Position = vec4(clip, 0.0, 1.0);
  }`;
  const NODE_FS = `#version 300 es
  precision mediump float;
  in vec2 vQuad; in vec4 vColor; in vec2 vUV; in float vTex; in float vR;
  uniform sampler2D uAtlas; uniform float uRing;   // ring fraction (0..)
  out vec4 o;
  void main(){
    float d = length(vQuad);
    float aa = fwidth(d) + 0.002;
    float circle = 1.0 - smoothstep(1.0-aa, 1.0, d);
    if (circle < 0.004) discard;
    // ring thickness: a constant ~screen px, but at least uRing of the radius
    float rw = max(uRing, 2.5/max(vR,1.0));
    vec3 rgb;
    if (vTex > 0.5 && d < 1.0 - rw) rgb = texture(uAtlas, vUV).rgb;
    else if (vTex > 0.5)           rgb = vColor.rgb;          // ring around avatar
    else                           rgb = vColor.rgb;          // solid dot
    float a = circle * vColor.a;
    o = vec4(rgb * a, a);
  }`;
  const LINK_VS = `#version 300 es
  layout(location=0) in vec2 aPos;
  uniform vec2 uRes; uniform vec3 uXform;
  void main(){ vec2 s=aPos*uXform.x+uXform.yz; vec2 c=(s/uRes)*2.0-1.0; c.y=-c.y; gl_Position=vec4(c,0.,1.); }`;
  const LINK_FS = `#version 300 es
  precision mediump float; uniform vec4 uColor; out vec4 o;
  void main(){ o = vec4(uColor.rgb*uColor.a, uColor.a); }`;

  function GLRenderer(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: true, alpha: true });
    if (!gl) return null;
    let nodeProg, linkProg;
    try { nodeProg = program(gl, NODE_VS, NODE_FS); linkProg = program(gl, LINK_VS, LINK_FS); }
    catch (e) { console.warn('moots gl:', e.message); return null; }

    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // atlas texture
    const atlas = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, atlas);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ATLAS, ATLAS, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

    const cellOf = new Map();          // sn -> {cell, uv, used}
    let nextCell = 0, useTick = 0;
    const scratch = document.createElement('canvas'); scratch.width = CELL; scratch.height = CELL;
    const sctx = scratch.getContext('2d');
    function addAvatar(sn, img) {
      let e = cellOf.get(sn);
      if (e) { e.used = ++useTick; return e.uv; }
      let cell;
      if (nextCell < NCELLS) cell = nextCell++;
      else {                            // LRU evict the least-recently-drawn cell
        let oldest = Infinity, victim = null;
        for (const [k, v] of cellOf) if (v.used < oldest) { oldest = v.used; victim = k; cell = v.cell; }
        if (victim != null) cellOf.delete(victim);
      }
      const cx = (cell % COLS) * CELL, cy = ((cell / COLS) | 0) * CELL;
      sctx.clearRect(0, 0, CELL, CELL);
      try { sctx.drawImage(img, 0, 0, CELL, CELL); } catch (_) { return null; }   // normalise to cell size
      gl.bindTexture(gl.TEXTURE_2D, atlas);
      try { gl.texSubImage2D(gl.TEXTURE_2D, 0, cx, cy, gl.RGBA, gl.UNSIGNED_BYTE, scratch); }
      catch (_) { return null; }
      const uv = [cx / ATLAS, cy / ATLAS, (cx + CELL) / ATLAS, (cy + CELL) / ATLAS];
      cellOf.set(sn, { cell, uv, used: ++useTick });
      return uv;
    }
    const hasAvatar = (sn) => cellOf.has(sn);

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
                 atlas: gl.getUniformLocation(nodeProg, 'uAtlas'), ring: gl.getUniformLocation(nodeProg, 'uRing') };

    const linkVAO = gl.createVertexArray(); gl.bindVertexArray(linkVAO);
    const linkBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, linkBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    const lU = { res: gl.getUniformLocation(linkProg, 'uRes'), xf: gl.getUniformLocation(linkProg, 'uXform'), color: gl.getUniformLocation(linkProg, 'uColor') };

    let cw = 0, ch = 0, dpr = 1;
    return {
      FLOATS, addAvatar, hasAvatar,
      resize(w, h, ratio) { dpr = ratio; cw = Math.round(w * dpr); ch = Math.round(h * dpr); canvas.width = cw; canvas.height = ch; },
      begin() { gl.viewport(0, 0, cw, ch); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); },
      links(verts, nLines, t, color) {
        if (!nLines) return;
        gl.useProgram(linkProg); gl.bindVertexArray(linkVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, linkBuf); gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
        gl.uniform2f(lU.res, cw, ch); gl.uniform3f(lU.xf, t.k * dpr, t.x * dpr, t.y * dpr); gl.uniform4fv(lU.color, color);
        gl.drawArrays(gl.LINES, 0, nLines * 2);
        gl.bindVertexArray(null);
      },
      nodes(inst, n, t, ring) {
        if (!n) return;
        gl.useProgram(nodeProg); gl.bindVertexArray(nodeVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, instBuf); gl.bufferData(gl.ARRAY_BUFFER, inst, gl.DYNAMIC_DRAW);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, atlas); gl.uniform1i(nU.atlas, 0);
        gl.uniform1f(nU.ring, ring || 0.0);
        gl.uniform2f(nU.res, cw, ch); gl.uniform3f(nU.xf, t.k * dpr, t.x * dpr, t.y * dpr);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
        gl.bindVertexArray(null);
      },
    };
  }
  root.GLRenderer = GLRenderer;
})(window);
