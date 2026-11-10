import { describe, expect, it, vi } from 'vitest'
import type { ProtocolClient } from './protocolClient'
import { convertToToolResult, handleCallTool } from './handlers'

vi.mock('./logger', () => ({ log: vi.fn() }))

function contextReturning(result: unknown) {
  const bridge = { callTool: vi.fn().mockResolvedValue(result) } as unknown as ProtocolClient
  return { bridge }
}

describe('convertToToolResult', () => {
  it('wraps a string content in one text block', () => {
    expect(convertToToolResult({ content: '<meeting id="m1"/>' })).toEqual({
      content: [{ type: 'text', text: '<meeting id="m1"/>' }],
    })
  })

  it('passes a text and image content array through unchanged', () => {
    const content = [
      { type: 'text', text: 'screenshot id=s1:' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ]

    expect(convertToToolResult({ content })).toEqual({ content })
  })

  it('serializes an array that holds a malformed part instead of passing it through', () => {
    const data = { content: [{ type: 'image', data: 'iVBORw0KGgo=' }] }

    expect(convertToToolResult(data)).toEqual({
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    })
  })

  it('serializes a result without content as JSON', () => {
    const data = { tools: ['a'] }

    expect(convertToToolResult(data)).toEqual({
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    })
  })
})

describe('handleCallTool', () => {
  it('returns the image block of a get_screenshot result to Claude', async () => {
    const content = [
      { type: 'text', text: 'screenshot id=s1:' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ]
    const context = contextReturning({ content })

    const result = await handleCallTool(context, 'get_screenshot', { screenshot_id: 's1', format: 'base64' })

    expect(context.bridge.callTool).toHaveBeenCalledWith('get_screenshot', { screenshot_id: 's1', format: 'base64' })
    expect(result).toEqual({ content })
  })
})
