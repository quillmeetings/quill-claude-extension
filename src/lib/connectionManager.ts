import net from 'net'
import util from 'node:util'
import WebSocket, { type RawData } from 'ws'

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'errored'

export interface ConnectionManagerOptions {
  socketPath: string
  isWindows: boolean
  openTimeoutMs: number
  requestTimeoutMs: number
  maxRetries: number
  retryBaseDelayMs?: number
}

type PendingEntry = {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: NodeJS.Timeout
}

type JsonRpcMessage = {
  id?: string | number
  result?: unknown
  error?: unknown
}

const DEFAULT_RETRY_BASE_DELAY_MS = 200
const MAX_RETRY_DELAY_MS = 2000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Stateful runtime manager for the extension <-> Quill bridge socket.
 * Owns connection lifecycle, in-flight request tracking, and connection-class retries.
 */
export class ConnectionManager {
  /** Immutable construction settings for socket paths, timeouts, and retry policy. */
  private readonly options: ConnectionManagerOptions

  /** Last known lifecycle state used by callers and structured logs. */
  private state: ConnectionState = 'idle'

  /** Active websocket instance for the current session, if connected/connecting. */
  private ws: WebSocket | undefined

  /** Shared promise used to dedupe concurrent connect attempts. */
  private connectPromise: Promise<WebSocket> | undefined

  /** Monotonic JSON-RPC id counter for outbound bridge requests. */
  private nextId = 1

  /** In-flight requests awaiting response keyed by JSON-RPC id. */
  private readonly pending = new Map<string, PendingEntry>()

  constructor(options: ConnectionManagerOptions) {
    this.options = options
  }

  /**
   * Sends a JSON-RPC request over the managed socket connection.
   * Use this for all bridge calls so connection retries/timeouts are applied consistently.
   * Primary call entrypoint for bridge RPC.
   * Retries only connection-class failures; semantic/tool failures are surfaced as-is.
   */
  public async request(method: string, params: unknown): Promise<unknown> {
    let attempt = 0
    const maxAttempts = Math.max(0, this.options.maxRetries) + 1

    while (attempt < maxAttempts) {
      const socket = await this.getOrConnect()
      const id = String(this.nextId++)
      const payload = JSON.stringify({ id, method, params })
      const responsePromise = this.waitForResponse(id)

      socket.send(payload, (error?: Error) => {
        if (!error) return
        const entry = this.pending.get(id)
        if (!entry) return
        clearTimeout(entry.timer)
        this.pending.delete(id)
        entry.reject(error)
      })

      try {
        return await responsePromise
      } catch (error) {
        const isRetryable = this.isConnectionClassError(error)
        const isLastAttempt = attempt >= maxAttempts - 1
        this.log('request_error', {
          method,
          attempt,
          isRetryable,
          isLastAttempt,
          kind: this.classifyConnectionError(error),
          error: String(error),
        })

        if (!isRetryable || isLastAttempt) {
          throw error
        }

        this.forceDisconnect('request_retry')
        const delayMs = this.computeRetryDelay(attempt)
        await sleep(delayMs)
        attempt += 1
      }
    }

    throw new Error('socket_not_open')
  }

  /**
   * Hard-resets socket state and rejects all pending operations.
   * Prefer this over touching socket internals from outside the manager.
   * Immediately tears down the active connection and rejects in-flight requests.
   * Use before forcing a reconnect, or when the host is shutting down.
   */
  public forceDisconnect(reason = 'connection_reset'): void {
    this.log('force_disconnect', { reason })
    if (this.ws) {
      try {
        this.ws.terminate()
      } catch {
        // no-op
      }
      this.ws = undefined
    }

    this.connectPromise = undefined
    this.setState('closed', { reason })
    this.rejectAllPending(new Error(reason))
  }

  private log(event: string, metadata: Record<string, unknown> = {}) {
    console.error(
      '[mcp-connection]',
      JSON.stringify({
        event,
        state: this.state,
        socket: this.options.socketPath,
        ...metadata,
      }),
    )
  }

  private setState(nextState: ConnectionState, metadata: Record<string, unknown> = {}) {
    if (this.state !== nextState) {
      this.state = nextState
    }
    this.log('state', { nextState, ...metadata })
  }

  private isActiveSocket(sock: WebSocket): boolean {
    return this.ws === sock
  }

