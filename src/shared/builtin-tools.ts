/**
 * The built-in tools, grouped the way the settings and the Tools panel present
 * them. Shared so the UI cannot drift from what the main process actually
 * registers; `test/builtin-tools.test.ts` asserts the two stay in sync.
 */
export const BUILTIN_TOOL_GROUPS = {
  file: ['read_file', 'write_file', 'list_files', 'search_files'],
  shell: ['run_command']
} as const

export type BuiltinToolGroup = keyof typeof BUILTIN_TOOL_GROUPS
