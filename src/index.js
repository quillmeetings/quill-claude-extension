#!/usr/bin/env node

// @ts-check

import os from 'os'
import net from 'net'
import WebSocket from 'ws'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  {
    name: 'quill-claude-extension',
    version: '0.1.4',
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

// WebSocket connection URL configuration:
// - Unix/macOS: The 'ws' library natively supports ws+unix:// URLs for Unix domain sockets
// - Windows: The 'ws' library does NOT support ws+pipe:// URLs for named pipes.
//   We use a placeholder URL here and provide the actual connection via createConnection option.
//   See ensureSocket() for the Windows named pipe connection handling.
const CLIENT_URL = isWindows ? 'ws://localhost' : `ws+unix://${SOCKET_PATH}`

/** @type {WebSocket | undefined} */
let ws
let nextId = 1
/** @type {Map<string, {resolve:Function, reject:Function, timer:NodeJS.Timeout}>} */
const pending = new Map()

/** @type {number | null} */
let cachedSchemaVersion = null

/**
 * Fetches tools from backend and caches the schema version
 */
async function fetchTools() {
  try {
    const { version, tools } = await callBridge('list_tools', {})
    if (cachedSchemaVersion === null) {
      // First time initialization
      cachedSchemaVersion = version
    } else if (cachedSchemaVersion !== version) {
      // Schema changed
      cachedSchemaVersion = version
      // Notify will happen in the caller
    }
    return { version, tools }
  } catch (error) {
    console.error('Failed to fetch tools from backend', error)
    throw error
  }
}

function ensureSocket() {
  if (ws) {
    if (ws.readyState === WebSocket.OPEN) return ws
    if (ws.readyState === WebSocket.CONNECTING) return ws
    if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
      try {
        // Ensure we don't hold onto a socket that is closing/closed
        ws.terminate?.()
      } catch (_) {}
      ws = undefined
    }
  }
  // Windows named pipe connection fix:
  // The 'ws' library doesn't support ws+pipe:// URLs, so we manually create
  // the socket connection using Node's net.connect() and pass it via the
  // createConnection option. This allows WebSocket to work over Windows named pipes.
  const wsOptions = isWindows
    ? {
        createConnection: () => net.connect(SOCKET_PATH),
      }
    : {}

  ws = new WebSocket(CLIENT_URL, wsOptions)

  ws.on('open', () => {
    // Connection established - no auth required
    console.error('Connected to Quill MCP server')
  })
  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      const { id, result, error } = msg || {}
      if (!id) return
      const entry = pending.get(String(id))
      if (!entry) return
      pending.delete(String(id))
      clearTimeout(entry.timer)
      if (error) entry.reject(new Error(String(error)))
      else entry.resolve(result)
    } catch (error) {
      console.error('mcp_ws_event', 'parse_error', error)
    }
  })
  ws.on('close', (code, reason) => {
    console.error('mcp_ws_event', 'close', { code, reason })
    // reject all pending
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('Failed to connect. Make sure Quill is running.'))
    }
    pending.clear()
  })
  ws.on('error', (error) => {
    console.error('mcp_socket_error', error)
  })
  return ws
}

function waitForOpen(sock, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (sock.readyState === WebSocket.OPEN) return resolve(null)

    const onOpen = () => {
      cleanup()
      resolve(null)
    }
    const onClose = () => {
      cleanup()
      reject(new Error('socket_closed'))
    }
    const onError = (e) => {
      cleanup()
      reject(e instanceof Error ? e : new Error('socket_error'))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('socket_open_timeout'))
    }, timeoutMs)

    function cleanup() {
      clearTimeout(timer)
      // ws uses Node EventEmitter, which supports off/removeListener
      sock.off?.('open', onOpen)
      sock.off?.('close', onClose)
      sock.off?.('error', onError)
    }

    sock.once('open', onOpen)
    sock.once('close', onClose)
    sock.once('error', onError)
  })
}

const CONNECTION_ERRORS = [
  'socket_closed',
  'socket_not_open',
  'socket_open_timeout',
  'socket_error',
  'Failed to connect',
]

