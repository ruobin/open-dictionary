import { describe, expect, it } from 'vitest'
import { parseUserAgent } from './userAgent'

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36'
const ANDROID_TABLET_CHROME =
  'Mozilla/5.0 (Linux; Android 14; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
const IPAD_SAFARI =
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const WINDOWS_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
const WINDOWS_EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0'
const MACOS_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
const MACOS_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
const LINUX_FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0'
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
const CURL = 'curl/8.4.0'

describe('parseUserAgent', () => {
  it('returns unknown for an empty/missing UA', () => {
    expect(parseUserAgent(undefined)).toEqual({ type: 'unknown' })
    expect(parseUserAgent('')).toEqual({ type: 'unknown' })
    expect(parseUserAgent('   ')).toEqual({ type: 'unknown' })
  })

  it('detects iPhone Safari as mobile', () => {
    expect(parseUserAgent(IPHONE_SAFARI)).toEqual({ type: 'mobile', browser: 'Safari', os: 'iOS' })
  })

  it('detects Android Chrome (phone) as mobile', () => {
    expect(parseUserAgent(ANDROID_CHROME)).toEqual({ type: 'mobile', browser: 'Chrome', os: 'Android' })
  })

  it('detects an Android tablet (no "Mobile" token) as tablet', () => {
    expect(parseUserAgent(ANDROID_TABLET_CHROME)).toEqual({ type: 'tablet', browser: 'Chrome', os: 'Android' })
  })

  it('detects iPad as tablet', () => {
    expect(parseUserAgent(IPAD_SAFARI)).toEqual({ type: 'tablet', browser: 'Safari', os: 'iOS' })
  })

  it('detects Windows Chrome as desktop', () => {
    expect(parseUserAgent(WINDOWS_CHROME)).toEqual({ type: 'desktop', browser: 'Chrome', os: 'Windows' })
  })

  it('detects Windows Edge distinctly from Chrome', () => {
    expect(parseUserAgent(WINDOWS_EDGE)).toEqual({ type: 'desktop', browser: 'Edge', os: 'Windows' })
  })

  it('detects macOS Safari as desktop', () => {
    expect(parseUserAgent(MACOS_SAFARI)).toEqual({ type: 'desktop', browser: 'Safari', os: 'macOS' })
  })

  it('detects macOS Chrome distinctly from Safari', () => {
    expect(parseUserAgent(MACOS_CHROME)).toEqual({ type: 'desktop', browser: 'Chrome', os: 'macOS' })
  })

  it('detects Linux Firefox as desktop', () => {
    expect(parseUserAgent(LINUX_FIREFOX)).toEqual({ type: 'desktop', browser: 'Firefox', os: 'Linux' })
  })

  it('classifies Googlebot as a bot, ignoring OS/browser', () => {
    expect(parseUserAgent(GOOGLEBOT)).toEqual({ type: 'bot' })
  })

  it('classifies curl as a bot', () => {
    expect(parseUserAgent(CURL)).toEqual({ type: 'bot' })
  })
})
