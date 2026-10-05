/**
 * An expected, user-facing failure (missing node, bad input, conflict). The
 * CLI prints only its message; the MCP server returns it as a tool error.
 */
export class BraindumpError extends Error {
  constructor(message) {
    super(message);
    this.name = "BraindumpError";
  }
}
