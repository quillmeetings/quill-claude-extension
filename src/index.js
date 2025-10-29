#!/usr/bin/env node

// @ts-check

import os from 'os'
import WebSocket from 'ws'
import crypto from 'crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  {
    name: 'quill-claude-extension',
    version: '0.1.1',
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
const CLIENT_URL = isWindows ? 'ws+pipe://./pipe/quill_mcp' : `ws+unix://${SOCKET_PATH}`

/** @type {WebSocket | undefined} */
let ws
let nextId = 1
/** @type {Map<string, {resolve:Function, reject:Function, timer:NodeJS.Timeout}>} */
const pending = new Map()

/** @type {{ resolve: (() => void) | null, reject: ((e: Error) => void) | null, promise: Promise<void> } | null} */
let auth = null

/** @type {number | null} */
let cachedSchemaVersion = null

function resetAuthPromise() {
  // Reject and clean up any existing, unresolved auth promise to avoid leaks
  try {
    auth?.reject?.(new Error('authentication_reset'))
  } catch (_) {}
  if (auth) {
    auth.resolve = null
    auth.reject = null
  }
  /** @type {((v?:void)=>void) | null} */
  let resolveAuth = null
  /** @type {((e:Error)=>void) | null} */
  let rejectAuth = null
  const promise = new Promise((resolve, reject) => {
    resolveAuth = resolve
    rejectAuth = reject
  })
  auth = { resolve: resolveAuth, reject: rejectAuth, promise }
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
  ws = new WebSocket(CLIENT_URL)
  resetAuthPromise()

  ws.on('open', () => {
    // ready
  })
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg && typeof msg === 'object' && typeof msg.type === 'string') {
        if (msg.type === 'nonce') {
          // Proceed with handshake authentication
          const secret = process.env.QUILL_MCP_SECRET
          if (!secret) {
            auth?.reject?.(new Error('Please set the Extension Secret in the Claude extensions settings.'))
            try {
              ws?.close()
            } catch (_) {}
            return
          }
          try {
            const hmac = crypto
              .createHmac('sha256', Buffer.from(secret, 'base64'))
              .update(String(msg.nonce || ''))
              .digest('base64')
            ws?.send(JSON.stringify({ type: 'auth', hmac }))
          } catch (e) {
            auth?.reject?.(e instanceof Error ? e : new Error('Authentication failed. Please check the Extension Secret and try again.'))
            try {
              ws?.close()
            } catch (_) {}
          }
          return
        }
        if (msg.type === 'auth_ok') {
          auth?.resolve?.()
          return
        }
      }
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
    auth?.reject?.(new Error('Failed to connect. Make sure Quill is running.'))
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
  // ensure authenticated before any RPCs
  try {
    await auth?.promise
  } catch (e) {
    throw e instanceof Error ? e : new Error('Authentication failed.')
  }
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
  // Fetch tools from backend
  try {
    const { version, tools } = await callBridge('list_tools', {})
    // Cache the schema version for version checking
    cachedSchemaVersion = version
    return {
      tools,
    }
  } catch (error) {
    console.error('Failed to fetch tools from backend', error)
    // Return empty list if we can't fetch tools
    return { tools: [] }
  }
})

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name
  const args = request.params.arguments || {}

  try {
    // Include client schema version in the request
    const params = {
      ...args,
      _clientSchemaVersion: cachedSchemaVersion,
    }

    // Simply forward the tool call to the backend
    const data = await callBridge(name, params)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'

    // Check if the error is a schema version mismatch
    try {
      const errorObj = JSON.parse(message)
      if (errorObj.code === 'schema_outdated') {
        console.error('Schema version mismatch detected, refetching tools...')
        // Clear cached version to force refetch on next tool list request
        cachedSchemaVersion = null
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
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
  }
})

// Start the server
const transport = new StdioServerTransport()
server.connect(transport)

console.error('Quill MCP server running...')
