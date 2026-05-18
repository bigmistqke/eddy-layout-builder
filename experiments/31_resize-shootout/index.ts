// resize-shootout — compares 720p→270p downscale techniques on real
// camera VideoFrames. Each captured camera frame is run through every
// technique; per-method per-frame cost is recorded, and a sample of
// frames per method is encoded to AV1 270p for round-trip validation.

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  EncodedPacketSink,
  Input,
  Output,
  VideoSample,
  VideoSampleSource,
  WebMOutputFormat,
} from "mediabunny"
import { wait } from "../../src/utils"
import { reportResult, status } from "../harness/report"

const params = {
  sourceResolution: { width: 1280, height: 720 },
  targetResolution: { width: 480, height: 272 },
  targetFrames: 150,
  validateEncodeFrames: 30,
  codec: "av1" as const,
  bitratePerPixel: 0.1,
  targetFps: 30,
}

interface TechniqueResult {
  name: string
  setupMs: number
  samples: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  encodeFramesSubmitted: number
  encodeFramesEncoded: number
  encodeRoundTripDemuxed: number
  encodeRoundTripOk: boolean
  available: boolean
  skippedReason: string | null
  errors: string[]
}

interface Technique {
  name: string
  setup(): Promise<void>
  resize(frame: VideoFrame, timestampUs: number): Promise<VideoFrame>
  dispose(): void
}

function makeCreateImageBitmapTechnique(quality: "low" | "medium" | "high"): Technique {
  return {
    name: `createImageBitmap-${quality}`,
    async setup(): Promise<void> {},
    async resize(frame: VideoFrame, timestampUs: number): Promise<VideoFrame> {
      const bitmap = await createImageBitmap(frame, {
        resizeWidth: params.targetResolution.width,
        resizeHeight: params.targetResolution.height,
        resizeQuality: quality,
      })
      const out = new VideoFrame(bitmap, { timestamp: timestampUs })
      bitmap.close()
      return out
    },
    dispose(): void {},
  }
}

function makeCanvas2dWrapTechnique(): Technique {
  let canvas: OffscreenCanvas | null = null
  let context: OffscreenCanvasRenderingContext2D | null = null
  return {
    name: "canvas2d-wrap",
    async setup(): Promise<void> {
      canvas = new OffscreenCanvas(
        params.targetResolution.width,
        params.targetResolution.height,
      )
      const ctx = canvas.getContext("2d")
      if (ctx === null) {
        throw new Error("canvas2d-wrap: no 2d context")
      }
      ctx.imageSmoothingQuality = "low"
      context = ctx
    },
    async resize(frame: VideoFrame, timestampUs: number): Promise<VideoFrame> {
      if (canvas === null || context === null) {
        throw new Error("canvas2d-wrap: not set up")
      }
      context.drawImage(
        frame,
        0,
        0,
        params.targetResolution.width,
        params.targetResolution.height,
      )
      return new VideoFrame(canvas, { timestamp: timestampUs })
    },
    dispose(): void {
      canvas = null
      context = null
    },
  }
}

function makeCanvas2dTransferTechnique(): Technique {
  let canvas: OffscreenCanvas | null = null
  let context: OffscreenCanvasRenderingContext2D | null = null
  return {
    name: "canvas2d-transfer",
    async setup(): Promise<void> {
      canvas = new OffscreenCanvas(
        params.targetResolution.width,
        params.targetResolution.height,
      )
      const ctx = canvas.getContext("2d")
      if (ctx === null) {
        throw new Error("canvas2d-transfer: no 2d context")
      }
      ctx.imageSmoothingQuality = "low"
      context = ctx
    },
    async resize(frame: VideoFrame, timestampUs: number): Promise<VideoFrame> {
      if (canvas === null || context === null) {
        throw new Error("canvas2d-transfer: not set up")
      }
      context.drawImage(
        frame,
        0,
        0,
        params.targetResolution.width,
        params.targetResolution.height,
      )
      const bitmap = canvas.transferToImageBitmap()
      const out = new VideoFrame(bitmap, { timestamp: timestampUs })
      bitmap.close()
      return out
    },
    dispose(): void {
      canvas = null
      context = null
    },
  }
}

