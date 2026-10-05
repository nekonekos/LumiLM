import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import type { ChatRequestMessage } from '@shared/types'
import { logger, toError } from '../util/logger'

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

const MAX_IMAGE_BYTES = 16 * 1024 * 1024

/**
 * llama-server expects inline image payloads, so local file paths coming from
 * the renderer are converted into base64 data URLs here (the renderer never has
 * to shuttle megabytes of base64 across the IPC boundary).
 */
export function materializeImages(messages: ChatRequestMessage[]): ChatRequestMessage[] {
  if (!messages.some((message) => message.images && message.images.length > 0)) return messages

  return messages.map((message) => {
    if (!message.images || message.images.length === 0) return message

    const dataUrls: string[] = []
    for (const imagePath of message.images) {
      try {
        const stats = statSync(imagePath)
        if (!stats.isFile() || stats.size > MAX_IMAGE_BYTES) {
          logger.warn('chat', `skipping image (too large or not a file): ${imagePath}`)
          continue
        }
        const mime = MIME_BY_EXTENSION[extname(imagePath).toLowerCase()] ?? 'image/png'
        dataUrls.push(`data:${mime};base64,${readFileSync(imagePath).toString('base64')}`)
      } catch (error) {
        logger.warn('chat', `failed to read image ${imagePath}: ${toError(error).message}`)
      }
    }

    return { ...message, images: dataUrls }
  })
}
