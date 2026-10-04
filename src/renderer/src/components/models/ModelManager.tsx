import { useEffect, useState, type ReactNode } from 'react'
import { FolderPlus, HardDriveDownload, Plus, RefreshCw, Sparkles } from 'lucide-react'
import type { ModelInfo } from '@shared/types'
import { Badge, Button, Dialog, EmptyHint, SectionTitle, Spinner } from '@/components/ui'
import { formatBytes } from '@/lib/format'
import { useT } from '@/i18n'
import { useModelsStore } from '@/stores/models'
import { useSettingsStore } from '@/stores/settings'
import { HardwarePanel } from './HardwarePanel'
import { ModelCard } from './ModelCard'

export function ModelManager(): ReactNode {
  const t = useT()
  const models = useModelsStore((state) => state.models)
  const loading = useModelsStore((state) => state.loading)
  const suggestion = useModelsStore((state) => state.suggestion)
  const addFiles = useModelsStore((state) => state.addFiles)
  const addFolder = useModelsStore((state) => state.addFolder)
  const addPaths = useModelsStore((state) => state.addPaths)
  const refresh = useModelsStore((state) => state.refresh)
  const suggest = useModelsStore((state) => state.suggest)
  const removeModel = useModelsStore((state) => state.remove)
  const activeModelId = useSettingsStore((state) => state.settings?.models.activeModelId ?? null)

  const [removing, setRemoving] = useState<ModelInfo | null>(null)

  useEffect(() => {
    if (models.length === 0) void suggest()
  }, [models.length, suggest])

  const candidates = suggestion?.candidates ?? []

  const confirmRemove = async (): Promise<void> => {
    if (!removing) return
    await removeModel(removing.id)
    setRemoving(null)
  }

  return (
    <div className="flex flex-col gap-5">
      <HardwarePanel />

      <section className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <SectionTitle>{t('models.title')}</SectionTitle>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" loading={loading} onClick={() => void refresh()}>
            <RefreshCw className="size-3.5" />
            {t('models.refresh')}
          </Button>
        </div>

        <p className="text-[11px] leading-snug text-fg-subtle">{t('models.subtitle')}</p>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => void addFiles()}>
            <Plus className="size-3.5" />
            {t('models.addFiles')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void addFolder()}>
            <FolderPlus className="size-3.5" />
            {t('models.addFolder')}
          </Button>
        </div>
      </section>

      {models.length === 0 ? (
        candidates.length > 0 ? (
          <section className="flex flex-col gap-2 rounded-[12px] border border-brand bg-brand-soft/50 p-3">
            <div className="flex items-center gap-2">
              <Sparkles className="size-3.5 text-brand" />
              <span className="text-xs font-semibold text-fg">{t('models.suggestTitle')}</span>
            </div>
            <p className="text-[11px] leading-snug text-fg-muted">{t('models.suggestBody')}</p>

            <ul className="flex flex-col gap-1">
              {candidates.map((candidate) => (
                <li
                  key={candidate.modelPath}
                  className="flex items-center gap-2 rounded-[9px] bg-surface px-2 py-1.5"
                >
                  <HardDriveDownload className="size-3.5 shrink-0 text-fg-subtle" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] text-fg">
                      {candidate.modelPath.split(/[\\/]/).pop()}
                    </span>
                    <span className="block truncate text-[10px] text-fg-subtle">
                      {candidate.modelPath}
                    </span>
                  </span>
                  <Badge tone="neutral">{formatBytes(candidate.sizeBytes, 1)}</Badge>
                </li>
              ))}
            </ul>

            <Button
              size="sm"
              variant="primary"
              className="justify-center"
              onClick={() => void addPaths(candidates.map((candidate) => candidate.modelPath))}
            >
              {t('models.addSelected')}
            </Button>
          </section>
        ) : (
          <EmptyHint>
            {loading ? <Spinner className="size-3.5" /> : null} {t('models.empty')}
          </EmptyHint>
        )
      ) : (
        <div className="flex flex-col gap-2">
          {models.map((model) => (
            <ModelCard
              key={model.id}
              model={model}
              active={activeModelId === model.id}
              onRemove={setRemoving}
            />
          ))}
        </div>
      )}

      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={t('models.remove')}
        description={t('models.removeConfirm')}
        width="max-w-md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={() => void confirmRemove()}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <p className="text-xs text-fg-muted">{removing?.path}</p>
        <p className="mt-1 text-[11px] text-fg-subtle">{t('models.removeConfirm')}</p>
      </Dialog>
    </div>
  )
}
