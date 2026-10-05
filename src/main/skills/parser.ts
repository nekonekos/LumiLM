import { parse as parseYaml } from 'yaml'

export interface ParsedSkill {
  name: string
  description: string
  systemPrompt: string
  allowedTools: string[]
  format: 'skill-md' | 'json'
  /** non-null when the skill is unusable; the string is shown to the user */
  error: string | null
}

/**
 * Splits a leading YAML frontmatter block from the markdown body.
 * Frontmatter is only recognised at the very start of the file.
 */
export function splitFrontmatter(raw: string): { front: string | null; body: string } {
  const text = raw.replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) return { front: null, body: text }

  const end = text.indexOf('\n---', 3)
  if (end < 0) return { front: null, body: text }

  const front = text.slice(text.indexOf('\n', 3) + 1, end)
  const rest = text.slice(end + 4)
  return { front, body: rest.replace(/^\r?\n/, '') }
}

function readString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

function readStringList(source: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    }
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    }
  }
  return []
}

/** `SKILL.md`: YAML frontmatter for metadata, markdown body for the L2 prompt. */
export function parseSkillMarkdown(raw: string, fallbackName: string): ParsedSkill {
  const { front, body } = splitFrontmatter(raw)

  const base: ParsedSkill = {
    name: fallbackName,
    description: '',
    systemPrompt: body.trim(),
    allowedTools: [],
    format: 'skill-md',
    error: null
  }

  if (front === null) {
    return { ...base, error: 'SKILL.md has no YAML frontmatter' }
  }

  let metadata: unknown
  try {
    metadata = parseYaml(front)
  } catch (error) {
    return { ...base, error: `frontmatter is not valid YAML: ${(error as Error).message}` }
  }

  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return { ...base, error: 'frontmatter must be a mapping' }
  }

  const source = metadata as Record<string, unknown>
  const description = readString(source, ['description'])
  if (!description) return { ...base, error: 'frontmatter must define a description' }

  return {
    ...base,
    name: readString(source, ['name']) ?? fallbackName,
    description,
    allowedTools: readStringList(source, ['allowed-tools', 'allowedTools', 'allowed_tools'])
  }
}

/** The lightweight LumiLM-native alternative to `SKILL.md`. */
export function parseSkillJson(raw: string, fallbackName: string): ParsedSkill {
  const base: ParsedSkill = {
    name: fallbackName,
    description: '',
    systemPrompt: '',
    allowedTools: [],
    format: 'json',
    error: null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ...base, error: `invalid JSON: ${(error as Error).message}` }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...base, error: 'skill file must contain a JSON object' }
  }

  const source = parsed as Record<string, unknown>
  const description = readString(source, ['description'])
  if (!description) return { ...base, error: 'skill must define a description' }

  return {
    ...base,
    name: readString(source, ['name']) ?? fallbackName,
    description,
    systemPrompt: readString(source, ['systemPrompt', 'prompt', 'instructions']) ?? '',
    allowedTools: readStringList(source, ['allowedTools', 'allowed-tools', 'tools'])
  }
}
