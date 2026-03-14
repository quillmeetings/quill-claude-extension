#!/usr/bin/env node

import os from 'os'
import net from 'net'
import WebSocket from 'ws'
import type { RawData } from 'ws'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export const EXTENSION_VERSION = '0.1.4'

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
const SOCKET_PATH = isWindows ? '\\\\.\\pipe\\quill_mcp' : '/tmp/quill_mcp.sock'

// ws+unix works on Unix sockets; Windows named pipes are handled via createConnection.
const CLIENT_URL = isWindows ? 'ws://localhost' : `ws+unix://${SOCKET_PATH}`

type PendingEntry = {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: NodeJS.Timeout
}

let ws: WebSocket | undefined
let nextId = 1
const pending = new Map<string, PendingEntry>()
let cachedSchemaVersion: number | null = null

async function fetchTools() {
  try {
    const response = (await callBridge('list_tools', {})) as { version: number; tools: unknown[] }
    const { version, tools } = response
    if (cachedSchemaVersion === null) {
      cachedSchemaVersion = version
    } else if (cachedSchemaVersion !== version) {
      cachedSchemaVersion = version
    }
    return { version, tools }
  } catch (error) {
    console.error('Failed to fetch tools from backend', error)
    throw error
  }
}

function ensureSocket(): WebSocket {
  if (ws) {
    if (ws.readyState === WebSocket.OPEN) return ws
    if (ws.readyState === WebSocket.CONNECTING) return ws
    if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
      try {
        ws.terminate()
      } catch {
        // no-op
      }
      ws = undefined
    }
  }

  const wsOptions = isWindows
    ? {
        createConnection: () => net.connect(SOCKET_PATH),
      }
    : {}

  ws = new WebSocket(CLIENT_URL, wsOptions)

  ws.on('open', () => {
    console.error('Connected to Quill MCP server')
  })

  ws.on('message', (raw: RawData) => {
    try {
      const msg = JSON.parse(raw.toString()) as { id?: string | number; result?: unknown; error?: unknown }
      const { id, result, error } = msg
      if (!id) return
      const idString = String(id)
      const entry = pending.get(idString)
      if (!entry) return
      pending.delete(idString)
      clearTimeout(entry.timer)
      if (error) entry.reject(new Error(String(error)))
      else entry.resolve(result)
    } catch (error) {
      console.error('mcp_ws_event', 'parse_error', error)
    }
  })

  ws.on('close', (code: number, reason: Buffer) => {
    console.error('mcp_ws_event', 'close', { code, reason })
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('Failed to connect. Make sure Quill is running.'))
    }
    pending.clear()
  })

  ws.on('error', (error: Error) => {
    console.error('mcp_socket_error', error)
  })

  return ws
}

function waitForOpen(sock: WebSocket, timeoutMs = TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    if (sock.readyState === WebSocket.OPEN) {
      resolve()
      return
    }

    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onClose = () => {
      cleanup()
      reject(new Error('socket_closed'))
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('socket_open_timeout'))
    }, timeoutMs)

    function cleanup() {
      clearTimeout(timer)
      sock.off('open', onOpen)
      sock.off('close', onClose)
      sock.off('error', onError)
    }

    sock.once('open', onOpen)
    sock.once('close', onClose)
    sock.once('error', onError)
  })
}

async function callBridge(method: string, params: Record<string, unknown>): Promise<unknown> {
  const sock = ensureSocket()
  await waitForOpen(sock)
  if (sock.readyState !== WebSocket.OPEN) {
    throw new Error('socket_not_open')
  }

  const id = String(nextId++)
  const payload = JSON.stringify({ id, method, params })
  const responsePromise = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('timeout'))
    }, TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
  })

  sock.send(payload, (err?: Error) => {
    if (!err) return
    const entry = pending.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    pending.delete(id)
    entry.reject(err)
  })

  return responsePromise
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { tools } = await fetchTools()
  return { tools }
})

server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  const name = request.params.name as string
  const args = (request.params.arguments ?? {}) as Record<string, unknown>

  try {
    const params = {
      ...args,
      _clientSchemaVersion: cachedSchemaVersion,
    }
    const data = await callBridge(name, params)
    if (data && typeof data === 'object' && '_schemaVersion' in data && 'content' in data) {
      return { content: [{ type: 'text', text: String((data as { content: unknown }).content) }] }
    }
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'

    try {
      const errorObj = JSON.parse(message) as { code?: string; clientVersion?: string }
      if (errorObj.code === 'schema_outdated') {
        console.error(
          `Schema version mismatch detected. Found ${cachedSchemaVersion}, expected ${errorObj.clientVersion}. Sending tool_list_changed notification.`,
        )
        cachedSchemaVersion = null
        await server.sendToolListChanged()
        return {
          content: [
            {
              type: 'text',
              text: 'Schema version mismatch. The tool schemas have been updated. Please retry your request.',
            },
          ],
          isError: true,
        }
      }
    } catch {
      // Non-JSON errors are surfaced below.
    }

    console.error('Error calling tool', name, args, error)
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
  }
})

const transport = new StdioServerTransport()
void server.connect(transport)
console.error('Quill MCP server running...')
