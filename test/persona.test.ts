import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { tmpdir: tmp } = await import('node:os')
  return {
    app: { getPath: () => tmp(), getAppPath: () => process.cwd(), isPackaged: false }
  }
})

const { setDataDirOverride, getPaths } = await import('../src/main/store/paths')
const {
  emptyCard,
  fromSillyTavern,
  toSillyTavern,
  parseCardFile,
  normalizeCard,
  listCards,
  getCard,
  resolveCard,
  saveCard,
  removeCard,
  restoreBuiltinCard,
  renderPersona,
  renderRelationship,
  renderMemories,
  renderBoundaries,
  factLine,
  renderEpisodes,
  cardFileName
} = await import('../src/main/companion/persona')
const { DEFAULT_PERSONA_TEMPLATE, BUILTIN_PERSONA_CARD } = await import('@shared/types')
const { DEFAULT_SETTINGS } = await import('../src/main/store/settings')

import type { MemoryFact, MemoryHit } from '@shared/types'

let dataDir = ''

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'lumilm-persona-'))
  setDataDirOverride(dataDir)
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function hit(
  text: string,
  kind: MemoryFact['kind'] = 'other',
  occurrences: MemoryFact['occurrences'] = []
): MemoryHit {
  return {
    fact: {
      id: text,
      text,
      kind,
      subject: 'user',
      importance: 3,
      confidence: 0.8,
      createdAt: 0,
      updatedAt: 0,
      lastUsedAt: 0,
      useCount: 0,
      reinforcements: 0,
      occurrences,
      supersededBy: null,
      mergedFrom: [],
      provenance: [],
      sourceConversationId: null,
      sourceMessageIds: [],
      pinned: false,
      suppressed: false,
      archived: false,
      pending: false,
      embedding: null
    },
    score: 0.5,
    reasons: []
  }
}

describe('normalizeCard', () => {
  it('requires a name', () => {
    expect(normalizeCard({ identity: 'x' })).toBeNull()
    expect(normalizeCard({ name: '  ' })).toBeNull()
    expect(normalizeCard(null)).toBeNull()
  })

  it('fills in the care baseline when a card omits it', () => {
    const card = normalizeCard({ name: 'Lumi' })
    expect(card?.careBaseline.length).toBeGreaterThan(20)
  })

  it('gives a card without an id a fresh one', () => {
    expect(normalizeCard({ name: 'Lumi' })?.id.length).toBeGreaterThan(10)
  })

  it('caps the name length', () => {
    const card = normalizeCard({ name: 'x'.repeat(200) })
    expect(card?.name.length).toBe(60)
  })
})

describe('SillyTavern interoperability', () => {
  const v2 = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '凛',
      description: '一个安静的女孩子。\n\n说话很轻，喜欢看书。',
      personality: '温柔',
      scenario: '冬天的图书馆',
      first_mes: '你来了。',
      mes_example: '{{user}}: 你好\n{{char}}: 嗯。\n<START>\n{{user}}: 再见\n{{char}}: 路上小心。',
      creator_notes: '作者备注'
    }
  }

  it('splits the description into identity and personality', () => {
    const card = fromSillyTavern(v2)
    expect(card?.name).toBe('凛')
    expect(card?.identity).toBe('一个安静的女孩子。')
    expect(card?.personality).toBe('说话很轻，喜欢看书。')
  })

  it('maps the remaining fields', () => {
    const card = fromSillyTavern(v2)
    expect(card?.speechStyle).toBe('温柔')
    expect(card?.scenario).toBe('冬天的图书馆')
    expect(card?.firstMessage).toBe('你来了。')
    expect(card?.notes).toBe('作者备注')
  })

  it('turns the <START> separator into a blank line', () => {
    const card = fromSillyTavern(v2)
    expect(card?.examples).not.toContain('<START>')
    expect(card?.examples).toContain('路上小心。')
  })

  it('reads a flat V1 card', () => {
    const card = fromSillyTavern({ name: 'A', description: 'B' })
    expect(card?.identity).toBe('B')
  })

  it('round-trips through the V2 exporter', () => {
    const original = { ...emptyCard(), name: '凛', identity: '安静', examples: 'a\n\nb' }
    const back = fromSillyTavern(toSillyTavern(original))
    expect(back?.name).toBe('凛')
    expect(back?.identity).toBe('安静')
    expect(back?.examples).toContain('a')
    expect(back?.examples).toContain('b')
  })

  it('rejects a card with no name', () => {
    expect(fromSillyTavern({ description: 'x' })).toBeNull()
  })
})

