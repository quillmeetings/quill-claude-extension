import os from 'os'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { SOCKET_CONFIG } from './socketConfig'
import { EXTENSION_VERSION } from './version'
import { ConnectionManager } from './lib/connectionManager'

const server = new Server(
  {
    name: 'quill-claude-extension',
    version: EXTENSION_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
)

const TIMEOUT_MS = 10000
const isWindows = os.platform() === 'win32'
const SOCKET_PATH = isWindows ? SOCKET_CONFIG.paths.windows : SOCKET_CONFIG.paths.darwin

const connectionManager = new ConnectionManager({
  socketPath: SOCKET_PATH,
  isWindows,
  openTimeoutMs: TIMEOUT_MS,
  requestTimeoutMs: TIMEOUT_MS,
  maxRetries: 2,
})

async function fetchTools() {
  try {
    const response = (await connectionManager.request('list_tools', {})) as { tools: unknown[] }
    return response
  } catch (error) {
    console.error('Failed to fetch tools from backend', error)
    throw error
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { tools } = await fetchTools()
  return { tools }
})

server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  const name = request.params.name as string
  const args = (request.params.arguments ?? {}) as Record<string, unknown>

  try {
    const data = await connectionManager.request(name, args)
    if (data && typeof data === 'object' && 'content' in data) {
      return { content: [{ type: 'text', text: String((data as { content: unknown }).content) }] }
    }
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'

    console.error('Error calling tool', name, args, error)
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
  }
})

const transport = new StdioServerTransport()
void server.connect(transport)
console.error('Quill MCP server running...')
