import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { ProtocolClient } from './protocolClient'
import { classifyError, formatUserMessage } from './error'

export type ToolContent = { type: 'text'; text: string }

export type ToolResponse = { content: ToolContent[]; isError?: boolean }

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
    const message = formatUserMessage(classified)

    // Host-visible breadcrumb for toast routing on list-tools failures.
    console.error(
      '[mcp-toast-signal]',
      JSON.stringify({
        event: 'list_tools_failure',
        kind: classified.kind,
        code: classified.code,
        message,
      }),
    )

    throw new Error(message)
  }
}

function toToolSuccessResponse(data: unknown): ToolResponse {
  if (data && typeof data === 'object' && 'content' in data) {
    return { content: [{ type: 'text', text: String((data as { content: unknown }).content) }] }
  }

  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

export async function handleCallTool(context: HandlerContext, name: string, args: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const data = await context.bridge.callTool(name, args)
    return toToolSuccessResponse(data)
  } catch (error) {
    const classified = classifyError(error)
    const userMessage = formatUserMessage(classified)

    console.error(
      '[mcp-tool-error]',
      JSON.stringify({
        toolName: name,
        kind: classified.kind,
        code: classified.code,
        message: userMessage,
      }),
    )

    return {
      content: [{ type: 'text', text: userMessage }],
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
