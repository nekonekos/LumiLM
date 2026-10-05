import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { CH } from '@shared/channels'
import type {
  CompanionOverview,
  MemoryEpisode,
  MemoryFact,
  MemoryHit,
  MemoryQuery,
  MemoryStats,
  PersonaCard
} from '@shared/types'
import { memoryManager } from '../memory/manager'
import { companionService } from '../companion/service'
import {
  cardFileName,
  listCards,
  parseCardFile,
  removeCard,
  restoreBuiltinCard,
  saveCard,
  toSillyTavern
} from '../companion/persona'
import { emitMemoryChanged } from './events'
import { registerHandler } from './register'

function timestampSuffix(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * The memory library's channel.
 *
 * Every mutation answers with the refreshed overview so the renderer never has
 * to guess what changed, and every mutation broadcasts the same overview so
 * other views (the inspector chip, the sidebar badge) stay in step.
 */
export function registerMemoryHandlers(): void {
  const announce = (): CompanionOverview => {
    const overview = companionService.overview()
    emitMemoryChanged(overview)
    return overview
  }

  registerHandler(CH.memory.list, (_event, query?: MemoryQuery): MemoryFact[] =>
    memoryManager.listFacts(query ?? {})
  )

  registerHandler(CH.memory.stats, (): MemoryStats => memoryManager.stats())

  registerHandler(
    CH.memory.recall,
    (_event, query: string, limit?: number): MemoryHit[] =>
      memoryManager.recall(typeof query === 'string' ? query : '', {
        limit: typeof limit === 'number' && limit > 0 ? limit : undefined,
        // A dry-run must not inflate the usage counters the library shows.
        track: false
      })
  )

  registerHandler(
    CH.memory.update,
    (_event, id: string, patch: Partial<MemoryFact>): MemoryFact[] => {
      if (typeof id !== 'string' || !patch || typeof patch !== 'object') {
        return memoryManager.listFacts({ includeArchived: true, includePending: true })
      }
      const next = memoryManager.updateFact(id, patch)
      announce()
      return next
    }
  )

  registerHandler(CH.memory.remove, (_event, id: string): MemoryFact[] => {
    if (typeof id !== 'string') return memoryManager.listFacts({ includeArchived: true })
    const next = memoryManager.removeFacts([id])
    announce()
    return next
  })

  registerHandler(CH.memory.removeMany, (_event, ids: string[]): MemoryFact[] => {
    const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
    const next = memoryManager.removeFacts(list)
    announce()
    return next
  })

  registerHandler(CH.memory.approve, (_event, ids: string[], accept: boolean): MemoryFact[] => {
    const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
    const next = memoryManager.approve(list, accept !== false)
    announce()
    return next
  })

  registerHandler(CH.memory.episodes, (): MemoryEpisode[] => memoryManager.episodes())

  registerHandler(CH.memory.forgetAll, (): void => {
    memoryManager.forgetAll()
    announce()
  })

  registerHandler(CH.memory.export, async (event): Promise<string | null> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showSaveDialog(window as BrowserWindow, {
      title: '导出记忆',
      defaultPath: join(app.getPath('downloads'), `lumilm-memory-${timestampSuffix()}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return null

    writeFileSync(result.filePath, memoryManager.exportJson(), 'utf8')
    return result.filePath
  })

  registerHandler(CH.memory.import, async (event): Promise<MemoryFact[] | null> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(window as BrowserWindow, {
      title: '导入记忆',
      properties: ['openFile'],
      filters: [{ name: 'LumiLM memory', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null

    const parsed: unknown = JSON.parse(readFileSync(result.filePaths[0], 'utf8'))
    memoryManager.importJson(parsed)
    announce()
    return memoryManager.listFacts({ includeArchived: true, includePending: true })
  })

  /* ---------------------------------------------------------------- */
  /* Persona cards                                                     */
  /* ---------------------------------------------------------------- */

  registerHandler(CH.personas.list, (): PersonaCard[] => listCards())

  registerHandler(CH.personas.save, (_event, card: PersonaCard): PersonaCard[] => {
    if (!card || typeof card !== 'object') throw new Error('INVALID_CARD')
    const next = saveCard(card)
    announce()
    return next
  })

  registerHandler(CH.personas.remove, (_event, id: string): PersonaCard[] => {
    if (typeof id !== 'string') return listCards()
    const next = removeCard(id)
    announce()
    return next
  })

  registerHandler(CH.personas.import, async (event): Promise<PersonaCard | null> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(window as BrowserWindow, {
      title: '导入角色卡',
      properties: ['openFile'],
      filters: [{ name: 'Character card', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null

    const card = parseCardFile(readFileSync(result.filePaths[0], 'utf8'))
    if (!card) throw new Error('INVALID_CARD')

    saveCard(card)
    announce()
    return card
  })

  registerHandler(CH.personas.export, async (event, id: string): Promise<string | null> => {
    const card = listCards().find((entry) => entry.id === id)
    if (!card) return null

    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showSaveDialog(window as BrowserWindow, {
      title: '导出角色卡',
      defaultPath: join(app.getPath('downloads'), cardFileName(card)),
      filters: [{ name: 'Character card', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return null

    // Exported as a SillyTavern V2 card so other apps can read it too.
    writeFileSync(result.filePath, `${JSON.stringify(toSillyTavern(card), null, 2)}\n`, 'utf8')
    return result.filePath
  })

  registerHandler(CH.personas.detectImage, (): string | null => {
    // Card avatars are a 0.3.x follow-up; the field exists so cards round-trip.
    return null
  })

  // Keeps the shipped card reachable after the user edits or deletes it.
  registerHandler(CH.personas.restoreBuiltin, (): PersonaCard[] => {
    const next = restoreBuiltinCard()
    announce()
    return next
  })
}