function isConnectionError(err) {
  const msg = err instanceof Error ? err.message : String(err)
  return CONNECTION_ERRORS.some((e) => msg.includes(e))
}

function forceDisconnect() {
  if (ws) {
    try {
      ws.terminate?.()
    } catch (_) {}
    ws = undefined
  }
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(new Error('Failed to connect. Make sure Quill is running.'))
  }
  pending.clear()
}

async function callBridgeSingle(method, params) {
  const sock = ensureSocket()
  await waitForOpen(sock)
  if (sock.readyState !== WebSocket.OPEN) {
    throw new Error('socket_not_open')
  }
  const id = String(nextId++)
  const payload = JSON.stringify({ id, method, params })
  const p = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('timeout'))
    }, TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
  })
  sock.send(payload, (err) => {
    if (err) {
      const entry = pending.get(id)
      if (entry) {
        clearTimeout(entry.timer)
        pending.delete(id)
        entry.reject(err)
      }
    }
  })
  return p
}

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1500

async function callBridge(method, params) {
  let lastError
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await callBridgeSingle(method, params)
    } catch (err) {
      lastError = err
      if (isConnectionError(err) && attempt < MAX_RETRIES - 1) {
        console.error(`Connection attempt ${attempt + 1} failed, retrying in ${RETRY_DELAY_MS}ms...`)
        forceDisconnect()
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
      } else {
        throw err
      }
    }
  }
  throw lastError
}

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async (_request) => {
  try {
    const { tools } = await fetchTools()
    return { tools }
  } catch (error) {
    if (isConnectionError(error)) {
      console.error('Cannot reach Quill to list tools, returning reconnect placeholder')
      return {
        tools: [
          {
            name: 'quill_reconnect',
            description:
              'Quill is not currently reachable. Call this tool to attempt to reconnect.',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
        ],
      }
    }
    throw error
  }
})

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name
  const args = request.params.arguments || {}

  // Handle the reconnect placeholder tool
  if (name === 'quill_reconnect') {
    forceDisconnect()
    try {
      await fetchTools()
      await server.sendToolListChanged()
      return {
        content: [{ type: 'text', text: 'Successfully reconnected to Quill. Tools have been refreshed — please retry your original request.' }],
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Still unable to connect to Quill. Please ensure that:\n1. Quill is running\n2. The MCP server is enabled in Quill Settings > Integrations\nThen try again.`,
          },
        ],
        isError: true,
      }
    }
  }

  try {
    // Include client schema version in the request
    const params = {
      ...args,
      _clientSchemaVersion: cachedSchemaVersion,
    }

    // Simply forward the tool call to the backend
    const data = await callBridge(name, params)

    // Check if response is in new standardized format
    if (data && typeof data === 'object' && '_schemaVersion' in data && 'content' in data) {
      // XML content
      return { content: [{ type: 'text', text: data.content }] }
    } else {
      // Legacy format (JSON)
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'

    // Check if the error is a schema version mismatch
    try {
      const errorObj = JSON.parse(message)
      if (errorObj.code === 'schema_outdated') {
        console.error(
          `Schema version mismatch detected. Found ${cachedSchemaVersion}, expected ${errorObj.clientVersion}. Sending tool_list_changed notification.`,
        )
        // Clear cached version to force refetch on next tool list request
        cachedSchemaVersion = null
        await server.sendToolListChanged()
        // Return a helpful error to the user
        return {
          content: [
            {
              type: 'text',
              text: `Schema version mismatch. The tool schemas have been updated. Please retry your request.`,
            },
          ],
          isError: true,
        }
      }
    } catch (_) {
      // Not a JSON error or not a schema_outdated error, continue with normal error handling
    }

    console.error('Error calling tool', name, args, error)

    if (isConnectionError(error)) {
      return {
        content: [
          {
            type: 'text',
            text: `Could not connect to Quill after ${MAX_RETRIES} attempts. Please ensure that:\n1. Quill is running\n2. The MCP server is enabled in Quill Settings > Integrations\nThen retry your request.`,
          },
        ],
        isError: true,
      }
    }

    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
  }
})

// Start the server
const transport = new StdioServerTransport()
server.connect(transport)

console.error('Quill MCP server running...')
