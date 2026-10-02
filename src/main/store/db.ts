import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DB } from '@shared/types'
import { normalizeThreshold } from '@shared/utils'

/**
 * 数据文件的读写。
 *
 * 设计要点：
 * 1. **原子写入**：写同目录临时文件 → fsync → rename 覆盖。rename 在 POSIX 上是原子操作，
 *    因此不会出现「文件写了一半」的损坏状态；旧文件先留一份 .bak。
 * 2. **串行写队列**：所有写操作经同一个 Promise 队列排队，杜绝并发写互相覆盖。
 * 3. **成功才提交内存**：写入失败时内存快照保持不变，不需要回滚逻辑。
 *
 * 本模块刻意不 import electron，便于在纯 Node 环境下直接测试。
 */

const EMPTY_DB: DB = { version: 1, items: [], records: [] }

let dataFile = ''
let cache: DB | null = null

/** 串行队列的队尾 */
let queue: Promise<unknown> = Promise.resolve()

export interface LoadReport {
  /** 主文件损坏，本次启动已从 .bak 恢复（界面需要提示用户） */
  recoveredFromBackup: boolean
}

let loadReport: LoadReport = { recoveredFromBackup: false }

/**
 * 上一次加载的结果。
 *
 * 刻意用「查询状态」而不是「抛异常」来传达恢复成功：
 * 恢复成功是**正常路径**，抛异常会让调用方误以为启动失败，
 * 而启动流程里一个没人接的异常就会让整个应用起不来。
 */
export function getLoadReport(): LoadReport {
  return { ...loadReport }
}

/** 初始化存储位置。主进程启动时调用一次；测试时可指向任意临时目录。 */
export function initStore(dataDir: string): void {
  dataFile = join(dataDir, 'data.json')
  cache = null
  loadReport = { recoveredFromBackup: false }
}

export function getDataFilePath(): string {
  if (!dataFile) throw new Error('存储尚未初始化，请先调用 initStore()')
  return dataFile
}

/** 数据文件所在目录（用于界面上的「打开数据文件夹」） */
export function getDataDir(): string {
  return dirname(getDataFilePath())
}

/** 同步读取当前内存快照。渲染进程取数据走这里，不碰磁盘。 */
export function getSnapshot(): DB {
  return cache ?? EMPTY_DB
}

function parseDB(raw: string): DB {
  const parsed = JSON.parse(raw) as Partial<DB>
  // 旧数据文件里的记录可能没有 operator / handler（这两个字段是后加的）。
  // 在这里一次性补齐，读取方就不必到处写 `r.handler ?? ''` ——
  // 补齐点只有一处，界面、导出、断言看到的就都是同一个形状。
  const records = Array.isArray(parsed.records)
    ? parsed.records.map((r) => ({
        ...r,
        operator: (r as { operator?: string }).operator ?? '',
        handler: (r as { handler?: string }).handler ?? ''
      }))
    : []
  // 旧数据文件里没有 threshold 字段（这个功能是后加的）。
  // 在这里补齐，而不是让每个读取方自己判断 undefined ——
  // 补齐点只有一处，界面和数据层就不可能对同一个物品算出不同的警戒状态。
  // note 是 v1.6.0 才加的，旧文件没有，同样在这里补成空串。
  const items = Array.isArray(parsed.items)
    ? parsed.items.map((i) => {
        const rawNote = (i as { note?: unknown }).note
        return {
          ...i,
          threshold: normalizeThreshold((i as { threshold?: unknown }).threshold),
          note: typeof rawNote === 'string' ? rawNote : ''
        }
      })
    : []
  return {
    version: 1,
    items,
    records
  }
}

/**
 * 从磁盘加载。首次调用会读文件，之后走内存缓存。
 *
 * 主文件读不了或解析不了时，自动回退到 `.bak`。
 * 只有**主文件与备份都不可用**才抛错 —— 那种情况下没有任何数据可以继续，
 * 调用方应当把错误原样展示给用户并停止启动，绝不能默默当成空库。
 */
export async function load(): Promise<DB> {
  if (cache) return cache

  const target = getDataFilePath()
  const bak = `${target}.bak`

  let raw: string | undefined
  let primaryBroken = false

  try {
    raw = await fs.readFile(target, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // 首次运行，还没有数据文件
      cache = { ...EMPTY_DB }
      return cache
    }
    // 文件存在但读不了 —— 走备份恢复
    primaryBroken = true
  }

  if (!primaryBroken && raw !== undefined) {
    try {
      cache = parseDB(raw)
      return cache
    } catch {
      // 解析失败（内容被改坏 / 被截断）—— 走备份恢复
      primaryBroken = true
    }
  }

  // 到这里说明主文件确实不可用，尝试从 .bak 恢复
  try {
    const bakData = parseDB(await fs.readFile(bak, 'utf8'))

    // skipBackup 必须是 true：
    // 否则 commit 会先把**损坏的**主文件拷成 .bak，把唯一的好备份覆盖掉，
    // 下一次再出问题就没得救了。
    await commit(bakData, true)

    cache = bakData
    loadReport = { recoveredFromBackup: true }
    return cache
  } catch {
    throw new Error(
      `数据文件损坏，且无法从备份恢复。\n主文件：${target}\n备份：${bak}`
    )
  }
}

/** 原子写入并把内存快照切到新值。失败时内存保持原样。 */
export async function commit(next: DB, skipBackup = false): Promise<void> {
  const target = getDataFilePath()
  const tmp = `${target}.tmp`
  const bak = `${target}.bak`
  const json = JSON.stringify(next, null, 2)

  const handle = await fs.open(tmp, 'w')
  try {
    await handle.writeFile(json, 'utf8')
    await handle.sync() // fsync：确保数据真正落盘，而不是停在系统缓冲区
  } finally {
    await handle.close()
  }

  // 保留上一份作为备份（首次运行时没有旧文件；恢复时跳过，以免坏文件覆盖好备份）
  if (!skipBackup) {
    try {
      await fs.copyFile(target, bak)
    } catch {
      /* 忽略：首次运行 */
    }
  }

  await fs.rename(tmp, target) // 原子替换

  cache = next
}

/**
 * 把写操作排入串行队列。
 * 前一个任务失败不会阻塞后续任务（队列只关心顺序，不关心成败）。
 */
export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(
    () => fn(),
    () => fn()
  )
  queue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** 深拷贝一份快照，供「先构造新值、成功后再提交」的写法使用 */
export function cloneDB(db: DB): DB {
  return {
    version: 1,
    items: db.items.map((i) => ({ ...i })),
    records: db.records.map((r) => ({ ...r }))
  }
}