  /** Fails all outstanding RPC promises during disconnect/close paths. */
  private rejectAllPending(reason: unknown): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(reason)
    }
    this.pending.clear()
  }

  /** Normalizes unknown throwables into Error instances for classification. */
  private resolveConnectionError(error: unknown): Error {
    if (error instanceof Error) {
      return error
    }
    return new Error(String(error))
  }

  /** Buckets low-level transport failures into stable connection error kinds. */
  private classifyConnectionError(error: unknown): string {
    const resolved = this.resolveConnectionError(error)
    const message = resolved.message.toLowerCase()
    const code = typeof (resolved as NodeJS.ErrnoException).code === 'string' ? (resolved as NodeJS.ErrnoException).code!.toLowerCase() : ''

    let kind = 'transport_error'
    if (code === 'enoent' || message.includes('enoent')) kind = 'socket_missing'
    else if (code === 'econnrefused' || message.includes('econnrefused')) kind = 'connection_refused'
    else if (message.includes('socket_open_timeout')) kind = 'socket_open_timeout'
    else if (message.includes('socket_closed')) kind = 'socket_closed'
    else if (message.includes('socket_not_open')) kind = 'socket_not_open'

    const errnoError = resolved as NodeJS.ErrnoException & { address?: string; port?: number }
    this.log('connection_error_classified', {
      kind,
      name: resolved.name,
      message: resolved.message,
      stack: resolved.stack,
      code: errnoError.code,
      errno: errnoError.errno,
      syscall: errnoError.syscall,
      address: errnoError.address,
      port: errnoError.port,
      cause: resolved.cause ? util.inspect(resolved.cause, { depth: 8, breakLength: 140, maxArrayLength: 200 }) : undefined,
      original: util.inspect(error, {
        depth: 8,
        breakLength: 140,
        maxArrayLength: 200,
      }),
    })

    return kind
  }

  /** Identifies retry-eligible errors that indicate transport availability issues. */
  private isConnectionClassError(error: unknown): boolean {
    const kind = this.classifyConnectionError(error)
    return (
      kind === 'socket_missing' ||
      kind === 'connection_refused' ||
      kind === 'socket_open_timeout' ||
      kind === 'socket_closed' ||
      kind === 'socket_not_open' ||
      kind === 'transport_error'
    )
  }

  /** Computes bounded exponential backoff delay for reconnect/request retry attempts. */
  private computeRetryDelay(attempt: number): number {
    const baseDelay = this.options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS
    return Math.min(baseDelay * 2 ** attempt, MAX_RETRY_DELAY_MS)
  }

  /** Registers socket listeners that drive state transitions and response delivery. */
  private attachSocketListeners(sock: WebSocket): void {
    sock.on('open', () => {
      if (!this.isActiveSocket(sock)) return
      this.setState('open', { event: 'open' })
    })

    sock.on('message', (raw: RawData) => {
      if (!this.isActiveSocket(sock)) return

      try {
        const msg = JSON.parse(raw.toString()) as JsonRpcMessage
        const { id, result, error } = msg
        if (id === undefined || id === null) return

        const idString = String(id)
        const entry = this.pending.get(idString)
        if (!entry) return

        this.pending.delete(idString)
        clearTimeout(entry.timer)
        if (error) {
          entry.reject(new Error(String(error)))
          return
        }
        entry.resolve(result)
      } catch (error) {
        this.log('parse_error', { error: String(error) })
      }
    })

    sock.on('close', (code: number, reason: Buffer) => {
      if (!this.isActiveSocket(sock)) return

      const closedReason = reason.toString() || 'socket_closed'
      this.log('close', { code, reason: closedReason })
      this.setState('closed', { code, reason: closedReason })
      this.ws = undefined
      this.connectPromise = undefined
      this.rejectAllPending(new Error('socket_closed'))
    })

    sock.on('error', (error: Error) => {
      if (!this.isActiveSocket(sock)) return

      this.log('error', { error: String(error) })
      this.setState('errored', { error: String(error) })
    })
  }

  /** Creates (or reuses) the active websocket and applies platform-specific transport wiring. */
  private createSocket(): WebSocket {
    if (this.ws && (this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED)) {
      try {
        this.ws.terminate()
      } catch {
        // no-op
      }
      this.ws = undefined
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return this.ws
    }

    const clientUrl = this.options.isWindows ? 'ws://localhost' : `ws+unix://${this.options.socketPath}`
    const wsOptions = this.options.isWindows
      ? {
          createConnection: () => net.connect(this.options.socketPath),
        }
      : {}

    const socket = new WebSocket(clientUrl, wsOptions)
    this.ws = socket
    this.attachSocketListeners(socket)
    return socket
  }

  /** Resolves once the socket is open, or rejects with deterministic open-time failures. */
  private waitForOpen(sock: WebSocket): Promise<void> {
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
      }, this.options.openTimeoutMs)

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

  /** Ensures there is at most one active connect attempt at a time. */
  private async establishConnection(): Promise<WebSocket> {
    if (this.connectPromise) {
      return this.connectPromise
    }

    this.connectPromise = (async () => {
      this.setState('connecting', { event: 'connect_start' })
      const socket = this.createSocket()
      await this.waitForOpen(socket)
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error('socket_not_open')
      }
      this.setState('open', { event: 'connect_ready' })
      return socket
    })()

    try {
      const socket = await this.connectPromise
      return socket
    } catch (error) {
      this.setState('errored', { event: 'connect_failed', error: String(error) })
      throw error
    } finally {
      this.connectPromise = undefined
    }
  }

  /** Returns an open socket, applying bounded retries for connection-class failures. */
  private async getOrConnect(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.ws
    }

    let attempt = 0
    const maxAttempts = Math.max(0, this.options.maxRetries) + 1

    while (attempt < maxAttempts) {
      try {
        return await this.establishConnection()
      } catch (error) {
        const isRetryable = this.isConnectionClassError(error)
        const isLastAttempt = attempt >= maxAttempts - 1
        this.log('retry_evaluation', {
          attempt,
          maxAttempts,
          isRetryable,
          isLastAttempt,
          kind: this.classifyConnectionError(error),
          error: String(error),
        })

        if (!isRetryable || isLastAttempt) {
          throw error
        }

        const delayMs = this.computeRetryDelay(attempt)
        this.log('retry_scheduled', { attempt, delayMs })
        await sleep(delayMs)
        attempt += 1
      }
    }

    throw new Error('socket_not_open')
  }

  /** Tracks one pending JSON-RPC request and enforces per-request timeout semantics. */
  private waitForResponse(id: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('timeout'))
      }, this.options.requestTimeoutMs)

      this.pending.set(id, { resolve, reject, timer })
    })
  }
}
