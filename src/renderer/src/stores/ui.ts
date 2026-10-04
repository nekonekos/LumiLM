import { create } from 'zustand'
import type { ToastPayload } from '@shared/types'

export interface Toast extends ToastPayload {
  id: string
  createdAt: number
}

export type SettingsTabKey = 'general' | 'appearance' | 'inference' | 'models' | 'advanced' | 'about'

interface UiState {
  sidebarCollapsed: boolean
  inspectorCollapsed: boolean
  settingsOpen: boolean
  settingsTab: SettingsTabKey
  logsOpen: boolean
  commandOpen: boolean
  toasts: Toast[]
  /** ring buffer of llama-server log lines received while the app is running */
  logs: string[]

  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleInspector: () => void
  setInspectorCollapsed: (collapsed: boolean) => void
  openSettings: (tab?: SettingsTabKey) => void
  closeSettings: () => void
  setLogsOpen: (open: boolean) => void
  setCommandOpen: (open: boolean) => void
  appendLog: (line: string) => void
  setLogs: (lines: string[]) => void
  pushToast: (toast: ToastPayload) => void
  dismissToast: (id: string) => void
}

const MAX_LOG_LINES = 2000

let toastCounter = 0

export const useUiStore = create<UiState>((set, get) => ({
  sidebarCollapsed: false,
  inspectorCollapsed: false,
  settingsOpen: false,
  settingsTab: 'general',
  logsOpen: false,
  commandOpen: false,
  toasts: [],
  logs: [],

  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  toggleInspector: () => set((state) => ({ inspectorCollapsed: !state.inspectorCollapsed })),
  setInspectorCollapsed: (inspectorCollapsed) => set({ inspectorCollapsed }),

  openSettings: (tab) =>
    set({ settingsOpen: true, settingsTab: tab ?? get().settingsTab }),
  closeSettings: () => set({ settingsOpen: false }),

  setLogsOpen: (logsOpen) => set({ logsOpen }),
  setCommandOpen: (commandOpen) => set({ commandOpen }),

  appendLog: (line) =>
    set((state) => {
      const logs = state.logs.length >= MAX_LOG_LINES ? state.logs.slice(-MAX_LOG_LINES + 1) : state.logs
      return { logs: [...logs, line] }
    }),

  setLogs: (logs) => set({ logs }),

  pushToast: (toast) => {
    toastCounter += 1
    const entry: Toast = { ...toast, id: `toast-${toastCounter}`, createdAt: Date.now() }
    set((state) => ({ toasts: [...state.toasts, entry].slice(-4) }))

    window.setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((item) => item.id !== entry.id) }))
    }, toast.kind === 'error' ? 8000 : 4200)
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }))
}))
