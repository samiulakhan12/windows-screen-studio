import { describe, expect, it } from 'vitest'
import {
  backgroundBlurRadius,
  cameraShadow,
  MASK_HIGH,
  MASK_LOW,
  maskPixels,
  SEGMENT_SIZE,
  segmentationSize,
  shadowReach
} from '../src/shared/render/cameraLook'
import { DEFAULT_WEBCAM_SHADOW } from '../src/shared/engine/webcamData'

describe('camera shadow', () => {
  it('draws the original shadow at the default strength', () => {
    expect(cameraShadow(DEFAULT_WEBCAM_SHADOW, 1)).toEqual({ color: 'rgba(0,0,0,0.4)', blur: 30, offsetY: 10 })
    expect(cameraShadow(DEFAULT_WEBCAM_SHADOW, 2)).toEqual({ color: 'rgba(0,0,0,0.4)', blur: 60, offsetY: 20 })
  })

  it('is off at 0 (and for nonsense), darker and wider when stronger, never past its limits', () => {
    expect(cameraShadow(0, 1)).toBeNull()
    expect(cameraShadow(-1, 1)).toBeNull()
    expect(cameraShadow(NaN, 1)).toBeNull()
    const weak = cameraShadow(0.2, 1)!
    const strong = cameraShadow(1, 1)!
    expect(weak.blur).toBeLessThan(strong.blur)
    expect(strong.color).toBe('rgba(0,0,0,0.667)')
    expect(cameraShadow(5, 1)).toEqual(strong)
  })

  it('reaches far enough for a sprite to hold the whole shadow', () => {
    const s = cameraShadow(1, 2)!
    expect(shadowReach(s)).toBeGreaterThanOrEqual(s.blur + s.offsetY)
  })
})

describe('background blur', () => {
  it('scales with the camera picture, so preview and export blur alike at any size', () => {
    expect(backgroundBlurRadius(0, 1280, 720)).toBe(0)
    expect(backgroundBlurRadius(1, 1280, 720)).toBeCloseTo(44.8)
    expect(backgroundBlurRadius(1, 640, 360)).toBeCloseTo(backgroundBlurRadius(1, 1280, 720) / 2)
    expect(backgroundBlurRadius(2, 1280, 720)).toBe(backgroundBlurRadius(1, 1280, 720))
    expect(backgroundBlurRadius(-1, 1280, 720)).toBe(0)
  })
})

describe('segmentation input', () => {
  it('keeps the camera shape with the longest side at the model size', () => {
    expect(segmentationSize(1280, 720)).toEqual({ width: SEGMENT_SIZE, height: 144 })
    expect(segmentationSize(480, 640)).toEqual({ width: 192, height: SEGMENT_SIZE })
    expect(segmentationSize(100, 100)).toEqual({ width: SEGMENT_SIZE, height: SEGMENT_SIZE })
  })

  it('never makes a sliver or divides by zero', () => {
    expect(segmentationSize(4000, 10)).toEqual({ width: SEGMENT_SIZE, height: 16 })
    expect(segmentationSize(0, 0)).toEqual({ width: SEGMENT_SIZE, height: SEGMENT_SIZE })
    expect(segmentationSize(NaN, 720)).toEqual({ width: SEGMENT_SIZE, height: SEGMENT_SIZE })
  })
})

describe('person mask', () => {
  const alpha = (c: number): number => maskPixels([c])[3]

  it('is white, its alpha the person: clear background, solid person, a soft edge between', () => {
    const px = maskPixels([0, 1])
    expect([...px]).toEqual([255, 255, 255, 0, 255, 255, 255, 255])
    expect(alpha(MASK_LOW)).toBe(0)
    expect(alpha(MASK_HIGH)).toBe(255)
    expect(alpha((MASK_LOW + MASK_HIGH) / 2)).toBe(128)
    expect(alpha(0.4)).toBeLessThan(alpha(0.5))
    expect(alpha(0.5)).toBeLessThan(alpha(0.6))
  })

  it('treats bad confidences as background and clamps out-of-range ones', () => {
    expect(alpha(NaN)).toBe(0)
    expect(alpha(-3)).toBe(0)
    expect(alpha(7)).toBe(255)
  })

  it('writes into a given buffer', () => {
    const out = new Uint8ClampedArray(8)
    expect(maskPixels(new Float32Array([1, 0]), out)).toBe(out)
    expect(out[3]).toBe(255)
    expect(out[7]).toBe(0)
  })
})