const WEBGL_VERTEX = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2((a_pos.x + 1.0) * 0.5, (1.0 - a_pos.y) * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`
const WEBGL_FRAGMENT = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 outColor;
void main() {
  outColor = texture(u_tex, v_uv);
}
`

function makeWebglTechnique(): Technique {
  let canvas: OffscreenCanvas | null = null
  let gl: WebGL2RenderingContext | null = null
  let texture: WebGLTexture | null = null
  return {
    name: "webgl",
    async setup(): Promise<void> {
      canvas = new OffscreenCanvas(
        params.targetResolution.width,
        params.targetResolution.height,
      )
      const ctx = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: true })
      if (ctx === null) {
        throw new Error("webgl: WebGL2 unavailable")
      }
      gl = ctx
      const vs = gl.createShader(gl.VERTEX_SHADER)
      if (vs === null) {
        throw new Error("webgl: createShader vs")
      }
      gl.shaderSource(vs, WEBGL_VERTEX)
      gl.compileShader(vs)
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
        throw new Error(`webgl: vs compile ${gl.getShaderInfoLog(vs) ?? ""}`)
      }
      const fs = gl.createShader(gl.FRAGMENT_SHADER)
      if (fs === null) {
        throw new Error("webgl: createShader fs")
      }
      gl.shaderSource(fs, WEBGL_FRAGMENT)
      gl.compileShader(fs)
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        throw new Error(`webgl: fs compile ${gl.getShaderInfoLog(fs) ?? ""}`)
      }
      const program = gl.createProgram()
      if (program === null) {
        throw new Error("webgl: createProgram")
      }
      gl.attachShader(program, vs)
      gl.attachShader(program, fs)
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`webgl: link ${gl.getProgramInfoLog(program) ?? ""}`)
      }
      gl.useProgram(program)

      const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])
      const buf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)
      const aPos = gl.getAttribLocation(program, "a_pos")
      gl.enableVertexAttribArray(aPos)
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

      texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

      gl.viewport(0, 0, params.targetResolution.width, params.targetResolution.height)
    },
    async resize(frame: VideoFrame, timestampUs: number): Promise<VideoFrame> {
      if (gl === null || canvas === null || texture === null) {
        throw new Error("webgl: not set up")
      }
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      gl.finish()
      return new VideoFrame(canvas, { timestamp: timestampUs })
    },
    dispose(): void {
      gl = null
      texture = null
      canvas = null
    },
  }
}

interface WebGPUNavigator {
  gpu?: {
    requestAdapter(): Promise<{
      requestDevice(): Promise<unknown>
    } | null>
  }
}

function isWebGPUAvailable(): boolean {
  return (navigator as unknown as WebGPUNavigator).gpu !== undefined
}

function makeWebgpuTechnique(): Technique {
  let canvas: OffscreenCanvas | null = null
  let device: GPUDevice | null = null
  let context: GPUCanvasContext | null = null
  let pipeline: GPURenderPipeline | null = null
  let sampler: GPUSampler | null = null
  return {
    name: "webgpu",
    async setup(): Promise<void> {
      const navGpu = (navigator as unknown as { gpu: GPU }).gpu
      if (navGpu === undefined) {
        throw new Error("webgpu: navigator.gpu unavailable")
      }
      const adapter = await navGpu.requestAdapter()
      if (adapter === null) {
        throw new Error("webgpu: no adapter")
      }
      device = await adapter.requestDevice()
      canvas = new OffscreenCanvas(
        params.targetResolution.width,
        params.targetResolution.height,
      )
      const ctx = canvas.getContext("webgpu") as GPUCanvasContext | null
      if (ctx === null) {
        throw new Error("webgpu: no canvas context")
      }
      context = ctx
      const format = navGpu.getPreferredCanvasFormat()
      context.configure({ device, format, alphaMode: "premultiplied" })

      const shader = device.createShaderModule({
        code: `
          struct VertexOutput {
            @builtin(position) position: vec4f,
            @location(0) uv: vec2f,
          };
          @vertex
          fn vs(@builtin(vertex_index) index: u32) -> VertexOutput {
            var pos = array<vec2f, 4>(
              vec2f(-1.0, -1.0),
              vec2f( 1.0, -1.0),
              vec2f(-1.0,  1.0),
              vec2f( 1.0,  1.0),
            );
            var uv = array<vec2f, 4>(
              vec2f(0.0, 1.0),
              vec2f(1.0, 1.0),
              vec2f(0.0, 0.0),
              vec2f(1.0, 0.0),
            );
            var out: VertexOutput;
            out.position = vec4f(pos[index], 0.0, 1.0);
            out.uv = uv[index];
            return out;
          }
          @group(0) @binding(0) var s: sampler;
          @group(0) @binding(1) var t: texture_external;
          @fragment
          fn fs(in: VertexOutput) -> @location(0) vec4f {
            return textureSampleBaseClampToEdge(t, s, in.uv);
          }
        `,
      })
      pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module: shader, entryPoint: "vs" },
        fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
        primitive: { topology: "triangle-strip" },
      })
      sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" })
    },
    async resize(frame: VideoFrame, timestampUs: number): Promise<VideoFrame> {
      if (device === null || context === null || pipeline === null || sampler === null || canvas === null) {
        throw new Error("webgpu: not set up")
      }
      const externalTexture = device.importExternalTexture({ source: frame })
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: externalTexture },
        ],
      })
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.draw(4, 1, 0, 0)
      pass.end()
      device.queue.submit([encoder.finish()])
      // Block until GPU done so the per-frame timing reflects total cost.
      await device.queue.onSubmittedWorkDone()
      return new VideoFrame(canvas, { timestamp: timestampUs })
    },
    dispose(): void {
      device = null
      context = null
      pipeline = null
      sampler = null
      canvas = null
    },
  }
}

