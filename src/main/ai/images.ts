/**
 * Pictures sent with a text request (docs/design/smart-tools.md §5.3.1, part P6: titles from the
 * screenshots). Only the `names` task carries them: the guide's own shots, as JPEG, each beside its
 * item by id. Before anything goes, each client checks them again (checkImages: JPEG by its first
 * bytes, at most 512 KB each and 50 a request), whatever the renderer and the request validator
 * already checked. Then each client puts them in its API's own form:
 *
 * - OpenAI's Responses API: an `input_image` part with a `data:` URL
 *   (https://developers.openai.com/api/docs/guides/images-vision);
 * - a service's Chat Completions: an `image_url` part with a `data:` URL;
 * - Gemini: an `inline_data` part (`inlineData` in the SDK) with base64 bytes
 *   (https://ai.google.dev/gemini-api/docs/image-understanding);
 * - Claude: an `image` block with a base64 source
 *   (https://platform.claude.com/docs/en/build-with-claude/vision).
 *
 * Each picture follows a short line naming its item ("The picture for item "c3000":"), after the
 * request's own text. A provider that refuses pictures (HTTP 400 or 422 naming the image) gives
 * NO_PICTURES_MESSAGE, so the user knows to choose another model or untick the box. Nothing here
 * reads, keeps or logs a picture.
 */
import { AI_LIMITS } from '../../shared/api/ai'
import type { FailureInfo } from '../../shared/captions/transcriptErrors'
import type { TextPrompt } from '../../shared/captions/transcriptText'
import { AiError } from './request'
import { NO_PICTURES_MESSAGE } from './types'

/** One picture of a prompt. */
export type PromptImage = NonNullable<TextPrompt['images']>[number]

/** What a request may carry (AI_LIMITS.names): 512 KB a picture, 50 a request. */
export const IMAGE_LIMITS = { bytes: AI_LIMITS.names.image, perRequest: AI_LIMITS.names.imagesPerRequest } as const

/** JPEG by its first bytes (FF D8 FF). */
export const isJpeg = (b: Uint8Array): boolean => b instanceof Uint8Array && b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff

/**
 * Checks the pictures of one request: each a JPEG of at most 512 KB, at most 50 of them. Throws a
 * message to show otherwise; nothing is sent then.
 */
export function checkImages(images: readonly Uint8Array[]): void {
  if (images.length > IMAGE_LIMITS.perRequest) throw new Error('There are too many pictures to send at once.')
  for (const b of images) {
    if (!isJpeg(b)) throw new Error('A picture to send is not a JPEG image.')
    if (b.byteLength > IMAGE_LIMITS.bytes) throw new Error('A picture to send is too large.')
  }
}

/** The pictures of `prompt`, checked (checkImages); none for a prompt without them. */
export function promptImages(prompt: Pick<TextPrompt, 'images'>): PromptImage[] {
  const images = prompt.images ?? []
  checkImages(images.map((i) => i.data))
  for (const i of images) if (i.mime !== 'image/jpeg' || typeof i.id !== 'string' || !i.id || i.id.length > 64) throw new Error('A picture to send is not a JPEG image.')
  return images
}

const base64 = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64')
const dataUrl = (img: PromptImage): string => `data:image/jpeg;base64,${base64(img.data)}`

/** The line before each picture, naming its item. */
export const imageLabel = (img: PromptImage): string => `The picture for item ${JSON.stringify(img.id)}:`

/** OpenAI's Responses API: an `input_image` part with a `data:` URL. */
export function openAiImagePart(img: PromptImage): { type: 'input_image'; image_url: string; detail: 'auto' } {
  return { type: 'input_image', image_url: dataUrl(img), detail: 'auto' }
}

/** A service's Chat Completions: an `image_url` part with a `data:` URL. */
export function chatImagePart(img: PromptImage): { type: 'image_url'; image_url: { url: string } } {
  return { type: 'image_url', image_url: { url: dataUrl(img) } }
}

/** Gemini: an `inline_data` part (the SDK's `inlineData`) with the bytes in base64. */
export function geminiImagePart(img: PromptImage): { inlineData: { mimeType: 'image/jpeg'; data: string } } {
  return { inlineData: { mimeType: 'image/jpeg', data: base64(img.data) } }
}

/** Claude: an `image` block with a base64 source. */
export function claudeImageBlock(img: PromptImage): { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg'; data: string } } {
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64(img.data) } }
}

/** The text and pictures of a prompt as parts: its user text, then each picture after the line naming its item. */
export function withPictures<T>(prompt: Pick<TextPrompt, 'user' | 'images'>, text: (s: string) => T, picture: (img: PromptImage) => T): T[] {
  return [text(prompt.user), ...promptImages(prompt).flatMap((img) => [text(imageLabel(img)), picture(img)])]
}

/** Words of a refusal that is about the picture rather than the text. */
const NAMES_A_PICTURE = /\bimages?\b|\bpictures?\b|\bvision\b|multi-?modal|modalit|input_image|image_url|inline_?data|media_type/i

/** Whether a failed request was the provider refusing pictures: HTTP 400 or 422 whose code or message names the image. */
export function refusesPictures(info: FailureInfo): boolean {
  return (info.status === 400 || info.status === 422) && NAMES_A_PICTURE.test(`${info.code ?? ''} ${info.message ?? ''}`)
}

/** The failure a picture refusal is shown as. */
export const noPictures = (): AiError => new AiError({ kind: 'bad-request', retryable: false, message: NO_PICTURES_MESSAGE })

/**
 * Runs one attempt of a request of `prompt`; when the prompt carries pictures and the provider
 * refused them, fails with NO_PICTURES_MESSAGE (an AiError: callWithRetry passes it on as it is,
 * without trying again). Any other failure is the provider's own, unchanged.
 */
export async function sendingPictures<T>(prompt: Pick<TextPrompt, 'images'>, toFailure: (err: unknown) => FailureInfo, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (prompt.images?.length && !(err instanceof AiError) && refusesPictures(toFailure(err))) throw noPictures()
    throw err
  }
}