describe('parseCardFile', () => {
  it('prefers the native shape when the fields are present', () => {
    const native = { ...emptyCard(), name: 'Lumi', speechStyle: '轻' }
    const parsed = parseCardFile(JSON.stringify(native))
    expect(parsed?.speechStyle).toBe('轻')
    // Importing always creates a new card rather than overwriting the source.
    expect(parsed?.id).not.toBe(native.id)
  })

  it('falls back to the SillyTavern mapping', () => {
    const parsed = parseCardFile(JSON.stringify({ name: '凛', description: '安静' }))
    expect(parsed?.name).toBe('凛')
    expect(parsed?.identity).toBe('安静')
  })

  it('returns null for junk', () => {
    expect(parseCardFile('not json')).toBeNull()
    expect(parseCardFile('42')).toBeNull()
  })
})

describe('card storage', () => {
  it('seeds the builtin card on first use', () => {
    const cards = listCards()
    expect(cards).toHaveLength(1)
    expect(cards[0].id).toBe(BUILTIN_PERSONA_CARD.id)
    expect(readdirSync(getPaths().personasDir)).toContain(`${BUILTIN_PERSONA_CARD.id}.json`)
  })

  it('saves, lists and removes a card', () => {
    listCards()
    const card = { ...emptyCard(), name: '凛' }
    saveCard(card)
    expect(listCards().map((entry) => entry.name)).toContain('凛')

    removeCard(card.id)
    expect(getCard(card.id)).toBeNull()
  })

  it('re-seeds the builtin card when the user deletes their only card', () => {
    listCards()
    removeCard(BUILTIN_PERSONA_CARD.id)
    // The companion must always have a persona to speak with, so an empty
    // folder gets the shipped card back.
    const cards = listCards()
    expect(cards).toHaveLength(1)
    expect(cards[0].id).toBe(BUILTIN_PERSONA_CARD.id)
  })

  it('keeps the builtin card deleted while another card exists', () => {
    listCards()
    saveCard({ ...emptyCard(), name: '凛' })
    removeCard(BUILTIN_PERSONA_CARD.id)
    expect(readdirSync(getPaths().personasDir)).not.toContain(
      `${BUILTIN_PERSONA_CARD.id}.json`
    )
    expect(listCards().map((entry) => entry.name)).toEqual(['凛'])
  })

  it('restores the builtin card on request', () => {
    listCards()
    removeCard(BUILTIN_PERSONA_CARD.id)
    restoreBuiltinCard()
    expect(listCards()[0].id).toBe(BUILTIN_PERSONA_CARD.id)
  })

  it('rejects a card without a name', () => {
    expect(() => saveCard({ ...emptyCard(), name: '' })).toThrow()
  })

  it('skips an unreadable card file instead of failing', () => {
    listCards()
    writeFileSync(join(getPaths().personasDir, 'broken.json'), '{ not json', 'utf8')
    expect(listCards().length).toBeGreaterThan(0)
  })
})

describe('resolveCard', () => {
  it('falls back to the builtin card when nothing matches', () => {
    expect(resolveCard('does-not-exist').id).toBe(BUILTIN_PERSONA_CARD.id)
  })

  it('prefers the conversation override over the settings preference', () => {
    const first = { ...emptyCard(), name: 'A' }
    const second = { ...emptyCard(), name: 'B' }
    saveCard(first)
    saveCard(second)
    expect(resolveCard(first.id, second.id).name).toBe('B')
  })
})

describe('renderPersona', () => {
  it('substitutes the card fields into the template', () => {
    const card = { ...emptyCard(), name: 'Lumi', identity: '你是安静的', speechStyle: '短句' }
    const { text } = renderPersona(card, DEFAULT_PERSONA_TEMPLATE, 0)
    expect(text).toContain('名字是 Lumi')
    expect(text).toContain('你是安静的')
    expect(text).toContain('短句')
  })

  it('drops the optional sections when they are empty', () => {
    const card = { ...emptyCard(), name: 'Lumi', identity: 'x', careBaseline: '' }
    const { text } = renderPersona(card, DEFAULT_PERSONA_TEMPLATE, 0)
    expect(text).not.toContain('关怀基线')
  })

  it('reports the estimated token count', () => {
    const card = { ...emptyCard(), name: 'Lumi', identity: '安静的女孩子' }
    const result = renderPersona(card, DEFAULT_PERSONA_TEMPLATE, 0)
    expect(result.tokens).toBeGreaterThan(0)
    expect(result.truncated).toBe(false)
  })

  it('trims to the token limit on a line boundary', () => {
    const card = {
      ...emptyCard(),
      name: 'Lumi',
      identity: 'x'.repeat(400),
      personality: 'y'.repeat(400),
      speechStyle: 'z'.repeat(400)
    }
    const result = renderPersona(card, DEFAULT_PERSONA_TEMPLATE, 200)
    expect(result.truncated).toBe(true)
    expect(result.tokens).toBeLessThanOrEqual(200)
    expect(result.text.startsWith('你是一位与用户长期相处的数字伴侣')).toBe(true)
  })

  it('is byte-identical for the same card, which is what makes the cache work', () => {
    const card = { ...emptyCard(), name: 'Lumi', identity: '安静' }
    const first = renderPersona(card, DEFAULT_PERSONA_TEMPLATE, 0).text
    const second = renderPersona(card, DEFAULT_PERSONA_TEMPLATE, 0).text
    expect(first).toBe(second)
  })

  it('keeps the shipped card inside the default budget', () => {
    // A card that overflows is silently trimmed, which would quietly drop the
    // boundaries and examples that hold the persona together.
    const limit = DEFAULT_SETTINGS.companion.personaTokenLimit
    const result = renderPersona(BUILTIN_PERSONA_CARD, DEFAULT_PERSONA_TEMPLATE, 0)
    expect(result.tokens).toBeLessThanOrEqual(limit)
  })
})