interface PerTechniqueState {
  timings: number[]
  setupMs: number
  available: boolean
  skippedReason: string | null
  encoderRig: {
    output: Output
    source: VideoSampleSource
    pendingAdds: number
    framesSubmitted: number
    framesEncoded: number
    errors: string[]
  } | null
  errors: string[]
}

async function makeEncoderRig(): Promise<PerTechniqueState["encoderRig"]> {
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() })
  const bitrate = Math.round(
    params.targetResolution.width *
      params.targetResolution.height *
      params.targetFps *
      params.bitratePerPixel,
  )
  const source = new VideoSampleSource({ codec: params.codec, bitrate })
  output.addVideoTrack(source)
  await output.start()
  return {
    output,
    source,
    pendingAdds: 0,
    framesSubmitted: 0,
    framesEncoded: 0,
    errors: [],
  }
}

async function run(): Promise<void> {
  status(`resize-shootout: ${params.targetFrames} frames @ ${params.sourceResolution.width}×${params.sourceResolution.height} → ${params.targetResolution.width}×${params.targetResolution.height}`)
  status("opening camera…")
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: params.sourceResolution.width,
      height: params.sourceResolution.height,
    },
    audio: false,
  })
  const [track] = stream.getVideoTracks()
  if (track === undefined) {
    throw new Error("run: no camera track")
  }
  const settings = track.getSettings()
  status(`  camera native ${settings.width}×${settings.height} @ ${settings.frameRate ?? "?"} fps`)

  const techniques: Technique[] = [
    makeCreateImageBitmapTechnique("low"),
    makeCreateImageBitmapTechnique("medium"),
    makeCreateImageBitmapTechnique("high"),
    makeCanvas2dWrapTechnique(),
    makeCanvas2dTransferTechnique(),
    makeWebglTechnique(),
  ]
  if (isWebGPUAvailable()) {
    techniques.push(makeWebgpuTechnique())
  } else {
    status("  webgpu: navigator.gpu unavailable — skipping")
  }

  const states = new Map<string, PerTechniqueState>()
  for (const t of techniques) {
    status(`setup: ${t.name}`)
    const start = performance.now()
    try {
      await t.setup()
      const encoderRig = await makeEncoderRig()
      states.set(t.name, {
        timings: [],
        setupMs: performance.now() - start,
        available: true,
        skippedReason: null,
        encoderRig,
        errors: [],
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      states.set(t.name, {
        timings: [],
        setupMs: performance.now() - start,
        available: false,
        skippedReason: message,
        encoderRig: null,
        errors: [message],
      })
      status(`  ${t.name}: setup failed — ${message}`)
    }
  }

  const Ctor = (window as unknown as {
    MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => {
      readable: ReadableStream<VideoFrame>
    }
  }).MediaStreamTrackProcessor
  const processor = new Ctor({ track })
  const reader = processor.readable.getReader()

  let framesCaptured = 0
  while (framesCaptured < params.targetFrames) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }
    framesCaptured++
    const timestampUs = value.timestamp
    for (const t of techniques) {
      const state = states.get(t.name)
      if (state === undefined || !state.available) {
        continue
      }
      const start = performance.now()
      try {
        const out = await t.resize(value, timestampUs)
        const ms = performance.now() - start
        state.timings.push(ms)
        // Encode the first validateEncodeFrames frames to test round-trip.
        if (
          state.encoderRig !== null &&
          state.encoderRig.framesSubmitted < params.validateEncodeFrames
        ) {
          const sample = new VideoSample(out)
          state.encoderRig.framesSubmitted++
          state.encoderRig.pendingAdds++
          const rig = state.encoderRig
          rig.source
            .add(sample)
            .then(() => {
              rig.framesEncoded++
            })
            .catch((error: unknown) => {
              rig.errors.push(error instanceof Error ? error.message : String(error))
            })
            .finally(() => {
              rig.pendingAdds--
              sample.close()
            })
        } else {
          out.close()
        }
      } catch (error) {
        state.errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    value.close()
    if (framesCaptured % 30 === 0) {
      status(`  captured ${framesCaptured}/${params.targetFrames}`)
    }
  }
  try {
    reader.releaseLock()
  } catch {}
  try {
    track.stop()
  } catch {}

  // Drain + finalize every encoder, then verify round-trip.
  const results: TechniqueResult[] = []
  for (const t of techniques) {
    const state = states.get(t.name)
    if (state === undefined) {
      continue
    }
    let encodeRoundTripDemuxed = 0
    let encodeRoundTripOk = false
    let encodeFramesEncoded = 0
    let encodeFramesSubmitted = 0
    if (state.encoderRig !== null) {
      const rig = state.encoderRig
      const drainStart = performance.now()
      while (rig.pendingAdds > 0) {
        await wait(10)
        if (performance.now() - drainStart > 30_000) {
          rig.errors.push(`drain: still ${rig.pendingAdds} pending`)
          break
        }
      }
      rig.source.close()
      try {
        await rig.output.finalize()
      } catch (error) {
        rig.errors.push(`finalize: ${error instanceof Error ? error.message : String(error)}`)
      }
      const buffer = (rig.output.target as BufferTarget).buffer
      if (buffer !== null) {
        try {
          const blob = new Blob([buffer], { type: "video/webm" })
          const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
          const videoTracks = await input.getVideoTracks()
          const videoTrack = videoTracks[0] ?? null
          if (videoTrack !== null) {
            const sink = new EncodedPacketSink(videoTrack)
            for await (const _packet of sink.packets()) {
              encodeRoundTripDemuxed++
            }
            encodeRoundTripOk = encodeRoundTripDemuxed === rig.framesEncoded
          }
        } catch (error) {
          rig.errors.push(`roundtrip: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      encodeFramesEncoded = rig.framesEncoded
      encodeFramesSubmitted = rig.framesSubmitted
      state.errors.push(...rig.errors)
    }
    t.dispose()
    const sorted = state.timings.slice().sort((a, b) => a - b)
    const p50Idx = Math.floor(sorted.length * 0.5)
    const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
    results.push({
      name: t.name,
      setupMs: state.setupMs,
      samples: state.timings.length,
      p50Ms: sorted.length > 0 ? sorted[p50Idx] : 0,
      p95Ms: sorted.length > 0 ? sorted[p95Idx] : 0,
      maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
      encodeFramesSubmitted,
      encodeFramesEncoded,
      encodeRoundTripDemuxed,
      encodeRoundTripOk,
      available: state.available,
      skippedReason: state.skippedReason,
      errors: state.errors,
    })
    status(
      `  ${t.name.padEnd(28)} p50=${sorted.length > 0 ? sorted[p50Idx].toFixed(2) : "-"}ms p95=${sorted.length > 0 ? sorted[p95Idx].toFixed(2) : "-"}ms max=${sorted.length > 0 ? sorted[sorted.length - 1].toFixed(2) : "-"}ms roundTrip=${encodeRoundTripOk ? "ok" : "FAIL"}`,
    )
  }

  status("done.")
  reportResult("resize-shootout", params, {
    cameraSettings: {
      width: settings.width ?? null,
      height: settings.height ?? null,
      frameRate: settings.frameRate ?? null,
    },
    framesCaptured,
    techniques: results,
  })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("resize-shootout", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
