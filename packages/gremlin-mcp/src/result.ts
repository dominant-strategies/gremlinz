/** MCP tool results. Errors are returned as tool errors (isError), so the gremlin sees them and can adapt. */
export const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
export const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true })
