// Minimal MCP client for the bench/eval harnesses.
//
// Deliberately NOT bench/lab's HttpMemberryTransport: that is a cross-directory import
// bench:lab:typecheck does not cover, and its call() flattens all content blocks to a joined
// string and throws on isError -- discarding the exact branch these harnesses exist to separate.
//
// Verified live 2026-08-27 against http://192.168.0.25:3101.

/**
 * Non-retrieval failures that arrive as a SUCCESSFUL HTTP 200 with isError:true and a bare
 * message. There is no JSON-RPC error member and nothing throws. A caller that inspects
 * response.error sees nothing, feeds the literal string into scoring, and reports a catastrophic
 * regression that is really a config error.
 */
export const NON_RETRIEVAL_ERRORS = [
  'runtime_query_planner:invalid_request',
  'runtime_query_planner:resolution_failed',
  'reranker_shadow:prerequisite_unavailable',
  'reranker_served:prerequisite_unavailable',
]

export function createClient(base, token) {
  let sessionId = null

  async function rpc(method, params) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    }
    if (sessionId) headers['mcp-session-id'] = sessionId
    const res = await fetch(new URL('/mcp', base), {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) sessionId = sid
    const text = await res.text()
    if (!text.trim()) return { _status: res.status, _empty: true }
    // Responses are SSE-framed; the payload is the line beginning "data: ".
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '))
    try {
      return JSON.parse(dataLine ? dataLine.slice(6) : text)
    } catch {
      return { _status: res.status, _unparseable: text.slice(0, 400) }
    }
  }

  async function callTool(name, args) {
    const res = await rpc('tools/call', { name, arguments: args })
    const result = res?.result
    const texts = (result?.content ?? []).map((c) => c?.text ?? '')
    const text = texts.join('\n')
    return { isError: result?.isError === true, text, texts, raw: res }
  }

  return {
    async connect() {
      await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'memberry-bench-eval', version: '1' },
      })
      await rpc('notifications/initialized', {})
      if (!sessionId) throw new Error('EVAL fatal: no mcp-session-id returned by initialize')

      // Progressive disclosure: the code tools are DISABLED by default. Without this, every
      // code-plane call returns `MCP error -32602: Tool berry_code_search disabled` as isError,
      // and the plane carrying the primary defect becomes silently unmeasurable.
      //
      // Two traps, both verified live:
      //   - the parameter is `domain`, NOT `tier`
      //   - the wrong parameter returns isError:FALSE with the failure buried in a JSON body
      //     ({"error":"domain parameter required for enable action"}), so the isError branch
      //     alone does not catch it. Parse the body.
      const enable = await callTool('berry_tools', { action: 'enable', domain: 'code' })
      let codeDomainEnabled = false
      try {
        codeDomainEnabled = JSON.parse(enable.text)?.ok === true
      } catch {
        codeDomainEnabled = false
      }
      const listed = await rpc('tools/list', {})
      const codeTools = (listed?.result?.tools ?? [])
        .map((t) => t.name)
        .filter((n) => n.includes('code'))
      return { codeDomainEnabled, codeToolsVisible: codeTools.length }
    },
    callTool,
    async close() {
      if (!sessionId) return
      const closingSession = sessionId
      sessionId = null
      try {
        await fetch(new URL('/mcp', base), {
          method: 'DELETE',
          headers: {
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${token}`,
            'mcp-session-id': closingSession,
          },
          signal: AbortSignal.timeout(5_000),
        })
      } catch {
        // Session teardown is best-effort after the measurement is already complete. Clearing the
        // local id above and the bounded signal ensure a failed DELETE cannot pin the probe open.
      }
    },
  }
}
