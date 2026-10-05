import { BrowserWindow, dialog, shell } from 'electron'
import { existsSync } from 'node:fs'
import { CH } from '@shared/channels'
import type { SkillInfo } from '@shared/types'
import { settingsStore } from '../store/settings'
import { skillRegistry } from '../skills/registry'
import { registerHandler } from './register'

export function registerSkillHandlers(): void {
  registerHandler(CH.skills.list, (): SkillInfo[] => skillRegistry.list())

  registerHandler(CH.skills.refresh, (): SkillInfo[] => {
    skillRegistry.invalidate()
    return skillRegistry.refresh()
  })

  registerHandler(CH.skills.addDirectory, async (event): Promise<string | null> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(window as BrowserWindow, {
      title: 'Select a skills folder',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const directory = result.filePaths[0]
    if (!directory) return null

    const current = settingsStore.get().skills.directories
    if (!current.includes(directory)) {
      settingsStore.update({ skills: { directories: [...current, directory] } })
    }
    skillRegistry.invalidate()
    skillRegistry.refresh()
    return directory
  })

  registerHandler(CH.skills.removeDirectory, (_event, directory: string): void => {
    if (typeof directory !== 'string' || directory.length === 0) throw new Error('INVALID_REQUEST')
    const remaining = settingsStore.get().skills.directories.filter((entry) => entry !== directory)
    settingsStore.update({ skills: { directories: remaining } })
    skillRegistry.invalidate()
    skillRegistry.refresh()
  })

  registerHandler(CH.skills.openFolder, async (_event, directory: string): Promise<void> => {
    if (typeof directory !== 'string' || !existsSync(directory)) return
    await shell.openPath(directory)
  })

  registerHandler(CH.skills.revealFile, (_event, filePath: string): void => {
    if (typeof filePath !== 'string' || !existsSync(filePath)) return
    shell.showItemInFolder(filePath)
  })
}
