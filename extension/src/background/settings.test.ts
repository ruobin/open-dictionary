import { beforeEach, describe, expect, it } from 'vitest'
import { installFakeChromeStorage } from './testUtils'
import { DEFAULT_SETTINGS, getSettings, setSettings } from './settings'

describe('background/settings', () => {
  beforeEach(() => {
    installFakeChromeStorage()
  })

  it('returns DEFAULT_SETTINGS on first run (nothing stored yet)', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('persists a partial patch, merged onto the current settings', async () => {
    const updated = await setSettings({ sourceLang: 'es' })

    expect(updated).toEqual({ ...DEFAULT_SETTINGS, sourceLang: 'es' })
    expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, sourceLang: 'es' })
  })

  it('applies multiple patches cumulatively', async () => {
    await setSettings({ sourceLang: 'es' })
    await setSettings({ targetLang: 'fr' })
    const final = await setSettings({ showSelectionIcon: false })

    expect(final).toEqual({ sourceLang: 'es', targetLang: 'fr', showSelectionIcon: false })
  })

  it('fills in missing fields from DEFAULT_SETTINGS when reading a partial stored value', async () => {
    // Simulates a forward-compatible addition to ExtensionSettings: an
    // older stored value only has some of the current fields.
    await setSettings({ sourceLang: 'de' })
    const settings = await getSettings()

    expect(settings.sourceLang).toBe('de')
    expect(settings.targetLang).toBe(DEFAULT_SETTINGS.targetLang)
    expect(settings.showSelectionIcon).toBe(DEFAULT_SETTINGS.showSelectionIcon)
  })
})
