import { attribute, glsl, uniform } from "@bigmistqke/view.gl/tag"

/** WebGL2 shaders for the frame renderer. One instanced quad per leaf
 *  entity. The vertex shader maps a unit corner [0,1]² × per-instance
 *  (position, size) to canvas-local pixels, applies the viewport
 *  transform, and converts to clip space. Fragment shader paints the
 *  per-instance color. */

export const VERTEX_SHADER = /* glsl */ `#version 300 es
in vec2 a_corner;
in vec2 i_position;
in vec2 i_size;
in vec3 i_color;
uniform vec2 u_canvasSize;
uniform vec3 u_view;
out vec3 v_color;

void main() {
  vec2 canvasPixel = (a_corner * i_size + i_position) * u_view.z + u_view.xy;
  vec2 ndc = (canvasPixel / u_canvasSize) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  v_color = i_color;
}
`

export const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision mediump float;
in vec3 v_color;
out vec4 outColor;

void main() {
  outColor = vec4(v_color, 1.0);
}
`

/** Vertex shader for the video program. Same canvas-pixel → NDC math
 *  as VERTEX_SHADER (so textured quads align with the color fallback
 *  underneath), but drops i_color and outputs v_uv. UVs come straight
 *  from a_corner — texImage2D from VideoFrame / HTMLVideoElement places
 *  (0,0) at the top-left of the image, matching a_corner's TL = (0,0). */
export const VIDEO_VERTEX_SHADER = glsl`#version 300 es
${attribute.vec2("a_corner")}
${attribute.vec2("i_position", { instanced: true })}
${attribute.vec2("i_size", { instanced: true })}
${uniform.vec2("u_canvasSize")}
${uniform.vec3("u_view")}
out vec2 v_uv;

void main() {
  vec2 canvasPixel = (a_corner * i_size + i_position) * u_view.z + u_view.xy;
  vec2 ndc = (canvasPixel / u_canvasSize) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  v_uv = a_corner;
}
`

/** Fragment shader for the video program. Samples u_videoTexture at v_uv. */
export const VIDEO_FRAGMENT_SHADER = glsl`#version 300 es
precision mediump float;
in vec2 v_uv;
${uniform.sampler2D("u_videoTexture")}
out vec4 outColor;

void main() {
  outColor = texture(u_videoTexture, v_uv);
}
`
