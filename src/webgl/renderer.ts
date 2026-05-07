import { view } from "@bigmistqke/view.gl"
import type { LeafFrame } from "../viewport"
import { FRAGMENT_SHADER, VERTEX_SHADER } from "./shaders"

export type ViewportState = { x: number; y: number; scale: number }

/** Convert "rgb(r, g, b)" or "#rrggbb" to [0..1, 0..1, 0..1]. */
function parseColor(input: string): [number, number, number] {
  const rgbMatch = input.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/)
  if (rgbMatch) {
    return [
      parseInt(rgbMatch[1], 10) / 255,
      parseInt(rgbMatch[2], 10) / 255,
      parseInt(rgbMatch[3], 10) / 255,
    ]
  }
  const hexMatch = input.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (hexMatch) {
    return [
      parseInt(hexMatch[1], 16) / 255,
      parseInt(hexMatch[2], 16) / 255,
      parseInt(hexMatch[3], 16) / 255,
    ]
  }
  return [0.5, 0.5, 0.5]
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)
  if (!shader) {
    throw new Error("createShader returned null")
  }
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "unknown"
    gl.deleteShader(shader)
    throw new Error(`Shader compile failed: ${log}`)
  }
  return shader
}

function linkProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader) {
  const program = gl.createProgram()
  if (!program) {
    throw new Error("createProgram returned null")
  }
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "unknown"
    gl.deleteProgram(program)
    throw new Error(`Program link failed: ${log}`)
  }
  return program
}

export type Renderer = {
  render(viewport: ViewportState, leaves: LeafFrame[]): void
  resize(width: number, height: number): void
  dispose(): void
}

/** Build a Renderer bound to `canvas`. WebGL2 required. */
export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const glOrNull = canvas.getContext("webgl2", { antialias: true, premultipliedAlpha: true })
  if (!glOrNull) {
    throw new Error("WebGL2 not supported")
  }
  const gl: WebGL2RenderingContext = glOrNull

  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
  const program = linkProgram(gl, vs, fs)

  const { uniforms, attributes } = view(gl, program, {
    uniforms: {
      u_canvasSize: { kind: "vec2" },
      u_view: { kind: "vec3" },
    },
    attributes: {
      a_corner: { kind: "vec2" },
      i_position: { kind: "vec2", instanced: true },
      i_size: { kind: "vec2", instanced: true },
      i_color: { kind: "vec3", instanced: true },
    },
    interleavedAttributes: {},
    buffers: {},
  })

  // Static unit-quad corners (TRIANGLE_STRIP order: BL, BR, TL, TR).
  attributes.a_corner.set(new Float32Array([0, 1, 1, 1, 0, 0, 1, 0])).bind()

  // Reusable per-instance buffers; grown lazily.
  let positionBuffer = new Float32Array(0)
  let sizeBuffer = new Float32Array(0)
  let colorBuffer = new Float32Array(0)

  function ensureBufferSize(count: number) {
    if (positionBuffer.length < count * 2) {
      positionBuffer = new Float32Array(count * 2)
      sizeBuffer = new Float32Array(count * 2)
      colorBuffer = new Float32Array(count * 3)
    }
  }

  function render(viewport: ViewportState, leaves: LeafFrame[]) {
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    if (leaves.length === 0) {
      return
    }

    ensureBufferSize(leaves.length)
    for (let index = 0; index < leaves.length; index++) {
      const leaf = leaves[index]
      positionBuffer[index * 2] = leaf.rect.x
      positionBuffer[index * 2 + 1] = leaf.rect.y
      sizeBuffer[index * 2] = leaf.rect.width
      sizeBuffer[index * 2 + 1] = leaf.rect.height
      const [r, g, b] = parseColor(leaf.color)
      colorBuffer[index * 3] = r
      colorBuffer[index * 3 + 1] = g
      colorBuffer[index * 3 + 2] = b
    }

    gl.useProgram(program)

    attributes.a_corner.bind()
    attributes.i_position.set(positionBuffer.subarray(0, leaves.length * 2)).bind()
    attributes.i_size.set(sizeBuffer.subarray(0, leaves.length * 2)).bind()
    attributes.i_color.set(colorBuffer.subarray(0, leaves.length * 3)).bind()

    // u_canvasSize is in CSS pixels (matches leaf rects). The backing
    // buffer is DPR-scaled separately via gl.viewport — that takes care
    // of HiDPI sharpness without changing the coordinate system the
    // shader operates in.
    uniforms.u_canvasSize.set(cssWidth, cssHeight)
    uniforms.u_view.set(viewport.x, viewport.y, viewport.scale)

    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, leaves.length)
  }

  let cssWidth = 0
  let cssHeight = 0

  function resize(width: number, height: number) {
    const dpr = window.devicePixelRatio || 1
    cssWidth = width
    cssHeight = height
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    gl.viewport(0, 0, canvas.width, canvas.height)
  }

  function dispose() {
    gl.deleteProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
  }

  return { render, resize, dispose }
}
