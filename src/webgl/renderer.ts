import { view } from "@bigmistqke/view.gl"
import { compile } from "@bigmistqke/view.gl/tag"
import type { BitmapFrame } from "../media/bitmap-source"
import type { LeafFrame } from "../viewport"
import {
  FRAGMENT_SHADER,
  VERTEX_SHADER,
  VIDEO_FRAGMENT_SHADER,
  VIDEO_VERTEX_SHADER,
} from "./shaders"

export type ViewportState = { x: number; y: number; scale: number }
export type TextureSource = BitmapFrame

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

export interface Renderer {
  render(
    viewport: ViewportState,
    leaves: LeafFrame[],
    frames?: ReadonlyMap<string, TextureSource>,
  ): void
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

  // ---- Video program: compile from glsl tag, attached views typed
  //      automatically from the tagged-template slots. ----
  const { program: videoProgram, view: videoView } = compile(
    gl,
    VIDEO_VERTEX_SHADER,
    VIDEO_FRAGMENT_SHADER,
    { webgl2: true },
  )
  const videoUniforms = videoView.uniforms
  const videoAttributes = videoView.attributes

  const videoTexture = gl.createTexture()
  if (videoTexture === null) {
    throw new Error("createTexture returned null")
  }
  gl.bindTexture(gl.TEXTURE_2D, videoTexture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  // Same unit-quad corners as the color program (TRIANGLE_STRIP: BL, BR, TL, TR).
  videoAttributes.a_corner.set(new Float32Array([0, 1, 1, 1, 0, 0, 1, 0])).bind()

  // Reusable per-leaf single-instance buffers.
  const videoPositionBuffer = new Float32Array(2)
  const videoSizeBuffer = new Float32Array(2)

  function ensureBufferSize(count: number) {
    if (positionBuffer.length < count * 2) {
      positionBuffer = new Float32Array(count * 2)
      sizeBuffer = new Float32Array(count * 2)
      colorBuffer = new Float32Array(count * 3)
    }
  }

  function render(
    viewport: ViewportState,
    leaves: LeafFrame[],
    frames?: ReadonlyMap<string, TextureSource>,
  ) {
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    if (leaves.length === 0) {
      return
    }

    // Snap each leaf's POST-TRANSLATE left/right/top/bottom to whole
    // CSS pixels — i.e. snap the SUM `rect + viewport.translate`, not
    // the parts separately. Snapping rect and translate independently
    // can produce a 1px mismatch when both fractional parts round up.
    // We bake the translate into i_position here and pass u_view.xy=0.
    // CSS handle overlay does `Math.round(rect.x + viewport.x)` to
    // match.
    const snap = Math.round
    ensureBufferSize(leaves.length)
    for (let index = 0; index < leaves.length; index++) {
      const leaf = leaves[index]
      const left = snap(leaf.rect.x + viewport.x)
      const top = snap(leaf.rect.y + viewport.y)
      const right = snap(leaf.rect.x + leaf.rect.width + viewport.x)
      const bottom = snap(leaf.rect.y + leaf.rect.height + viewport.y)
      positionBuffer[index * 2] = left
      positionBuffer[index * 2 + 1] = top
      sizeBuffer[index * 2] = right - left
      sizeBuffer[index * 2 + 1] = bottom - top
      colorBuffer[index * 3] = leaf.color[0]
      colorBuffer[index * 3 + 1] = leaf.color[1]
      colorBuffer[index * 3 + 2] = leaf.color[2]
    }

    gl.useProgram(program)

    attributes.a_corner.bind()
    attributes.i_position.set(positionBuffer.subarray(0, leaves.length * 2)).bind()
    attributes.i_size.set(sizeBuffer.subarray(0, leaves.length * 2)).bind()
    attributes.i_color.set(colorBuffer.subarray(0, leaves.length * 3)).bind()

    // u_canvasSize in CSS pixels (matches snapped leaf rects). Translate
    // is baked into i_position above.
    uniforms.u_canvasSize.set(cssWidth, cssHeight)
    uniforms.u_view.set(0, 0, viewport.scale)

    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, leaves.length)

    // ---- Pass 2: video frames for leaves that have one ----
    if (frames === undefined || frames.size === 0) {
      return
    }

    gl.useProgram(videoProgram)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, videoTexture)
    videoUniforms.u_videoTexture.set(0)
    videoUniforms.u_canvasSize.set(cssWidth, cssHeight)
    videoUniforms.u_view.set(0, 0, viewport.scale)
    videoAttributes.a_corner.bind()

    for (let index = 0; index < leaves.length; index++) {
      const leaf = leaves[index]
      const source = frames.get(leaf.id)
      if (source === undefined) {
        continue
      }
      videoPositionBuffer[0] = positionBuffer[index * 2]
      videoPositionBuffer[1] = positionBuffer[index * 2 + 1]
      videoSizeBuffer[0] = sizeBuffer[index * 2]
      videoSizeBuffer[1] = sizeBuffer[index * 2 + 1]
      videoAttributes.i_position.set(videoPositionBuffer).bind()
      videoAttributes.i_size.set(videoSizeBuffer).bind()

      // Source's natural dimensions feed the cover-fit math in the
      // vertex shader (cell size is already there via i_size).
      videoUniforms.u_sourceSize.set(source.width, source.height)

      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        source.width,
        source.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        source.bytes,
      )
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1)
    }
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
    gl.deleteProgram(videoProgram)
    gl.deleteTexture(videoTexture)
  }

  return { render, resize, dispose }
}
