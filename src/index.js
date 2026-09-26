#!/usr/bin/env node

// @ts-check

import os from 'os'
import net from 'net'
import WebSocket from 'ws'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const MCP_SERVER_INSTRUCTIONS = `Quill is a local meeting recording and note-taking app. Meeting data is stored on the user's own machine. This server exposes the current user's local Quill data — recorded meetings, transcripts, AI-generated minutes, contacts, and meeting threads. It does not reach other users' data.

Listing recent meetings: search_meetings also lists — for "recent meetings" or "meetings this week" with no topic in mind, call it with query omitted and drive everything through filter/ranking instead. There is no separate list-meetings tool.

Picking the right meeting-content tool:
- search_meetings — find which meetings match, by title/blurb/participants/tags (and optionally minutes/transcripts via ranking.scope).
- search_minutes — full-text search inside AI-generated minutes across meetings; returns chunks with meeting_id + chunk_position — follow up with get_minutes for full context.
- get_minutes — the live AI summary for one known meeting. Fast, but may be lossy.
- get_transcript — verbatim transcript with speakers/timestamps. Use for exact quotes or when minutes aren't detailed enough; slice with start_seconds/duration_seconds on long meetings instead of pulling the whole thing.

Contacts: search_contacts matches name/email/bio/notes and requires a query. list_contacts browses/paginates and only loosely filters by name/email. Use search_contacts when the ask references something about a person, not just their name.

Events vs. meetings: list_events is upcoming/future calendar events only. For anything already recorded, use search_meetings.

Threads: recurring series (e.g. weekly 1:1s) are grouped as threads — use list_threads with include_meetings to see a series' history rather than reconstructing it via repeated searches.

IDs are opaque — get a meeting_id/contact_id from a search or list result before calling a single-item tool (get_meeting, get_transcript, get_contact); don't guess one.`

const server = new Server(
  {
    name: 'quill-claude-extension',
    version: '0.1.4',
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: MCP_SERVER_INSTRUCTIONS,
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
async function fetchTools() {
  try {
    return await callBridge('list_tools', {})
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

async function callBridge(method, params) {
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

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async (_request) => {
  // Fetch tools from backend - let errors propagate to client
  const { tools } = await fetchTools()
  return { tools }
})

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name
  const args = request.params.arguments || {}

  try {
    // Simply forward the tool call to the backend
    const data = await callBridge(name, args)

    // Check if response is in standardized format
    if (data && typeof data === 'object' && 'content' in data) {
      // XML content
      return { content: [{ type: 'text', text: data.content }] }
    } else {
      // Legacy format (JSON)
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'

    console.error('Error calling tool', name, args, error)
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
  }
})

// Start the server
const transport = new StdioServerTransport()
server.connect(transport)

console.error('Quill MCP server running...')
