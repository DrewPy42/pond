import { mount, flushPromises } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import QrCode from './QrCode.vue'

describe('QrCode', () => {
  it('renders the value as an image data URL', async () => {
    const w = mount(QrCode, {
      props: { value: 'otpauth://totp/Pond:a?secret=ABC&issuer=Pond', label: 'Scan me' },
    })
    await flushPromises()
    const img = w.get('img')
    expect(img.attributes('src')).toMatch(/^data:image\/svg\+xml/)
    expect(img.attributes('alt')).toBe('Scan me')
  })
})
