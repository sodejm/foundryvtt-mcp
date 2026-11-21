// Extraction-only registry; no dispatch is executed by these fixtures.
export const toolRegistry = {
  execute(_name: string, _args: unknown, _context: unknown): undefined { return undefined; }
};
