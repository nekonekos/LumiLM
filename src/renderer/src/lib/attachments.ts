import type { Attachment } from '@shared/types'

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp'
}

const TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'csv', 'log', 'ts', 'js']

export const ACCEPTED_IMAGE_TYPES = Object.values(IMAGE_MIME)

export function mimeTypeForFile(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_MIME[extension] ?? (TEXT_EXTENSIONS.includes(extension) ? 'text/plain' : 'application/octet-stream')
}

export function isSupportedImage(file: { name: string; type: string }): boolean {
  if (file.type.startsWith('image/')) return ACCEPTED_IMAGE_TYPES.includes(file.type)
  const extension = file.name.split('.').pop()?.toLowerCase()
  return extension ? extension in IMAGE_MIME : false
}

let counter = 0
function nextId(): string {
  counter += 1
  return `att-${Date.now().toString(36)}-${counter}`
}

export function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] ?? filePath
}

/** Builds an attachment for an image that already lives on disk. */
export async function attachmentFromPath(filePath: string): Promise<Attachment | null> {
  const name = baseName(filePath)
  const stats = await window.lumilm.fs.stat(filePath)
  return {
    id: nextId(),
    kind: 'image',
    name,
    mimeType: mimeTypeForFile(name),
    sizeBytes: stats?.sizeBytes ?? 0,
    path: filePath
  }
}

/**
 * Persists a dropped or pasted image into the application data directory and
 * returns the matching attachment. The renderer never keeps image data in
 * memory beyond the preview because the main process reads it back from disk.
 */
export async function attachmentFromBlob(blob: Blob, fileName: string): Promise<Attachment | null> {
  const dataUrl = await blobToDataUrl(blob)
  const path = await window.lumilm.fs.saveAttachment(fileName, dataUrl)
  if (!path) return null

  return {
    id: nextId(),
    kind: 'image',
    name: baseName(path),
    mimeType: mimeTypeForFile(path),
    sizeBytes: blob.size,
    path
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('could not read image data'))
    reader.readAsDataURL(blob)
  })
}

/** Turns an OS drag-and-drop `DataTransfer` into attachments. */
export async function attachmentsFromDataTransfer(data: DataTransfer): Promise<Attachment[]> {
  const files = Array.from(data.files ?? [])
  const results: Attachment[] = []

  for (const file of files) {
    if (!isSupportedImage(file)) continue
    const attachment = await attachmentFromBlob(file, file.name)
    if (attachment) results.push(attachment)
  }

  return results
}
