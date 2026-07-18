import { describe, expect, it } from 'vitest'
import { bucketLetter, paginate } from './browse'

describe('bucketLetter', () => {
  it('buckets by lowercase first letter', () => {
    expect(bucketLetter('Hello')).toBe('h')
    expect(bucketLetter('zebra')).toBe('z')
  })

  it('buckets non-alphabetic first characters as "other"', () => {
    expect(bucketLetter('中文')).toBe('other')
    expect(bucketLetter('123abc')).toBe('other')
  })
})

describe('paginate', () => {
  it('chunks items into fixed-size pages', () => {
    expect(paginate([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('returns a single empty page for an empty list', () => {
    expect(paginate([], 200)).toEqual([[]])
  })

  it('returns a single page when everything fits', () => {
    expect(paginate([1, 2], 200)).toEqual([[1, 2]])
  })
})
