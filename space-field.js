(() => {
  const canvas = document.getElementById('space-field');
  if (!canvas) return;

  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    powerPreference: 'low-power'
  });
  if (!gl) {
    document.documentElement.classList.add('space-field-fallback');
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
    uniform vec2 u_resolution;
    uniform vec2 u_pointer;
    uniform float u_time;
    in vec2 v_uv;
    out vec4 out_color;

    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 345.45));
      p += dot(p, p + 34.345);
      return fract(p.x * p.y);
    }

    float valueNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash21(i);
      float b = hash21(i + vec2(1.0, 0.0));
      float c = hash21(i + vec2(0.0, 1.0));
      float d = hash21(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    float fbm(vec2 p) {
      float value = 0.0;
      float amplitude = 0.52;
      mat2 turn = mat2(1.62, 1.18, -1.18, 1.62);
      for (int i = 0; i < 5; i++) {
        value += valueNoise(p) * amplitude;
        p = turn * p + vec2(13.7, 7.9);
        amplitude *= 0.48;
      }
      return value;
    }

    float starLayer(vec2 uv, float scale, float density, float speed, float seed) {
      vec2 p = uv * scale + vec2(u_time * speed, -u_time * speed * 0.37);
      vec2 cell = floor(p);
      vec2 local = fract(p);
      float random = hash21(cell + seed);
      float visible = smoothstep(1.0 - density, 1.0, random);
      vec2 star = vec2(hash21(cell + seed + 11.3), hash21(cell + seed + 41.7));
      float distanceToStar = length(local - star);
      float size = mix(0.018, 0.074, hash21(cell + seed + 73.1));
      float core = 1.0 - smoothstep(size * 0.16, size, distanceToStar);
      float twinkle = 0.58 + 0.42 * sin(u_time * (1.1 + random * 2.8) + random * 67.0);
      return core * visible * twinkle * (0.55 + random * 0.9);
    }

    void main() {
      float time = mod(u_time, 900.0);
      float aspect = u_resolution.x / max(u_resolution.y, 1.0);
      vec2 p = (v_uv - 0.5) * vec2(aspect, 1.0);
      vec2 camera = u_pointer * 0.045;
      vec2 warped = p + vec2(
        sin(p.y * 2.1 + time * 0.018) * 0.065,
        cos(p.x * 1.7 - time * 0.014) * 0.055
      );
      float cloudA = fbm(warped * 2.15 + vec2(time * 0.006, -time * 0.004) + camera * 0.35);
      float cloudB = fbm(warped * 4.0 + vec2(-time * 0.009, time * 0.005) + camera * 0.65);
      float clouds = smoothstep(0.36, 0.84, cloudA * 0.68 + cloudB * 0.32);

      vec3 color = vec3(0.008, 0.010, 0.025);
      float violetCloud = exp(-dot((p - vec2(-0.48, 0.18)) * vec2(1.45, 2.05), (p - vec2(-0.48, 0.18)) * vec2(1.45, 2.05)) * 1.55);
      float blueCloud = exp(-dot((p - vec2(0.50, -0.24)) * vec2(1.8, 1.65), (p - vec2(0.50, -0.24)) * vec2(1.8, 1.65)) * 1.75);
      float centralCloud = exp(-dot((p - vec2(0.04, 0.24)) * vec2(1.0, 2.6), (p - vec2(0.04, 0.24)) * vec2(1.0, 2.6)) * 1.65);
      color += vec3(0.090, 0.030, 0.195) * violetCloud * (0.48 + clouds * 0.85);
      color += vec3(0.018, 0.064, 0.155) * blueCloud * (0.36 + cloudB * 0.8);
      color += vec3(0.060, 0.026, 0.135) * centralCloud * clouds * 0.68;

      float dust = smoothstep(0.33, 0.88, cloudA * 0.58 + cloudB * 0.42);
      color += vec3(0.045, 0.025, 0.090) * dust * clouds;

      float farStars = starLayer(p + camera * 0.45, 112.0, 0.040, 0.003, 2.1);
      float midStars = starLayer(p + camera * 1.0, 72.0, 0.060, 0.008, 19.7);
      float nearStars = starLayer(p + camera * 1.85, 188.0, 0.014, 0.018, 53.2);
      color += vec3(0.48, 0.54, 0.82) * farStars * 0.62;
      color += vec3(0.74, 0.69, 1.0) * midStars * 0.86;
      color += vec3(0.83, 0.82, 1.0) * nearStars * 1.15;

      float vignette = 1.0 - smoothstep(0.15, 1.3, length(p * vec2(0.78, 0.92)));
      color *= 0.55 + vignette * 0.45;
      out_color = vec4(color, 1.0);
    }`;

  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(message || 'WebGL shader compilation failed.');
    }
    return shader;
  };

  try {
    const program = gl.createProgram();
    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || 'WebGL program linking failed.');
    }
    gl.useProgram(program);

    const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const resolution = gl.getUniformLocation(program, 'u_resolution');
    const pointer = gl.getUniformLocation(program, 'u_pointer');
    const clock = gl.getUniformLocation(program, 'u_time');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const pointerTarget = { x: 0, y: 0 };
    const pointerSmooth = { x: 0, y: 0 };
    let frame = 0;
    let lastFrameTime = 0;
    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 1);
      const width = Math.max(1, Math.round(window.innerWidth * ratio));
      const height = Math.max(1, Math.round(window.innerHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
      gl.uniform2f(resolution, width, height);
    };
    window.addEventListener('pointermove', (event) => {
      pointerTarget.x = (event.clientX / Math.max(window.innerWidth, 1) - 0.5) * 2;
      pointerTarget.y = (0.5 - event.clientY / Math.max(window.innerHeight, 1)) * 2;
    }, { passive: true });

    const draw = (now) => {
      if (!reducedMotion.matches && now - lastFrameTime < 1000 / 30) {
        frame = requestAnimationFrame(draw);
        return;
      }
      lastFrameTime = now;
      pointerSmooth.x += (pointerTarget.x - pointerSmooth.x) * 0.025;
      pointerSmooth.y += (pointerTarget.y - pointerSmooth.y) * 0.025;
      gl.uniform2f(pointer, pointerSmooth.x, pointerSmooth.y);
      gl.uniform1f(clock, reducedMotion.matches ? 0.0 : now * 0.001);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (!reducedMotion.matches && !document.hidden) frame = requestAnimationFrame(draw);
    };

    const start = () => {
      cancelAnimationFrame(frame);
      lastFrameTime = 0;
      resize();
      draw(performance.now());
    };
    const stop = () => cancelAnimationFrame(frame);
    window.addEventListener('resize', () => {
      resize();
      if (reducedMotion.matches) draw(performance.now());
    }, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else start();
    });
    reducedMotion.addEventListener?.('change', start);
    start();
  } catch (error) {
    console.warn('Space background unavailable:', error);
    document.documentElement.classList.add('space-field-fallback');
  }
})();
