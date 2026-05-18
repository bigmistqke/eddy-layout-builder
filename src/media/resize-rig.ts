// src/media/resize-rig.ts
export interface ResizeRig {
  readonly width: number
  readonly height: number
  /** Downscale `source` into a fresh VideoFrame at the rig's target
   *  resolution. Uses gl.finish() + transferToImageBitmap so the
   *  returned VideoFrame is independent of the GL canvas and safe
   *  to feed into an async consumer (e.g. mediabunny fire-and-track). */
  resize(source: VideoFrame, timestampUs: number): VideoFrame
  /** Release the underlying GL canvas + texture. Idempotent. */
  dispose(): void
}

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2((a_pos.x + 1.0) * 0.5, (1.0 - a_pos.y) * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 outColor;
void main() {
  outColor = texture(u_tex, v_uv);
}
`

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (shader === null) {
    throw new Error("createResizeRig: createShader returned null")
  }
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "unknown"
    gl.deleteShader(shader)
    throw new Error(`createResizeRig: shader compile failed: ${log}`)
  }
  return shader
}

export function createResizeRig(width: number, height: number): ResizeRig {
  const canvas = new OffscreenCanvas(width, height)
  const glOrNull = canvas.getContext("webgl2", {
    antialias: false,
    premultipliedAlpha: true,
  })
  if (glOrNull === null) {
    throw new Error("createResizeRig: WebGL2 unavailable")
  }
  const gl: WebGL2RenderingContext = glOrNull
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
  const program = gl.createProgram()
  if (program === null) {
    throw new Error("createResizeRig: createProgram returned null")
  }
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`createResizeRig: link failed: ${gl.getProgramInfoLog(program) ?? ""}`)
  }
  gl.useProgram(program)

  const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(program, "a_pos")
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

  const texture = gl.createTexture()
  if (texture === null) {
    throw new Error("createResizeRig: createTexture returned null")
  }
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.viewport(0, 0, width, height)

  let disposed = false
  return {
    width,
    height,
    resize(source: VideoFrame, timestampUs: number): VideoFrame {
      if (disposed) {
        throw new Error("ResizeRig.resize: rig is disposed")
      }
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      gl.finish()
      const bitmap = canvas.transferToImageBitmap()
      const out = new VideoFrame(bitmap, { timestamp: timestampUs })
      bitmap.close()
      return out
    },
    dispose(): void {
      disposed = true
      gl.deleteTexture(texture)
      gl.deleteBuffer(buf)
      gl.deleteProgram(program)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
    },
  }
}
