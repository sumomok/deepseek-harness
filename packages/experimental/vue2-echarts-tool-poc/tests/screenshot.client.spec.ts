/**
 * The capture path on its own: what counts as a PNG data URL, and what the
 * durable reference carries once a store has taken one. The tool spec drives
 * these through a real dispatch; this file covers the decisions the store's own
 * answer decides.
 */
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { decodePngDataUrl, storeChartImage } from '../src/screenshot.ts'
import { FakeAttachments } from './fake-attachments.client.ts'

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='

describe('decodePngDataUrl', () => {
  it('decodes the encoding the browser half sends', () => {
    expect(decodePngDataUrl(PNG_DATA_URL))
      .toEqual(Buffer.from(PNG_DATA_URL.split(',')[1] as string, 'base64'))
  })

  it('refuses anything that is not a PNG data URL', () => {
    for (const value of [
      'https://example.invalid/chart.png',
      'data:image/svg+xml;base64,PHN2Zy8+',
      'data:image/png,notbase64',
      'data:image/png;base64,',
      '',
    ]) {
      expect(decodePngDataUrl(value)).toBeUndefined()
    }
  })
})

describe('storeChartImage', () => {
  it('commits the capture and reports the reference, without the stored name', async () => {
    const attachments = new FakeAttachments(new Context())
    expect(await storeChartImage(attachments, PNG_DATA_URL, 'call_1')).toEqual({
      attachmentId: 'sha256-chart',
      mediaType: 'image/png',
      bytes: 16,
      width: 640,
      height: 320,
    })
    // The stored object still carries a name a human browsing the store can
    // read; the model reads the verdict line instead.
    expect(attachments.saved[0]?.name).toBe('show_chart-call_1.png')
  })

  it('stores nothing for a capture it cannot decode', async () => {
    const attachments = new FakeAttachments(new Context())
    expect(await storeChartImage(attachments, 'not a data url', 'call_3')).toBeUndefined()
    expect(attachments.saved).toEqual([])
  })
})
