import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { ProtocolClient } from './protocolClient'
import { classifyError, formatErrorForUser } from './error'
import { log } from './logger'

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export type ToolResult = { content: ToolContent[]; isError?: boolean }

export type HandlerContext = {
  bridge: ProtocolClient
}

type CallToolRequestShape = {
  params: {
    name: string
    arguments?: unknown
  }
}

export async function handleListTools(context: HandlerContext): Promise<{ tools: unknown[] }> {
  try {
    const { tools } = await context.bridge.listTools()
    return { tools }
  } catch (error) {
    const classified = classifyError(error)
    const message = formatErrorForUser(classified)

    log('error', 'list_tools_failure', {
      kind: classified.kind,
      code: classified.code,
      message,
    })

    // Using console.log writes raw text to stdout (breaking the JSON-RPC stream).
    // Claude Desktop intercepts unparseable stdout during initialization and toasts it.
    console.log(`⚠️ ${message}`)

    throw new Error(message)
  }
}

function isToolContent(part: unknown): part is ToolContent {
  if (typeof part !== 'object' || part === null) {
    return false
  }
  const p = part as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown }
  if (p.type === 'text') {
    return typeof p.text === 'string'
  }
  if (p.type === 'image') {
    return typeof p.data === 'string' && typeof p.mimeType === 'string'
  }
  return false
}

/**
 * Quill answers a direct tool call with the handler's raw result. Its `content` is
 * either a plain string (most tools) or an array of MCP-shaped text/image parts
 * (e.g. get_screenshot), which must pass through so Claude gets the image itself.
 */
export function convertToToolResult(data: unknown): ToolResult {
  if (data && typeof data === 'object' && 'content' in data) {
    const { content } = data as { content: unknown }
    if (typeof content === 'string') {
      return { content: [{ type: 'text', text: content }] }
    }
    if (Array.isArray(content) && content.every(isToolContent)) {
      return { content }
    }
  }

  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

export async function handleCallTool(context: HandlerContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const data = await context.bridge.callTool(name, args)
    return convertToToolResult(data)
  } catch (error) {
    const classified = classifyError(error)
    const message = formatErrorForUser(classified)

    log('error', 'tool_call_failure', {
      toolName: name,
      kind: classified.kind,
      code: classified.code,
      message,
    })

    return {
      content: [{ type: 'text', text: message }],
      isError: true,
    }
  }
}

export function registerHandlers(server: Server, context: HandlerContext): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return handleListTools(context)
  })

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequestShape) => {
    const name = request.params.name
    const rawArgs = request.params.arguments
    const args = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {}
    return handleCallTool(context, name, args)
  })
}
