import { ConnectionManager } from './connectionManager'

export interface ListToolsResponse {
  tools: unknown[]
}

/**
 * Transport-only bridge adapter on top of ConnectionManager.
 * Keeps method names and RPC contracts in one place while leaving UX decisions to handlers.
 */
export class ProtocolClient {
  /** Shared connection runtime for all bridge RPC requests. */
  private readonly connection: ConnectionManager

  constructor(connection: ConnectionManager) {
    this.connection = connection
  }

  /**
   * Requests the dynamic tool registry from Quill.
   * Returns a normalized `{ tools }` object for MCP list-tools handlers.
   */
  public async listTools(): Promise<ListToolsResponse> {
    const method = 'list_tools'
    const start = Date.now()
    try {
      const result = await this.connection.request(method, {})
      if (!result || typeof result !== 'object' || !('tools' in result)) {
        throw new Error('invalid_list_tools_response')
      }

      const tools = (result as { tools: unknown }).tools
      if (!Array.isArray(tools)) {
        throw new Error('invalid_list_tools_response')
      }

      this.log('success', method, Date.now() - start)
      return { tools }
    } catch (error) {
      this.log('error', method, Date.now() - start, String(error))
      throw error
    }
  }

  /**
   * Forwards a single tool call to Quill and returns raw payload.
   * Formatting/interpretation of the payload belongs to higher-level handlers.
   */
  public async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const start = Date.now()
    try {
      const result = await this.connection.request(name, args)
      this.log('success', name, Date.now() - start)
      return result
    } catch (error) {
      this.log('error', name, Date.now() - start, String(error))
      throw error
    }
  }

  private log(outcome: 'success' | 'error', method: string, durationMs: number, error?: string): void {
    console.error(
      '[mcp-protocol]',
      JSON.stringify({
        method,
        outcome,
        durationMs,
        error,
      }),
    )
  }
}
