import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Conversation, ConversationMeta, SamplingParams } from '@shared/types'
import { DEFAULT_SAMPLING } from '@shared/types'
import { readJsonSync, writeJsonAtomicSync } from '../util/atomic-json'
import { logger } from '../util/logger'
import { ensureDataDirs, getPaths } from './paths'
import { settingsStore } from './settings'

const MAX_TITLE_LENGTH = 48
const MAX_PREVIEW_LENGTH = 90

function truncate(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized
}

function deriveTitle(messages: Conversation['messages']): string {
  const firstUser = messages.find((m) => m.role === 'user' && m.content.trim().length > 0)
  if (firstUser) return truncate(firstUser.content, MAX_TITLE_LENGTH)
  const firstAssistant = messages.find((m) => m.role === 'assistant' && m.content.trim().length > 0)
  if (firstAssistant) return truncate(firstAssistant.content, MAX_TITLE_LENGTH)
  return ''
}

function derivePreview(messages: Conversation['messages']): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message && message.content.trim().length > 0) return truncate(message.content, MAX_PREVIEW_LENGTH)
  }
  return ''
}

function toMeta(conversation: Conversation): ConversationMeta {
  return {
    id: conversation.id,
    title: conversation.title || deriveTitle(conversation.messages),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    pinned: conversation.pinned,
    archived: conversation.archived,
    modelId: conversation.modelId,
    messageCount: conversation.messages.length,
    preview: derivePreview(conversation.messages)
  }
}

function sortMetas(metas: ConversationMeta[]): ConversationMeta[] {
  return metas.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.updatedAt - a.updatedAt
  })
}

/**
 * Conversations written before the extension system existed have no `mode` or
 * `agent` field. Filling them in here keeps the rest of the code free of
 * optional chaining and guarantees that old files open in plain chat mode.
 */
export function normalizeConversation(conversation: Conversation): Conversation {
  return {
    ...conversation,
    mode: conversation.mode === 'agent' ? 'agent' : 'chat',
    agent: conversation.agent && typeof conversation.agent === 'object' ? conversation.agent : {}
  }
}

class ConversationStore {
  private index: ConversationMeta[] | null = null

  private dir(): string {
    return getPaths().conversationsDir
  }

  private fileFor(id: string): string {
    return join(this.dir(), `${id}.json`)
  }

  private readAll(): Conversation[] {
    const dir = this.dir()
    if (!existsSync(dir)) return []
    const conversations: Conversation[] = []
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json') || entry.startsWith('.')) continue
      const parsed = readJsonSync<Conversation>(join(dir, entry))
      if (parsed && typeof parsed.id === 'string' && Array.isArray(parsed.messages)) {
        conversations.push(normalizeConversation(parsed))
      }
    }
    return conversations
  }

  private ensureIndex(): ConversationMeta[] {
    if (this.index) return this.index
    ensureDataDirs()
    this.index = sortMetas(this.readAll().map(toMeta))
    return this.index
  }

  private invalidate(): void {
    this.index = null
  }

  private write(conversation: Conversation): void {
    ensureDataDirs()
    writeJsonAtomicSync(this.fileFor(conversation.id), conversation)
  }

  list(): ConversationMeta[] {
    return this.ensureIndex()
  }

  get(id: string): Conversation | null {
    const parsed = readJsonSync<Conversation>(this.fileFor(id))
    return parsed ? normalizeConversation(parsed) : null
  }

  create(init?: { modelId?: string | null; title?: string; sampling?: SamplingParams }): Conversation {
    const now = Date.now()
    const conversation: Conversation = {
      id: randomUUID(),
      title: init?.title ?? '',
      createdAt: now,
      updatedAt: now,
      pinned: false,
      archived: false,
      modelId: init?.modelId ?? null,
      systemPrompt: '',
      sampling: init?.sampling ? { ...DEFAULT_SAMPLING, ...init.sampling } : { ...DEFAULT_SAMPLING },
      // Hardcoding this made the `默认模式` setting a no-op: every new
      // conversation opened in 纯对话 no matter what was configured.
      mode: settingsStore.get().agent.defaultMode,
      agent: {},
      messages: []
    }
    this.write(conversation)
    this.invalidate()
    return conversation
  }

  save(conversation: Conversation): Conversation {
    const next: Conversation = {
      ...conversation,
      updatedAt: Date.now(),
      title: conversation.title || deriveTitle(conversation.messages)
    }
    this.write(next)
    this.invalidate()
    return next
  }

  remove(id: string): void {
    const file = this.fileFor(id)
    try {
      if (existsSync(file)) unlinkSync(file)
      if (existsSync(`${file}.bak`)) unlinkSync(`${file}.bak`)
    } catch (error) {
      logger.warn('conversations', `failed to delete conversation ${id}: ${String(error)}`)
    }
    this.invalidate()
  }

  duplicate(id: string): Conversation | null {
    const source = this.get(id)
    if (!source) return null
    const now = Date.now()
    const copy: Conversation = {
      ...structuredClone(source),
      id: randomUUID(),
      title: source.title ? `${source.title} (copy)` : '',
      createdAt: now,
      updatedAt: now,
      pinned: false
    }
    this.write(copy)
    this.invalidate()
    return copy
  }

  /** Rebuilds an index entry without rewriting the conversation file. */
  touch(id: string): void {
    const existing = this.get(id)
    if (!existing) return
    this.write({ ...existing, updatedAt: Date.now() })
    this.invalidate()
  }
}

export const conversationStore = new ConversationStore()
export { deriveTitle, toMeta }
