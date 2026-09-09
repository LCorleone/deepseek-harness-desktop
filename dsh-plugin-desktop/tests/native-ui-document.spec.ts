import { describe, expect, it } from 'vitest'
import { nativeUiDocumentUrl } from '../src/native-ui-document.ts'

describe('nativeUiDocumentUrl', () => {
  it('encodes the physical path canonically with its query', () => {
    const url = nativeUiDocumentUrl('/opt/DSH Desktop/app.asar.unpacked/lib/native-ui/recovery.html', {
      state: 'eyJzdGF0ZSI6MX0',
    })
    expect(url).toBe('file:///opt/DSH%20Desktop/app.asar.unpacked/lib/native-ui/recovery.html?state=eyJzdGF0ZSI6MX0')
  })

  it('emits a plain canonical file URL without a query', () => {
    expect(nativeUiDocumentUrl('/opt/x/lib/native-ui/agent-browser.html'))
      .toBe('file:///opt/x/lib/native-ui/agent-browser.html')
  })

  it('percent-encodes query values that are not URL-safe', () => {
    expect(nativeUiDocumentUrl('/d.html', { locale: 'e n' })).toBe('file:///d.html?locale=e+n')
  })
})
