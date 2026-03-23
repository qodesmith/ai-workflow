/** biome-ignore-all lint/suspicious/noConsole: logging is expected */

import {$} from 'bun'
import path from 'node:path'

const currentBranch = (await $`git branch --show-current`.text()).trim()
const rawWorktreeListOutput = await $`git worktree list --no-porcelain`.text()
const worktreeRawData = rawWorktreeListOutput.split('\n').filter(line => {
  return line && !line.includes(`[${currentBranch}]`)
})
const worktreePathData = worktreeRawData.reduce<
  {worktreeName: string; worktreePath: string}[]
>((acc, data) => {
  const [worktreePath] = data.split(' ')

  if (worktreePath) {
    // https://nodejs.org/docs/latest/api/path.html#pathparsepath
    const worktreeName = path.parse(worktreePath).base
    acc.push({worktreeName, worktreePath})
  }

  return acc
}, [])

for (const {worktreeName, worktreePath: _} of worktreePathData) {
  await $`git worktree remove ${worktreeName} --force`.catch(() => {
    console.error(`Unable to remove worktree - ${worktreeName}`)
  })

  await $`git branch -D ${worktreeName}`.catch(() => {
    console.error(`Unable to remove branch - ${worktreeName}`)
  })
}