describe('relationship and memory rendering', () => {
  it('describes the relationship on one line', () => {
    const line = renderRelationship(
      {
        stage: '亲近的伴侣',
        affinity: 72,
        nicknameForUser: '宝贝',
        nicknameForAssistant: null,
        mood: '想你',
        knownSince: Date.now() - 10 * 86_400_000,
        lastInteractionAt: 0
      },
      'Lumi'
    )
    expect(line).toContain('亲近的伴侣')
    expect(line).toContain('宝贝')
    expect(line).toContain('想你')
    expect(line).toContain('10 天')
    expect(line.split('\n')).toHaveLength(1)
  })

  it('omits the day count before the first interaction', () => {
    const line = renderRelationship(
      {
        stage: '陌生人',
        affinity: 0,
        nicknameForUser: null,
        nicknameForAssistant: null,
        mood: null,
        knownSince: 0,
        lastInteractionAt: 0
      },
      'Lumi'
    )
    expect(line).not.toContain('你们认识')
  })

  it('separates boundary facts from ordinary ones', () => {
    const hits = [hit('用户讨厌香菜'), hit('用户对打雷有强烈恐惧', 'boundary')]
    expect(renderMemories(hits)).toBe('- 用户讨厌香菜')
    expect(renderBoundaries(hits)).toBe('- 用户对打雷有强烈恐惧')
  })

  it('carries an event’s history into the prompt', () => {
    const now = Date.parse('2026-03-10T12:00:00')
    const repeated = hit('用户加班到很晚', 'event', [
      { at: now, dateKey: '2026-03-10', note: '用户又加班了', conversationId: 'c1' },
      { at: now - 86_400_000, dateKey: '2026-03-09', note: '用户加班到很晚', conversationId: 'c1' },
      { at: now - 3 * 86_400_000, dateKey: '2026-03-07', note: '用户加班到很晚', conversationId: 'c1' }
    ])
    expect(factLine(repeated.fact, now)).toBe('用户加班到很晚（已发生 3 次，最近一次是今天）')
    expect(renderMemories([repeated])).toContain('已发生 3 次')
  })

  it('names the day when the last occurrence was not today', () => {
    const now = Date.parse('2026-03-10T12:00:00')
    const once = hit('用户加班到很晚', 'event', [
      { at: now - 2 * 86_400_000, dateKey: '2026-03-08', note: 'x', conversationId: null }
    ])
    expect(factLine(once.fact, now)).toBe('用户加班到很晚（最近一次 03-08）')
  })

  it('says yesterday when that is what it was', () => {
    const now = Date.parse('2026-03-10T12:00:00')
    const recent = hit('用户加班到很晚', 'event', [
      { at: now - 86_400_000, dateKey: '2026-03-09', note: 'x', conversationId: null }
    ])
    expect(factLine(recent.fact, now)).toBe('用户加班到很晚（最近一次是昨天）')
  })

  it('leaves a fact with no timeline exactly as it was', () => {
    expect(factLine(hit('用户讨厌香菜').fact)).toBe('用户讨厌香菜')
  })

  it('renders episodes newest first with their highlights', () => {
    const text = renderEpisodes([
      {
        id: 'e1',
        date: '2026-02-01',
        conversationId: 'c1',
        summary: '聊了猫',
        highlights: ['小黑'],
        emotion: '开心',
        createdAt: 0
      }
    ])
    expect(text).toContain('2026-02-01')
    expect(text).toContain('聊了猫')
    expect(text).toContain('小黑')
  })

  it('sanitises the export file name', () => {
    expect(cardFileName({ ...emptyCard(), name: 'a/b:c' })).toBe('a_b_c.json')
  })
})
