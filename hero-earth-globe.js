(() => {
  const canvas = document.getElementById('hero-globe-canvas');
  if (!canvas) return;
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true });
  if (!gl) {
    canvas.closest('.earth')?.classList.add('earth-fallback');
    return;
  }

  const vertexSource = `#version 300 es
    in vec2 a_position;
    out vec2 v_uv;
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }`;
  const fragmentSource = `#version 300 es
    precision highp float;
    uniform sampler2D u_map;
    uniform float u_rotation;
    in vec2 v_uv;
    out vec4 out_color;
    const float PI = 3.141592653589793;
    vec3 geoPoint(float latitude, float longitude) {
      float cosLat = cos(latitude);
      return vec3(cosLat * sin(longitude), sin(latitude), cosLat * cos(longitude));
    }
    float arcDistance(vec3 point, vec3 a, vec3 b) {
      vec3 planeNormal = cross(a, b);
      float normalLength = length(planeNormal);
      if (normalLength < 0.00001) {
        return min(length(point - a), length(point - b));
      }
      planeNormal /= normalLength;
      float side = dot(point, planeNormal);
      vec3 projected = point - planeNormal * side;
      float projectedLength = length(projected);
      if (projectedLength < 0.00001) {
        return min(length(point - a), length(point - b));
      }
      vec3 nearest = projected / projectedLength;
      float beforeStart = dot(cross(a, nearest), planeNormal);
      float pastEnd = dot(cross(nearest, b), planeNormal);
      if (beforeStart < -0.00001 || pastEnd < -0.00001) {
        nearest = -nearest;
        beforeStart = dot(cross(a, nearest), planeNormal);
        pastEnd = dot(cross(nearest, b), planeNormal);
        if (beforeStart < -0.00001 || pastEnd < -0.00001) {
          return min(length(point - a), length(point - b));
        }
      }
      // For the narrow route widths below, |sin(angle)| is visually equal to
      // the angular distance and avoids expensive per-pixel inverse trig.
      return abs(side);
    }
    void main() {
      vec2 p = vec2(v_uv.x * 2.0 - 1.0, 1.0 - v_uv.y * 2.0);
      float r2 = dot(p, p);
      if (r2 > 1.0) { out_color = vec4(0.0); return; }
      float z = sqrt(max(0.0, 1.0 - r2));
      vec3 n = normalize(vec3(p.x, p.y, z));
      float longitude = atan(n.x, n.z) + u_rotation;
      float latitude = asin(clamp(n.y, -1.0, 1.0));
      vec2 uv = vec2(fract(longitude / (2.0 * PI) + 0.5), latitude / PI + 0.5);
      vec3 raw = texture(u_map, uv).rgb;
      float luminance = dot(raw, vec3(0.2126, 0.7152, 0.0722));
      vec3 softened = mix(raw, vec3(luminance), 0.38);
      vec3 surface = softened * vec3(1.08, 0.96, 1.22) + vec3(0.035, 0.025, 0.07);
      vec3 light_dir = normalize(vec3(-0.48, 0.28, 0.83));
      float light = max(dot(n, light_dir), 0.0);
      float day = smoothstep(-0.20, 0.24, dot(n, light_dir));
      vec3 color = surface * (0.26 + 0.92 * light);
      float atmosphere = pow(1.0 - z, 2.5);
      color += vec3(0.40, 0.27, 0.68) * atmosphere * 0.62;
      color *= mix(0.42, 1.0, day);

      // Draw the payment network in the same geographic coordinates as the
      // texture, so each arc stays on the rotating sphere instead of sliding
      // across it as a separate flat overlay.
      vec3 globePoint = geoPoint(latitude, longitude);
      vec3 london = geoPoint(radians(51.51), radians(-0.12));
      vec3 newYork = geoPoint(radians(40.71), radians(-74.01));
      vec3 saoPaulo = geoPoint(radians(-23.55), radians(-46.63));
      vec3 lagos = geoPoint(radians(6.52), radians(3.38));
      vec3 dubai = geoPoint(radians(25.20), radians(55.27));
      vec3 singapore = geoPoint(radians(1.35), radians(103.82));
      vec3 tokyo = geoPoint(radians(35.68), radians(139.69));
      float routeDistance = arcDistance(globePoint, london, newYork);
      routeDistance = min(routeDistance, arcDistance(globePoint, london, saoPaulo));
      routeDistance = min(routeDistance, arcDistance(globePoint, london, lagos));
      routeDistance = min(routeDistance, arcDistance(globePoint, london, dubai));
      routeDistance = min(routeDistance, arcDistance(globePoint, dubai, singapore));
      routeDistance = min(routeDistance, arcDistance(globePoint, singapore, tokyo));
      float routeGlow = 1.0 - smoothstep(0.012, 0.050, routeDistance);
      float routeLine = 1.0 - smoothstep(0.004, 0.010, routeDistance);
      color += vec3(0.42, 0.24, 0.82) * routeGlow * 0.34;
      color = mix(color, vec3(0.88, 0.78, 1.0), routeLine * 0.72);
      float nodeDistance = min(min(length(globePoint - london), length(globePoint - newYork)), length(globePoint - saoPaulo));
      nodeDistance = min(nodeDistance, min(min(length(globePoint - lagos), length(globePoint - dubai)), min(length(globePoint - singapore), length(globePoint - tokyo))));
      float nodeGlow = 1.0 - smoothstep(0.012, 0.050, nodeDistance);
      float nodeCore = 1.0 - smoothstep(0.007, 0.014, nodeDistance);
      color += vec3(0.56, 0.31, 0.98) * nodeGlow * 0.48;
      color = mix(color, vec3(0.97, 0.90, 1.0), nodeCore * 0.78);
      float edge = smoothstep(0.0, 0.018, 1.0 - r2);
      out_color = vec4(color * edge, edge);
    }`;

  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);

  const vertices = new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const map = new Image();
  map.onload = () => {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, map);
    requestAnimationFrame(draw);
  };
  map.onerror = () => canvas.closest('.earth')?.classList.add('earth-fallback');
  map.src = 'earth-global-texture.webp';

  const rotation = gl.getUniformLocation(program, 'u_rotation');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let startTime = null;
  let frame = 0;
  let angle = 0;
  function resize() {
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(window.devicePixelRatio || 1, 1.5);
    const size = Math.max(1, Math.round(Math.min(rect.width, rect.height) * scale));
    if (canvas.width !== size || canvas.height !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  function draw(now) {
    cancelAnimationFrame(frame);
    resize();
    if (!reducedMotion.matches && !document.hidden) {
      if (startTime === null) startTime = now;
      angle = ((now - startTime) / 40000) * (2.0 * Math.PI);
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(rotation, angle);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (!reducedMotion.matches && !document.hidden) frame = requestAnimationFrame(draw);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !reducedMotion.matches) frame = requestAnimationFrame(draw);
  });
  reducedMotion.addEventListener?.('change', () => {
    if (!reducedMotion.matches && !document.hidden) frame = requestAnimationFrame(draw);
    else draw(performance.now());
  });
})();
