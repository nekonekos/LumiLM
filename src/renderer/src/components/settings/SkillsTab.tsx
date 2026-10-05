import { useEffect, type ReactNode } from 'react'
import { FolderOpen, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Badge, Button, Field, IconButton, SectionTitle, Switch } from '@/components/ui'
import { useT } from '@/i18n'
import { useSettingsStore } from '@/stores/settings'
import { useSkillsStore } from '@/stores/skills'

/** Global skill discovery: where LumiLM looks, and which skills start enabled. */
export function SkillsTab(): ReactNode {
  const t = useT()
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  const { skills, refresh, refreshDirectories, addDirectory, removeDirectory } = useSkillsStore()

  useEffect(() => {
    void refresh()
    void refreshDirectories()
  }, [refresh, refreshDirectories])

  if (!settings) return null
  const directories = settings.skills.directories
  const defaultEnabled = settings.skills.defaultEnabledIds

  const toggleDefault = async (id: string): Promise<void> => {
    const next = defaultEnabled.includes(id)
      ? defaultEnabled.filter((entry) => entry !== id)
      : [...defaultEnabled, id]
    await update({ skills: { defaultEnabledIds: next } })
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3">
        <SectionTitle>{t('skills.title')}</SectionTitle>
        <p className="text-[11px] leading-snug text-fg-subtle">{t('skills.subtitle')}</p>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" onClick={() => void addDirectory()}>
            <Plus className="size-3.5" />
            {t('skills.addDirectory')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void refresh()}>
            <RefreshCw className="size-3.5" />
            {t('common.refresh')}
          </Button>
        </div>

        <Field label={t('settings.skillsDirectories')}>
          <div className="flex flex-col gap-1">
            {directories.length === 0 ? (
              <span className="text-[11px] text-fg-subtle">{t('common.none')}</span>
            ) : null}
            {directories.map((directory) => (
              <div
                key={directory}
                className="flex items-center gap-2 rounded-[8px] border border-border px-2.5 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-fg-muted">
                  {directory}
                </span>
                <IconButton
                  label={t('skills.openFolder')}
                  className="size-6"
                  onClick={() => void window.lumilm.skills.openFolder(directory)}
                >
                  <FolderOpen className="size-3" />
                </IconButton>
                <IconButton
                  label={t('common.delete')}
                  className="size-6"
                  onClick={() => void removeDirectory(directory)}
                >
                  <Trash2 className="size-3" />
                </IconButton>
              </div>
            ))}
          </div>
        </Field>
      </section>

      <section className="flex flex-col gap-2">
        <SectionTitle>{t('skills.title')}</SectionTitle>

        {skills.length === 0 ? (
          <p className="rounded-[8px] bg-surface-2 px-2.5 py-2 text-[11px] leading-snug text-fg-subtle">
            {t('skills.empty')} {t('skills.emptyHint')}
          </p>
        ) : null}

        {skills.map((skill) => {
          const invalid = skill.error !== null
          return (
            <div
              key={skill.id}
              className="flex items-start gap-2 rounded-[9px] border border-border px-2.5 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[11px] text-fg">{skill.name}</span>
                  <Badge tone="neutral">{skill.format}</Badge>
                  {invalid ? <Badge tone="danger">{t('skills.invalid')}</Badge> : null}
                </div>
                <p className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-fg-subtle">
                  {invalid ? skill.error : skill.description}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <span className="text-[10px] text-fg-subtle">
                  {t('skills.enableForConversation')}
                </span>
                <Switch
                  checked={defaultEnabled.includes(skill.id)}
                  disabled={invalid}
                  label={skill.name}
                  onChange={() => void toggleDefault(skill.id)}
                />
                <IconButton
                  label={t('skills.reveal')}
                  className="size-6"
                  onClick={() => void window.lumilm.skills.revealFile(skill.sourcePath)}
                >
                  <FolderOpen className="size-3" />
                </IconButton>
              </div>
            </div>
          )
        })}
      </section>
    </div>
  )
}
