import type { Rect } from '../../../shared/engine/layout'
import { leansToCursor, poseIsFlat, projectRect, quadBounds, tiltOf, tiltPoseAt, tiltViewAt, type TiltFocus, type TiltPoint } from '../../../shared/engine/tilt'
import type { Camera } from '../../../shared/engine/zoom'
import type { Project } from '../../../shared/types'
import { cardBody, cardExtent, type CardGeometry, type CardSpec } from './staticLayer'

/**
 * The 3D tilt (Project.tilt): the card (shadow, chrome, the recording and everything drawn on
 * it) is painted on a canvas of its own, then drawn onto the frame as one textured quad seen
 * in perspective. Canvas 2D has no perspective, so the quad is drawn with WebGL; the geometry
 * comes from shared/engine/tilt.ts. Without WebGL the card is drawn flat (with one warning).
 *
 * Each target canvas gets one card canvas and one WebGL context, made on its first tilted
 * frame and reused for every frame after (canvases only grow, buffers are preallocated). The
 * contexts are kept in a small pool keyed weakly by the target: browsers lose the oldest
 * context past about 16, and every export draws on a new canvas, so the least recently used
 * one is released instead, and those of canvases that are gone (looked for on every frame
 * while the pool is not empty). An export lets go of its own with releaseTilt when it is done.
 */

type Ctx = CanvasRenderingContext2D

/** A card being drawn for a tilted frame: draw it on `ctx`, then call drawTiltedCard. */
export interface TiltedCard {
  /** Where the card is painted (output coordinates, already cleared). */
  ctx: Ctx
  /** Output rectangle the card canvas holds (the card's whole extent, shadow included). */
  extent: Rect
  /** Where the corners of `extent` land in the frame. */
  quad: [TiltPoint, TiltPoint, TiltPoint, TiltPoint]
  warp: Warp
}

interface Warp {
  target: WeakRef<Ctx>
  card: HTMLCanvasElement
  cardCtx: Ctx
  view: HTMLCanvasElement
  gl: WebGLRenderingContext
  program: WebGLProgram
  buffer: WebGLBuffer
  texture: WebGLTexture
  /** Size the texture was last allocated at. */
  texW: number
  texH: number
  /** Four vertices of x, y, z, w (clip space) and u, v. */
  verts: Float32Array
}

const VERTEX = `
attribute vec4 aPos;
attribute vec2 aUv;
varying vec2 vUv;
void main() {
  gl_Position = aPos;
  vUv = aUv;
}`

