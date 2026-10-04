import { useEffect, useState, type ReactNode } from 'react'
import { ExternalLink, FolderOpen, GitFork, Globe, ScrollText, Trash2 } from 'lucide-react'
import type { AppInfo, AppPaths, Locale, LogLevel, ThemeMode } from '@shared/types'
import {
  Button,
  Dialog,
  Field,
  SectionTitle,
  Select,
  Slider,
  Switch,
  Tabs
} from '@/components/ui'
import { formatNumber } from '@/lib/format'
import { ModelManager } from '@/components/models/ModelManager'
import { RuntimePanel } from '@/components/inspector/RuntimePanel'
import { useAppIcon } from '@/hooks/useAppIcon'
import { useT } from '@/i18n'
import { useModelsStore } from '@/stores/models'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore, type SettingsTabKey } from '@/stores/ui'

const ACCENTS = ['#2f6fe8', '#3b82f6', '#0ea5e9', '#14b8a6', '#8b5cf6', '#ec4899', '#f97316']

export function SettingsDialog(): ReactNode {
  const t = useT()
  const appIcon = useAppIcon()
  const open = useUiStore((state) => state.settingsOpen)
  const tab = useUiStore((state) => state.settingsTab)
  const close = useUiStore((state) => state.closeSettings)
  const setTab = (next: SettingsTabKey): void => useUiStore.getState().openSettings(next)
  const setLogsOpen = useUiStore((state) => state.setLogsOpen)
  const pushToast = useUiStore((state) => state.pushToast)

  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  const reset = useSettingsStore((state) => state.reset)

  const [info, setInfo] = useState<AppInfo | null>(null)
  const [paths, setPaths] = useState<AppPaths | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => {
    if (!open) return
    if (!info) void window.lumilm.app.getInfo().then(setInfo)
    if (!paths) void window.lumilm.app.getPaths().then(setPaths)
  }, [open, info, paths])

  if (!settings) return null

  const { general, appearance, advanced } = settings

  const exportDiagnostics = async (): Promise<void> => {
    const path = await window.lumilm.app.exportDiagnostics()
    if (path) pushToast({ kind: 'success', message: t('toast.diagnosticsSaved', { path }) })
  }

  return (
    <>
      <Dialog
        open={open}
        onClose={close}
        title={t('settings.title')}
        width="max-w-3xl"
        footer={
          <Button variant="ghost" onClick={close}>
            {t('common.close')}
          </Button>
        }
      >
        <div className="border-b border-border px-5 py-3">
          <Tabs<SettingsTabKey>
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'general', label: t('settings.general') },
              { value: 'appearance', label: t('settings.appearance') },
              { value: 'inference', label: t('settings.inference') },
              { value: 'models', label: t('settings.models') },
              { value: 'advanced', label: t('settings.advanced') },
              { value: 'about', label: t('settings.about') }
            ]}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {tab === 'general' ? (
            <div className="flex flex-col gap-5">
              <section className="flex flex-col gap-3">
                <SectionTitle>{t('settings.general')}</SectionTitle>

                <Field label={t('settings.language')}>
                  <Select<Locale>
                    value={general.locale}
                    onChange={(value) => void update({ general: { locale: value } })}
                    options={[
                      { value: 'zh-CN', label: '简体中文' },
                      { value: 'en-US', label: 'English' }
                    ]}
                  />
                </Field>

                <Field label={t('settings.theme')}>
                  <Select<ThemeMode>
                    value={general.themeMode}
                    onChange={(value) => void update({ general: { themeMode: value } })}
                    options={[
                      { value: 'system', label: t('settings.themeSystem') },
                      { value: 'light', label: t('settings.themeLight') },
                      { value: 'dark', label: t('settings.themeDark') }
                    ]}
                  />
                </Field>

                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-fg-muted">{t('settings.confirmDelete')}</span>
                  <Switch
                    label={t('settings.confirmDelete')}
                    checked={general.confirmOnDelete}
                    onChange={(checked) => void update({ general: { confirmOnDelete: checked } })}
                  />
                </div>
              </section>

              <section className="flex flex-col gap-2">
                <SectionTitle>{t('settings.dataDir')}</SectionTitle>
                <p className="text-[11px] leading-snug text-fg-subtle">{t('settings.dataDirHint')}</p>
                <p className="truncate rounded-[9px] border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-[11px] text-fg-muted">
                  {paths?.dataDir ?? '—'}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      void window.lumilm.dialog.pickDirectory().then((dir) => {
                        if (dir) void update({ general: { dataDir: dir } })
                      })
                    }
                  >
                    {t('settings.changeDataDir')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!paths}
                    onClick={() => paths && void window.lumilm.app.openPath(paths.dataDir)}
                  >
                    <FolderOpen className="size-3.5" />
                    {t('settings.openDataDir')}
                  </Button>
                </div>
              </section>
            </div>
          ) : null}

          {tab === 'appearance' ? (
            <div className="flex flex-col gap-5">
              <section className="flex flex-col gap-3">
                <SectionTitle>{t('settings.appearance')}</SectionTitle>

                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-fg-muted">{t('settings.accent')}</span>
                  <div className="flex flex-wrap gap-2">
                    {ACCENTS.map((accent) => (
                      <button
                        key={accent}
                        type="button"
                        aria-label={accent}
                        onClick={() => void update({ general: { accent } })}
                        className="size-7 rounded-full border-2 border-white shadow"
                        style={{
                          background: accent,
                          outline: general.accent === accent ? `2px solid ${accent}` : 'none',
                          outlineOffset: 2
                        }}
                      />
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-fg-muted">{t('settings.fontSize')}</span>
                    <span className="text-[11px] tabular-nums text-fg">
                      {formatNumber(appearance.fontSize)} px
                    </span>
                  </div>
                  <Slider
                    value={appearance.fontSize}
                    min={12}
                    max={19}
                    step={1}
                    onChange={(value) => void update({ appearance: { fontSize: value } })}
                  />
                </div>

                <Field label={t('settings.density')}>
                  <Select<'comfortable' | 'compact'>
                    value={appearance.density}
                    onChange={(value) => void update({ appearance: { density: value } })}
                    options={[
                      { value: 'comfortable', label: t('settings.densityComfortable') },
                      { value: 'compact', label: t('settings.densityCompact') }
                    ]}
                  />
                </Field>

                <Field label={t('settings.layout')}>
                  <Select<'bubble' | 'document'>
                    value={appearance.layout}
                    onChange={(value) => void update({ appearance: { layout: value } })}
                    options={[
                      { value: 'bubble', label: t('settings.layoutBubble') },
                      { value: 'document', label: t('settings.layoutDocument') }
                    ]}
                  />
                </Field>

                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-fg-muted">{t('settings.showReasoning')}</span>
                  <Switch
                    label={t('settings.showReasoning')}
                    checked={appearance.showReasoning}
                    onChange={(checked) => void update({ appearance: { showReasoning: checked } })}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-fg-muted">{t('settings.wideTables')}</span>
                  <Switch
                    label={t('settings.wideTables')}
                    checked={appearance.wideTables}
                    onChange={(checked) => void update({ appearance: { wideTables: checked } })}
                  />
                </div>
              </section>
            </div>
          ) : null}

          {tab === 'inference' ? <RuntimePanel /> : null}
          {tab === 'models' ? <ModelManager /> : null}

          {tab === 'advanced' ? (
            <div className="flex flex-col gap-5">
              <section className="flex flex-col gap-3">
                <SectionTitle>{t('settings.advanced')}</SectionTitle>

                <Field label={t('settings.logLevel')}>
                  <Select<LogLevel>
                    value={advanced.logLevel}
                    onChange={(value) => void update({ advanced: { logLevel: value } })}
                    options={[
                      { value: 'error', label: 'error' },
                      { value: 'warn', label: 'warn' },
                      { value: 'info', label: 'info' },
                      { value: 'debug', label: 'debug' }
                    ]}
                  />
                </Field>

                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-fg-muted">{t('settings.offline')}</span>
                  <span className="text-[11px] text-fg-subtle">{t('settings.offlineHint')}</span>
                </div>

                <label className="flex flex-col gap-1.5">
                  <span className="flex items-center justify-between">
                    <span className="text-xs font-medium text-fg-muted">{t('settings.idleUnload')}</span>
                    <span className="text-[11px] tabular-nums text-fg">
                      {settings.inference.idleUnloadMinutes === 0
                        ? t('settings.idleNever')
                        : `${settings.inference.idleUnloadMinutes} ${t('settings.minutes')}`}
                    </span>
                  </span>
                  <Slider
                    value={settings.inference.idleUnloadMinutes}
                    min={0}
                    max={120}
                    step={5}
                    onChange={(value) =>
                      void update({ inference: { idleUnloadMinutes: value } })
                    }
                  />
                </label>

                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setLogsOpen(true)}>
                    <ScrollText className="size-3.5" />
                    {t('settings.viewLogs')}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void exportDiagnostics()}>
                    {t('settings.exportDiagnostics')}
                  </Button>
                </div>
              </section>

              <section className="flex flex-col gap-2">
                <SectionTitle>{t('common.reset')}</SectionTitle>
                <p className="text-[11px] leading-snug text-fg-subtle">{t('settings.resetConfirm')}</p>
                <Button size="sm" variant="danger" className="self-start" onClick={() => setConfirmReset(true)}>
                  <Trash2 className="size-3.5" />
                  {t('settings.resetAll')}
                </Button>
              </section>
            </div>
          ) : null}

          {tab === 'about' ? (
            <div className="flex flex-col gap-5">
              <section className="flex flex-col gap-2">
                <SectionTitle>{t('app.name')}</SectionTitle>
                <div className="flex items-center gap-3">
                  <img
                    src={appIcon}
                    alt=""
                    className="size-11 shrink-0 select-none rounded-[14px] border border-border"
                  />
                  <p className="text-xs leading-relaxed text-fg-muted">{t('app.tagline')}</p>
                </div>
              </section>

              <section className="flex flex-col gap-2.5 rounded-[12px] border border-border bg-surface-2 p-3.5">
                <div className="flex items-center gap-3">
                  <img
                    src={appIcon}
                    alt=""
                    className="size-9 shrink-0 select-none rounded-[11px]"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-fg">LumiNya</p>
                    <p className="text-[11px] text-fg-subtle">
                      {t('settings.author')} · {t('app.name')}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void window.lumilm.app.openExternal('https://luminya.cc')}
                  >
                    <Globe className="size-3.5" />
                    luminya.cc
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      void window.lumilm.app.openExternal('https://github.com/nekonekos/LumiLM')
                    }
                  >
                    <GitFork className="size-3.5" />
                    nekonekos/LumiLM
                  </Button>
                </div>

                <div className="flex flex-col gap-1 text-[11px]">
                  <span className="text-fg-subtle">{t('settings.website')}</span>
                  <span className="font-mono text-fg-muted">https://luminya.cc</span>
                  <span className="mt-1 text-fg-subtle">{t('settings.repository')}</span>
                  <span className="font-mono text-fg-muted">
                    https://github.com/nekonekos/LumiLM
                  </span>
                </div>

                <blockquote className="rounded-[10px] border-l-2 border-brand bg-surface px-3 py-2">
                  <p className="text-[11px] text-fg-subtle">{t('settings.quote')}</p>
                  <p className="mt-0.5 text-sm font-medium text-brand italic">love with love.</p>
                </blockquote>
              </section>

              <section className="flex flex-col gap-1.5 text-[11px]">
                <Line label={t('settings.version')} value={info?.version ?? '—'} />
                <Line label={t('settings.llamaVersion')} value={info?.llamaVersion ?? '—'} />
                <Line label={t('settings.electron')} value={info?.electron ?? '—'} />
                <Line label="Chromium" value={info?.chrome ?? '—'} />
                <Line label="Node.js" value={info?.node ?? '—'} />
                <Line label="V8" value={info?.v8 ?? '—'} />
                <Line label="OS" value={`${info?.platform ?? '—'} ${info?.arch ?? ''}`} />
              </section>

              {info ? (
                <section className="flex flex-col gap-1.5">
                  <SectionTitle>{t('hardware.backends')}</SectionTitle>
                  {info.llamaBackends.map((backend) => (
                    <div key={backend.kind} className="flex items-center gap-2 text-[11px]">
                      <span className="w-16 font-medium text-fg">{backend.kind.toUpperCase()}</span>
                      <span className="truncate text-fg-subtle">
                        {backend.present ? (backend.path ?? '') : t('hardware.missing')}
                      </span>
                    </div>
                  ))}
                </section>
              ) : null}

              <section className="flex flex-col gap-2">
                <SectionTitle>{t('settings.licenses')}</SectionTitle>
                <p className="text-[11px] leading-snug text-fg-subtle">
                  LumiLM · MIT · llama.cpp · MIT · Electron · MIT · React · MIT
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="self-start"
                  onClick={() => void window.lumilm.app.openExternal('https://github.com/nekonekos/LumiLM')}
                >
                  <ExternalLink className="size-3.5" />
                  {t('settings.openSource')}
                </Button>
              </section>
            </div>
          ) : null}
        </div>
      </Dialog>

      <Dialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title={t('settings.resetAll')}
        description={t('settings.resetConfirm')}
        width="max-w-md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                void reset()
                  .then(() => useModelsStore.getState().load())
                  .then(() => pushToast({ kind: 'success', message: t('toast.settingsReset') }))
                setConfirmReset(false)
              }}
            >
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        <p className="text-xs leading-relaxed text-fg-muted">{t('settings.resetConfirm')}</p>
      </Dialog>
    </>
  )
}

function Line({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="flex items-center gap-2">
      <span className="w-32 shrink-0 text-fg-subtle">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-fg">{value}</span>
    </div>
  )
}
