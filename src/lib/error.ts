export type ErrorKind = 'connection' | 'invalid_tool' | 'invalid_args' | 'tool_execution' | 'timeout' | 'protocol' | 'unknown'

export type AppError = {
  kind: ErrorKind
  message: string
  code?: string
  remediation?: string
  metadata?: Record<string, unknown>
  cause?: unknown
}

type StructuredErrorLike = {
  kind?: unknown
  code?: unknown
  message?: unknown
  remediation?: unknown
  metadata?: unknown
  cause?: unknown
}

const VALID_KINDS: Set<ErrorKind> = new Set(['connection', 'invalid_tool', 'invalid_args', 'tool_execution', 'timeout', 'protocol', 'unknown'])

function asError(input: unknown): Error {
  if (input instanceof Error) {
    return input
  }

  return new Error(String(input))
}

function fromStructured(input: StructuredErrorLike): AppError | null {
  const maybeKind = typeof input.kind === 'string' ? input.kind : undefined
  if (!maybeKind || !VALID_KINDS.has(maybeKind as ErrorKind)) {
    return null
  }

  return {
    kind: maybeKind as ErrorKind,
    message: typeof input.message === 'string' ? input.message : 'Unexpected error',
    code: typeof input.code === 'string' ? input.code : undefined,
    remediation: typeof input.remediation === 'string' ? input.remediation : undefined,
    metadata: typeof input.metadata === 'object' && input.metadata !== null ? (input.metadata as Record<string, unknown>) : undefined,
    cause: input.cause,
  }
}

export function classifyError(input: unknown): AppError {
  if (input && typeof input === 'object') {
    const structured = fromStructured(input as StructuredErrorLike)
    if (structured) {
      return structured
    }
  }

  const resolved = asError(input)
  const message = resolved.message.toLowerCase()
  const errnoCode = (resolved as NodeJS.ErrnoException).code
  const code = typeof errnoCode === 'string' ? errnoCode : undefined
  const normalizedCode = code?.toLowerCase()

  if (
    normalizedCode === 'enoent' ||
    normalizedCode === 'econnrefused' ||
    message.includes('socket_closed') ||
    message.includes('socket_not_open') ||
    message.includes('quill is not running')
  ) {
    return {
      kind: 'connection',
      code,
      message: 'Unable to reach Quill.',
      remediation: 'Make sure Quill is running and try again.',
      metadata: { rawMessage: resolved.message },
      cause: input,
    }
  }

  if (message.includes('timeout') || message.includes('socket_open_timeout')) {
    return {
      kind: 'timeout',
      code,
      message: 'Request to Quill timed out.',
      remediation: 'Try again. If the problem continues, restart Quill.',
      metadata: { rawMessage: resolved.message },
      cause: input,
    }
  }

  if (message.includes('unknown tool') || message.includes('tool not found')) {
    return {
      kind: 'invalid_tool',
      code,
      message: 'Requested tool is not available.',
      remediation: 'Refresh tools and retry.',
      metadata: { rawMessage: resolved.message },
      cause: input,
    }
  }

  if (message.includes('invalid arg') || message.includes('validation')) {
    return {
      kind: 'invalid_args',
      code,
      message: 'Tool arguments are invalid.',
      remediation: 'Review tool parameters and retry.',
      metadata: { rawMessage: resolved.message },
      cause: input,
    }
  }

  if (message.includes('invalid_list_tools_response') || message.includes('parse_error') || message.includes('json')) {
    return {
      kind: 'protocol',
      code,
      message: 'Received invalid response from Quill.',
      remediation: 'Retry. If it persists, restart Quill and Claude.',
      metadata: { rawMessage: resolved.message },
      cause: input,
    }
  }

  if (message.includes('tool execution') || message.includes('backend')) {
    return {
      kind: 'tool_execution',
      code,
      message: 'Quill failed while running the tool.',
      remediation: 'Retry the request. If it persists, inspect Quill logs.',
      metadata: { rawMessage: resolved.message },
      cause: input,
    }
  }

  return {
    kind: 'unknown',
    code,
    message: 'Unexpected error while communicating with Quill.',
    remediation: 'Retry the request. If it persists, restart Quill.',
    metadata: { rawMessage: resolved.message },
    cause: input,
  }
}

export function formatUserMessage(error: AppError): string {
  switch (error.kind) {
    case 'connection':
      return error.remediation ?? 'Unable to connect to Quill. Make sure Quill is running and try again.'
    case 'timeout':
      return error.remediation ?? 'Quill took too long to respond. Try again.'
    case 'invalid_tool':
      return error.remediation ?? 'This tool is not available right now.'
    case 'invalid_args':
      return error.remediation ?? 'The tool arguments are invalid. Check inputs and retry.'
    case 'protocol':
      return error.remediation ?? 'Received an invalid response from Quill. Try again.'
    case 'tool_execution':
      return error.remediation ?? 'Quill failed while executing the tool.'
    default:
      return error.remediation ?? 'Unexpected error. Try again.'
  }
}