// High precision: texture coordinates of a 4K card need more than mediump's 10 bits.
const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uTex;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(uTex, vUv);
}`

const MAX_WARPS = 4
/** Card canvases grow in steps of this many pixels, so a shrinking or growing card rarely reallocates. */
const GROW_STEP = 64

/** Strip order of the quad's corners (top-left, top-right, bottom-left, bottom-right) and their texture corners. */
const STRIP = [0, 1, 3, 2] as const
const STRIP_UV = [0, 0, 1, 0, 0, 1, 1, 1] as const

const warps: Warp[] = []
let unavailable = false
let warned = false
let probed: boolean | null = null

const CONTEXT_OPTIONS: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  failIfMajorPerformanceCaveat: false
}

function warnOnce(reason: string): void {
  if (warned) return
  warned = true
  console.warn(`3D tilt: ${reason}; the recording is drawn flat.`)
}

/** True when the 3D tilt can be drawn here (WebGL works); false means it is shown flat. */
export function tiltSupported(): boolean {
  if (unavailable || typeof document === 'undefined') return false
  if (warps.length) return true
  if (probed === null) {
    const c = document.createElement('canvas')
    c.width = c.height = 1
    const gl = c.getContext('webgl', CONTEXT_OPTIONS)
    probed = !!gl
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
  }
  return probed
}

function shader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const s = gl.createShader(type)
  if (!s) return null
  gl.shaderSource(s, source)
  gl.compileShader(s)
  if (gl.getShaderParameter(s, gl.COMPILE_STATUS)) return s
  console.warn('3D tilt shader:', gl.getShaderInfoLog(s))
  gl.deleteShader(s)
  return null
}

function createWarp(target: Ctx): Warp | null {
  const view = document.createElement('canvas')
  const gl = view.getContext('webgl', CONTEXT_OPTIONS)
  if (!gl) return null
  const made = setUp(target, view, gl)
  if (!made) gl.getExtension('WEBGL_lose_context')?.loseContext()
  return made
}

function setUp(target: Ctx, view: HTMLCanvasElement, gl: WebGLRenderingContext): Warp | null {
  const vs = shader(gl, gl.VERTEX_SHADER, VERTEX)
  const fs = shader(gl, gl.FRAGMENT_SHADER, FRAGMENT)
  const program = gl.createProgram()
  const buffer = gl.createBuffer()
  const texture = gl.createTexture()
  const card = document.createElement('canvas')
  const cardCtx = card.getContext('2d')
  if (!vs || !fs || !program || !buffer || !texture || !cardCtx) return null
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('3D tilt program:', gl.getProgramInfoLog(program))
    return null
  }
  gl.useProgram(program)
  const verts = new Float32Array(4 * 6)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, verts.byteLength, gl.DYNAMIC_DRAW)
  const aPos = gl.getAttribLocation(program, 'aPos')
  const aUv = gl.getAttribLocation(program, 'aUv')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 4, gl.FLOAT, false, 24, 0)
  gl.enableVertexAttribArray(aUv)
  gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 24, 16)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.uniform1i(gl.getUniformLocation(program, 'uTex'), 0)
  // Bilinear sampling of a card with a transparent margin: smooth, anti-aliased edges.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  // The 2D canvas is premultiplied already: upload it as is, colours untouched.
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
  gl.disable(gl.BLEND)
  gl.clearColor(0, 0, 0, 0)
  return { target: new WeakRef(target), card, cardCtx, view, gl, program, buffer, texture, texW: 0, texH: 0, verts }
}

function release(w: Warp): void {
  w.gl.getExtension('WEBGL_lose_context')?.loseContext()
  w.card.width = w.card.height = 0
  w.view.width = w.view.height = 0
}

/**
 * Releases the warps whose canvas is gone or whose context the GPU dropped (made again on the
 * next tilted frame) and returns the one of `target`, if any, moved to the most recently used end.
 */
function sweep(target: Ctx | null): Warp | null {
  let found: Warp | null = null
  for (let i = warps.length - 1; i >= 0; i--) {
    const w = warps[i]
    const t = w.target.deref()
    if (!t || w.gl.isContextLost()) {
      release(w)
      warps.splice(i, 1)
    } else if (t === target) {
      found = w
      if (i !== warps.length - 1) {
        warps.splice(i, 1)
        warps.push(w)
      }
    }
  }
  return found
}

/**
 * Lets go of the WebGL context and card canvas the tilt keeps for `target` (an export or
 * thumbnail canvas that is done), instead of holding them until the pool needs room.
 */
export function releaseTilt(target: Ctx): void {
  const i = warps.findIndex((w) => w.target.deref() === target)
  if (i >= 0) release(warps.splice(i, 1)[0])
}

/** The card canvas and WebGL context of `target`, made on first use; null without WebGL. */
function warpFor(target: Ctx): Warp | null {
  if (!unavailable && typeof document === 'undefined') unavailable = true
  if (unavailable) {
    warnOnce('WebGL is not available')
    return null
  }
  const found = sweep(target)
  if (found) return found
  const made = createWarp(target)
  if (!made) {
    unavailable = true
    warnOnce('WebGL is not available')
    return null
  }
  if (warps.length >= MAX_WARPS) release(warps.shift()!)
  warps.push(made)
  return made
}

/**
 * Starts a tilted frame: when `project` has its tilt on and the pose at `t` is not flat (the
 * 'zoom' animation can flatten it completely) or the card leans toward the cursor, returns the
 * cleared card canvas to paint the card on, in output coordinates, and where it will land.
 * Null means: draw the frame flat.
 */
export function beginTiltedCard(target: Ctx, w: number, h: number, t: number, project: Project, cam: Camera, focus: TiltFocus | null, spec: CardSpec, geom: CardGeometry): TiltedCard | null {
  const tilt = tiltOf(project)
  if (!tilt) {
    // Frames without a tilt let go of the contexts of canvases that are gone (none kept: nothing to do).
    if (warps.length) sweep(null)
    return null
  }
  const pose = tiltPoseAt(tilt, t, cam, focus)
  const leaning = leansToCursor(tilt, focus)
  // A flat pose is the flat card; one leaning toward the cursor keeps its leaning size even then.
  if (poseIsFlat(pose) && !leaning) return null
  const warp = warpFor(target)
  if (!warp) return null
  const extent = cardExtent(spec, geom)
  // Tilted, the card keeps the style's padding from the frame's edges (as far as the flat card
  // does); leaning toward the cursor, it keeps one size.
  const view = tiltViewAt(tilt, pose, leaning, cardBody(spec, geom), w, h, spec.style.padding * Math.min(w, h))
  const { card, cardCtx } = warp
  if (card.width < extent.w || card.height < extent.h) {
    card.width = Math.max(card.width, Math.ceil(extent.w / GROW_STEP) * GROW_STEP)
    card.height = Math.max(card.height, Math.ceil(extent.h / GROW_STEP) * GROW_STEP)
  }
  // A fresh state and a transparent canvas every frame; the card is drawn in output coordinates.
  cardCtx.reset()
  cardCtx.translate(-extent.x, -extent.y)
  return { ctx: cardCtx, extent, quad: projectRect(view, extent), warp }
}

/** Draws the card painted since beginTiltedCard onto `target`, in perspective. */
export function drawTiltedCard(target: Ctx, w: number, h: number, tc: TiltedCard): void {
  const { warp, extent, quad } = tc
  const { gl, view, card, verts } = warp
  if (view.width !== w || view.height !== h) {
    view.width = w
    view.height = h
  }
  gl.viewport(0, 0, w, h)
  gl.bindTexture(gl.TEXTURE_2D, warp.texture)
  if (warp.texW !== card.width || warp.texH !== card.height) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, card)
    warp.texW = card.width
    warp.texH = card.height
  } else {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, card)
  }
  // Triangle strip: top-left, top-right, bottom-left, bottom-right. Positions carry the
  // perspective weight q as w, so the GPU maps the texture with perspective.
  const u1 = extent.w / card.width
  const v1 = extent.h / card.height
  for (let i = 0; i < 4; i++) {
    const p = quad[STRIP[i]]
    const o = i * 6
    verts[o] = ((p.x / w) * 2 - 1) * p.q
    verts[o + 1] = (1 - (p.y / h) * 2) * p.q
    verts[o + 2] = 0
    verts[o + 3] = p.q
    verts[o + 4] = STRIP_UV[i * 2] * u1
    verts[o + 5] = STRIP_UV[i * 2 + 1] * v1
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, warp.buffer)
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, verts)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  // Only the part the card covers is copied (the drawing buffer is read in this same task).
  const b = quadBounds(quad, w, h)
  if (b.w > 0 && b.h > 0) target.drawImage(view, b.x, b.y, b.w, b.h, b.x, b.y, b.w, b.h)
}
