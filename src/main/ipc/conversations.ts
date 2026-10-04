import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { CH } from '@shared/channels'
import type { Conversation, ConversationMeta } from '@shared/types'
import { conversationStore } from '../store/conversations'
import { registerHandler } from './register'

function toMarkdown(conversation: Conversation): string {
  const lines: string[] = [`# ${conversation.title || 'Conversation'}`, '']
  lines.push(`- Created: ${new Date(conversation.createdAt).toISOString()}`)
  lines.push(`- Updated: ${new Date(conversation.updatedAt).toISOString()}`)
  if (conversation.modelId) lines.push(`- Model: ${conversation.modelId}`)
  if (conversation.systemPrompt.trim().length > 0) {
    lines.push('', '## System prompt', '', conversation.systemPrompt)
  }

  for (const message of conversation.messages) {
    const role = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : 'System'
    lines.push('', `## ${role}`, '')
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind === 'image') lines.push(`![${attachment.name}](${attachment.path})`)
    }
    if (message.content.trim().length > 0) lines.push(message.content)
    if (message.reasoning && message.reasoning.trim().length > 0) {
      lines.push('', '<details><summary>Reasoning</summary>', '', message.reasoning, '', '</details>')
    }
  }

  lines.push('')
  return lines.join('\n')
}

function sanitizeFileName(name: string): string {
  return (name || 'conversation').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
}

function isValidConversation(value: unknown): value is Conversation {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Conversation>
  return Array.isArray(candidate.messages) && typeof candidate.id === 'string'
}

export function registerConversationHandlers(): void {
  registerHandler(CH.conversations.list, (): ConversationMeta[] => conversationStore.list())

  registerHandler(CH.conversations.get, (_event, id: string): Conversation | null => {
    if (typeof id !== 'string') return null
    return conversationStore.get(id)
  })

  registerHandler(
    CH.conversations.create,
    (_event, init?: { modelId?: string | null; title?: string }): Conversation =>
      conversationStore.create(init ?? {})
  )

  registerHandler(CH.conversations.save, (_event, conversation: Conversation): void => {
    if (!isValidConversation(conversation)) throw new Error('INVALID_CONVERSATION')
    conversationStore.save(conversation)
  })

  registerHandler(CH.conversations.remove, (_event, id: string): void => {
    if (typeof id !== 'string') return
    conversationStore.remove(id)
  })

  registerHandler(CH.conversations.duplicate, (_event, id: string): Conversation | null => {
    if (typeof id !== 'string') return null
    return conversationStore.duplicate(id)
  })

  registerHandler(
    CH.conversations.exportToFile,
    async (event, id: string, format: 'md' | 'json'): Promise<string | null> => {
      const conversation = conversationStore.get(id)
      if (!conversation) return null
      const window = BrowserWindow.fromWebContents(event.sender)
      const extension = format === 'json' ? 'json' : 'md'
      const result = await dialog.showSaveDialog(window as BrowserWindow, {
        title: 'Export conversation',
        defaultPath: join(
          app.getPath('downloads'),
          `${sanitizeFileName(conversation.title || 'conversation')}.${extension}`
        ),
        filters:
          extension === 'json'
            ? [{ name: 'JSON', extensions: ['json'] }]
            : [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (result.canceled || !result.filePath) return null

      const payload =
        extension === 'json' ? `${JSON.stringify(conversation, null, 2)}\n` : toMarkdown(conversation)
      writeFileSync(result.filePath, payload, 'utf8')
      return result.filePath
    }
  )

  registerHandler(CH.conversations.importFromFile, async (event): Promise<Conversation | null> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(window as BrowserWindow, {
      title: 'Import conversation',
      properties: ['openFile'],
      filters: [{ name: 'LumiLM conversation', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null

    const raw = readFileSync(result.filePaths[0], 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isValidConversation(parsed)) throw new Error('INVALID_CONVERSATION')

    const imported: Conversation = {
      ...parsed,
      id: randomUUID(),
      title: parsed.title || basename(result.filePaths[0], '.json'),
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    conversationStore.save(imported)
    return imported
  })
}
