// Build constants (not deployment data). The repository URL is set by whoever builds the console
// (VITE_CONSOLE_REPO_URL, e.g. https://github.com/<owner>/<repo>); without it the console shows repository paths as
// text instead of links, so no personal default is baked in.

const repo = (import.meta.env.VITE_CONSOLE_REPO_URL as string | undefined)?.replace(/\/$/, '') ?? ''
const branch = (import.meta.env.VITE_CONSOLE_REPO_BRANCH as string | undefined) ?? 'main'

export const HARBOR_SUMMARY_PATH = 'docs/experiments/harbor-summary.zh-CN.md'
export const CLI_PATH = 'tools/llmar/llmar'

/** Browsable URL of a repository file, or undefined when no repository URL was configured. */
export function repoFileUrl(path: string): string | undefined {
  if (!/^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+$/.test(repo)) return undefined
  return `${repo}/blob/${branch}/${path}`
}

/** Raw download URL of a repository file on GitHub, or undefined. */
export function repoRawUrl(path: string): string | undefined {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)$/.exec(repo)
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${branch}/${path}` : undefined
}
