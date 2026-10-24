#!/usr/bin/env node
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

// One-time offline migration. Runtime code only understands monthly logs.
const dir = process.argv[2]
if (!dir || process.argv.length !== 3) {
  console.error('用法：node scripts/split-log.mjs <vaultDir>（请先停止写入并备份记忆库）')
  process.exitCode = 1
} else {
  const created = []
  try {
    const root = path.resolve(dir)
    const manifest = JSON.parse(await readFile(path.join(root, 'memwiki.json'), 'utf8'))
    if (manifest.schemaVersion !== 1) throw new Error('不是支持的记忆库')
    const old = path.join(root, 'log.md')
    const raw = await readFile(old, 'utf8')
    const months = new Map()
    for (const line of raw.split(/\r?\n/).reverse()) {
      if (!line.trim() || /^#{1,2} /.test(line)) continue
      const date = /^- (\d{4}-(?:0[1-9]|1[0-2]))-\d{2} /.exec(line)
      if (!date) throw new Error('旧日志存在无法归月的内容，保留原文件，请人工检查')
      if (!months.has(date[1])) months.set(date[1], [])
      months.get(date[1]).push(line)
    }
    await mkdir(path.join(root, 'log'), { recursive: true })
    for (const [month, lines] of [...months].sort(([a], [b]) => a.localeCompare(b))) {
      const file = path.join(root, 'log', month + '.md')
      // Never overwrite an existing monthly log or discard unstructured legacy rows.
      await writeFile(file, lines.join('\n') + '\n', { flag: 'wx' })
      created.push(file)
    }
    await unlink(old)
    console.log(`已拆分到 log/：${months.size} 个月，旧 log.md 已删除。`)
  } catch (error) {
    for (const file of created) await unlink(file).catch(() => {})
    console.error(`拆分失败：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
