/**
 * dsh-skill-manager —— Host 半。
 *
 * 提供一组 /skill-manager/* 路由，供 设置 -> Skill 管理 面板使用：
 *
 *   GET  /skill-manager/state            扫描根、工作区、配置、默认项目
 *   GET  /skill-manager/skills           列出全局 + 项目内的全部 skill
 *   GET  /skill-manager/file             读取单个 skill 的原始全文
 *   POST /skill-manager/file             保存 skill 全文（无损，原样写回）
 *   POST /skill-manager/create           在指定根下新建 <name>/SKILL.md
 *   POST /skill-manager/toggle           文本级改写 frontmatter 的两个调用开关
 *   POST /skill-manager/delete           删除 skill（先整份备份到 ~/.dsh/skill-manager-backups）
 *   GET  /skill-manager/config           读取自定义 skill 根
 *   POST /skill-manager/config           写入自定义 skill 根
 *   GET  /skill-manager/backups          列出删除备份
 *
 * 扫描根与 @deepseek-ai/dsh-skill-filesystem 的发现优先级保持一致：
 *   rank 100 <项目>/.dsh/skills       project-dsh
 *   rank 200 <项目>/.agents/skills    project-agents
 *   rank 300 Config.customSkillDirs   custom
 *   rank 400 ~/.dsh/skills            user-dsh
 *   rank 500 ~/.agents/skills         user-agents
 * 「项目根」取最近的 .git 祖先；没有则用传入的目录本身。
 *
 * 安全约束：所有读写路径必须落在某个已解析的扫描根内，且只接受 .md 文件；
 * 写操作要求同源 Origin，防止跨站写入。
 */
import { readFile, writeFile, mkdir, readdir, rm, cp, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, basename, resolve, sep, isAbsolute } from 'node:path'

export const name = 'skill-manager'

export const inject = ['webServer', 'workspaceRegistry']

/** 请求体上限 */
const MAX_BODY_BYTES = 512 * 1024
/** 单个 skill 文件上限 */
const MAX_SKILL_BYTES = 1024 * 1024
/** 扫描目录最大条目数，防止误扫超大树 */
const MAX_ENTRIES = 500

/** 可被 model / user 调用的两个 frontmatter 键 */
const KEY_DISABLE_MODEL = 'disable-model-invocation'
const KEY_USER_INVOCABLE = 'user-invocable'

// ───────────────────────────────────────────────────────────── 基础工具

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

function agentsHome() {
  const fromEnv = process.env.DSH_AGENTS_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv)
  return join(homedir(), '.agents')
}

function configFile() {
  return join(dshHome(), 'skill-manager-config.json')
}

function backupRoot() {
  return join(dshHome(), 'skill-manager-backups')
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/** POST 必须同源：Origin 的 host 要与 Host 头一致。 */
function sameOrigin(request) {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readJsonBody(request, capBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > capBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  return JSON.parse(raw)
}

function errorText(error) {
  return String((error && error.message) || error)
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ───────────────────────────────────────────────────────────── 配置读写

/**
 * 读取扩展配置。文件损坏或缺失时回退默认值，绝不抛错打断面板。
 */
async function readConfig() {
  try {
    const raw = await readFile(configFile(), 'utf8')
    const parsed = JSON.parse(raw)
    const dirs = Array.isArray(parsed.customSkillDirs) ? parsed.customSkillDirs : []
    return {
      customSkillDirs: dirs.filter((item) => typeof item === 'string' && item.trim() !== ''),
    }
  } catch {
    return { customSkillDirs: [] }
  }
}

async function writeConfig(next) {
  const payload = {
    version: 1,
    customSkillDirs: next.customSkillDirs,
    updatedAt: new Date().toISOString(),
  }
  await mkdir(dirname(configFile()), { recursive: true })
  await writeFile(configFile(), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return payload
}

// ───────────────────────────────────────────────────────────── frontmatter

/**
 * 把文本切成 4 段，便于「只改 frontmatter、其余原样保留」：
 *   pre      开头的 `---\n`（含可能的 BOM）
 *   block    frontmatter 正文
 *   closing  结尾的 `\n---` 与换行
 *   rest     分隔行之后的所有内容
 * 没有 frontmatter 时 block 为 null。
 */
function splitFrontmatter(text) {
  const match = /^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))([\s\S]*)$/.exec(text)
  if (!match) return { pre: '', block: null, closing: '', rest: text }
  return { pre: match[1], block: match[2], closing: match[3], rest: match[4] }
}

/** 去掉包裹的成对引号，并解开常见的转义。 */
function unquote(value) {
  const text = value.trim()
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if (first !== last || (first !== '"' && first !== "'")) return text
  const inner = text.slice(1, -1)
  if (first === '"') {
    return inner.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\')
  }
  return inner.replace(/''/g, "'")
}

/**
 * 极简 YAML 子集解析：只取顶层标量与块标量（| 与 >）。
 * 嵌套对象、数组、JSON 内联值一律跳过——skill frontmatter 只需要
 * name / description / whenToUse / 两个调用开关，其余键本面板不消费。
 */
function parseFrontmatterBlock(block) {
  const result = {}
  if (typeof block !== 'string') return result
  const lines = block.split(/\r?\n/)
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    // 只认同缩进为 0 的键，避免把嵌套对象里的同名字段当成顶层
    const match = /^([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/.exec(line)
    if (!match) {
      index += 1
      continue
    }
    const key = match[1]
    const rawValue = match[2]
    // 块标量：| 字面量，> 折叠
    if (/^[|>][+-]?[ \t]*$/.test(rawValue)) {
      const folded = rawValue.trim().startsWith('>')
      const collected = []
      index += 1
      while (index < lines.length) {
        const next = lines[index]
        if (next.trim() === '') {
          collected.push('')
          index += 1
          continue
        }
        if (!/^[ \t]/.test(next)) break
        collected.push(next.replace(/^[ \t]+/, ''))
        index += 1
      }
      while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop()
      result[key] = folded ? collected.join(' ').trim() : collected.join('\n').trim()
      continue
    }
    result[key] = unquote(rawValue)
    index += 1
  }
  return result
}

/**
 * 布尔解析，与 dsh-skill-filesystem 的宽松语法保持一致：
 * true/false、yes/no、on/off、1/0（大小写不敏感）。
 * 返回 undefined 表示「键不存在」；返回 null 表示「值非法」。
 */
function parseInvocationBool(raw) {
  if (raw === undefined) return undefined
  const value = String(raw).trim().toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(value)) return true
  if (['false', 'no', 'off', '0'].includes(value)) return false
  return null
}

/**
 * 文本级改写 frontmatter：保留未触及的行、缩进、换行风格。
 * updates 的值：字符串表示写入，undefined 表示删除该键。
 */
function patchFrontmatter(text, updates) {
  const { pre, block, closing, rest } = splitFrontmatter(text)

  // 本来没有 frontmatter：在文件最前面补一段
  if (block === null) {
    const added = Object.entries(updates)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${value}`)
    if (added.length === 0) return text
    const lead = added.join('\n')
    return `---\n${lead}\n---\n\n${text}`
  }

  let lines = block.split(/\r?\n/)

  for (const [key, value] of Object.entries(updates)) {
    const keyPattern = new RegExp(`^${escapeRegExp(key)}[ \\t]*:`)
    const positions = []
    for (let i = 0; i < lines.length; i += 1) {
      if (keyPattern.test(lines[i])) positions.push(i)
    }
    if (value === undefined) {
      // 删除该键（以及紧随其后的块标量续行）
      for (let p = positions.length - 1; p >= 0; p -= 1) {
        const at = positions[p]
        let end = at + 1
        while (end < lines.length && (lines[end].trim() === '' || /^[ \t]/.test(lines[end]))) {
          if (lines[end].trim() !== '' && !/^[ \t]/.test(lines[end])) break
          if (lines[end].trim() === '' && (end + 1 >= lines.length || !/^[ \t]/.test(lines[end + 1]))) break
          end += 1
        }
        lines.splice(at, end - at)
      }
      continue
    }
    const nextLine = `${key}: ${value}`
    if (positions.length === 0) {
      lines.push(nextLine)
      continue
    }
    // 多行块标量只保留第一行改写，清掉续行，避免留下孤立的缩进文本
    const at = positions[0]
    let end = at + 1
    while (end < lines.length && /^[ \t]+/.test(lines[end])) end += 1
    lines.splice(at, end - at, nextLine)
    // 重复键只保留第一次
    for (let p = positions.length - 1; p >= 1; p -= 1) {
      const extra = positions[p]
      if (extra <= at) continue
      let stop = extra + 1
      while (stop < lines.length && /^[ \t]+/.test(lines[stop])) stop += 1
      lines.splice(extra, stop - extra)
    }
  }

  const nextBlock = lines.join('\n').replace(/^\n+|\n+$/g, '')
  return `${pre}${nextBlock}${closing}${rest}`
}

// ───────────────────────────────────────────────────────────── 根目录解析

/** 最近的存在 .git 的祖先目录；没有就返回起点本身。 */
function nearestProjectRoot(startPath) {
  let current = resolve(startPath)
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      if (existsSync(join(current, '.git'))) return current
    } catch {
      // 权限问题按「没有 .git」处理
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return resolve(startPath)
}

/**
 * 计算本次请求的扫描根。
 * projectPath 为空时只返回全局根，避免误扫整个磁盘。
 */
function resolveRoots(projectPath, config) {
  const roots = []
  if (typeof projectPath === 'string' && projectPath.trim() !== '') {
    const project = nearestProjectRoot(projectPath)
    roots.push({
      id: 'project-dsh',
      source: 'project-dsh',
      scope: 'project',
      rank: 100,
      path: join(project, '.dsh', 'skills'),
      project,
    })
    roots.push({
      id: 'project-agents',
      source: 'project-agents',
      scope: 'project',
      rank: 200,
      path: join(project, '.agents', 'skills'),
      project,
    })
  }
  for (const dir of config.customSkillDirs) {
    const target = isAbsolute(dir) ? resolve(dir) : resolve(dir)
    roots.push({
      id: `custom:${target}`,
      source: 'custom',
      scope: 'custom',
      rank: 300,
      path: target,
      project: null,
    })
  }
  roots.push({
    id: 'user-dsh',
    source: 'user-dsh',
    scope: 'global',
    rank: 400,
    path: join(dshHome(), 'skills'),
    project: null,
  })
  roots.push({
    id: 'user-agents',
    source: 'user-agents',
    scope: 'global',
    rank: 500,
    path: join(agentsHome(), 'skills'),
    project: null,
  })
  return roots
}

// ───────────────────────────────────────────────────────────── skill 扫描

/** 判断目标是否落在某个根的子树内（根自身不算，根是容器）。 */
function resolveInsideRoot(targetPath, roots) {
  const target = resolve(targetPath)
  for (const root of roots) {
    const base = resolve(root.path)
    if (target === base) continue
    if (target.startsWith(base + sep)) return root
  }
  return null
}

/** 读取并解析一个 SKILL.md / <name>.md。 */
async function readSkill(filePath, root) {
  const info = await stat(filePath)
  if (!info.isFile()) return null
  if (info.size > MAX_SKILL_BYTES) {
    return {
      name: basename(dirname(filePath)) === 'skills' ? basename(filePath, '.md') : basename(dirname(filePath)),
      description: `文件超过 ${Math.round(MAX_SKILL_BYTES / 1024)} KiB，已跳过解析`,
      filePath,
      rootId: root.id,
      source: root.source,
      scope: root.scope,
      rank: root.rank,
      warnings: ['file too large'],
    }
  }
  const text = await readFile(filePath, 'utf8')
  const { block } = splitFrontmatter(text)
  const fields = parseFrontmatterBlock(block)
  const warnings = []

  const isBundle = basename(filePath).toLowerCase() === 'skill.md'
  const dirPath = isBundle ? dirname(filePath) : null
  const fallbackName = isBundle ? basename(dirname(filePath)) : basename(filePath, '.md')

  let skillName = typeof fields.name === 'string' && fields.name.trim() !== '' ? fields.name.trim() : fallbackName
  if (fields.name === undefined) warnings.push('frontmatter 缺少 name，已回退为文件名')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
    warnings.push('name 不是 kebab-case，DSH 会跳过该 skill')
  }

  const description = typeof fields.description === 'string' ? fields.description.trim() : ''
  if (description === '') warnings.push('frontmatter 缺少 description，DSH 会跳过该 skill')

  const whenToUse = typeof fields.whenToUse === 'string' ? fields.whenToUse.trim() : ''

  const disableModel = parseInvocationBool(fields[KEY_DISABLE_MODEL])
  const userInvocableRaw = parseInvocationBool(fields[KEY_USER_INVOCABLE])
  if (disableModel === null) warnings.push(`${KEY_DISABLE_MODEL} 不是合法布尔值，DSH 会跳过该 skill`)
  if (userInvocableRaw === null) warnings.push(`${KEY_USER_INVOCABLE} 不是合法布尔值，DSH 会跳过该 skill`)

  return {
    name: skillName,
    description,
    whenToUse,
    // DSH 语义：modelInvocable 是 disable-model-invocation 的反面
    modelInvocable: disableModel === null ? false : disableModel !== true,
    userInvocable: userInvocableRaw === null ? false : userInvocableRaw !== false,
    invocationInvalid: disableModel === null || userInvocableRaw === null,
    kind: isBundle ? 'bundle' : 'flat',
    filePath,
    dirPath,
    rootId: root.id,
    source: root.source,
    scope: root.scope,
    rank: root.rank,
    size: info.size,
    mtime: info.mtime ? info.mtime.toISOString() : null,
    warnings,
  }
}

/**
 * 扫描一个根：
 *   <root>/<name>/SKILL.md   目录型
 *   <root>/<name>.md         扁平型
 * 与 dsh-skill-filesystem 一致，只认一层。
 */
async function scanRoot(root) {
  let entries = []
  try {
    entries = await readdir(root.path, { withFileTypes: true })
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { root, exists: false, skills: [], error: null }
    }
    return { root, exists: false, skills: [], error: errorText(error) }
  }

  const skills = []
  const tasks = []
  for (const entry of entries.slice(0, MAX_ENTRIES)) {
    const entryName = entry.name
    // 跳过隐藏目录（.system 等）与 node_modules
    if (entryName.startsWith('.') || entryName === 'node_modules') continue
    if (entry.isDirectory()) {
      tasks.push(
        (async () => {
          const file = join(root.path, entryName, 'SKILL.md')
          try {
            if (!existsSync(file)) return
            const parsed = await readSkill(file, root)
            if (parsed) skills.push(parsed)
          } catch {
            // 单个 skill 读取失败不应中断整根扫描
          }
        })(),
      )
      continue
    }
    if (entry.isFile() && entryName.toLowerCase().endsWith('.md')) {
      if (entryName.toLowerCase() === 'skill.md') continue
      tasks.push(
        (async () => {
          try {
            const parsed = await readSkill(join(root.path, entryName), root)
            if (parsed) skills.push(parsed)
          } catch {
            // 忽略单文件失败
          }
        })(),
      )
    }
  }
  await Promise.all(tasks)
  return { root, exists: true, skills, error: null }
}

/** 合并所有根的扫描结果，并按 DSH 的优先级排序。 */
async function collectSkills(roots) {
  const scanned = await Promise.all(roots.map((root) => scanRoot(root)))
  const byName = new Map()
  const all = []

  for (const item of scanned) {
    for (const skill of item.skills) {
      all.push(skill)
    }
  }

  // 同一 name：rank 小者胜出，与 dsh-skill-filesystem 的合并规则一致
  all.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank
    return a.filePath.localeCompare(b.filePath)
  })
  for (const skill of all) {
    const existing = byName.get(skill.name)
    if (existing === undefined) {
      byName.set(skill.name, { ...skill, shadowedBy: null })
    } else {
      // 记录被更高优先级覆盖的条目，便于面板提示
      existing.shadowed = Array.isArray(existing.shadowed) ? existing.shadowed : []
      existing.shadowed.push({
        source: skill.source,
        filePath: skill.filePath,
        rank: skill.rank,
      })
    }
  }

  const skills = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
  return {
    skills,
    roots: scanned.map((item) => ({
      ...item.root,
      exists: item.exists,
      count: item.skills.length,
      error: item.error,
    })),
  }
}

// ───────────────────────────────────────────────────────────── 备份

/** 删除前把整个 skill（目录或单文件）复制到带时间戳的备份目录。 */
async function backupSkill(skill, targetPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const label = `${skill.name}-${basename(targetPath)}`
  const target = join(backupRoot(), stamp, label)
  await mkdir(dirname(target), { recursive: true })
  await cp(targetPath, target, { recursive: true, force: true })
  return target
}

async function listBackups() {
  const base = backupRoot()
  let stamps = []
  try {
    stamps = await readdir(base, { withFileTypes: true })
  } catch {
    return []
  }
  const result = []
  for (const stamp of stamps.slice(0, 100)) {
    if (!stamp.isDirectory()) continue
    const dir = join(base, stamp.name)
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    result.push({
      stamp: stamp.name,
      path: dir,
      items: entries.map((entry) => entry.name),
    })
  }
  result.sort((a, b) => b.stamp.localeCompare(a.stamp))
  return result
}

// ───────────────────────────────────────────────────────────── 路由

function workspaceList(host) {
  try {
    return host.workspaceRegistry.list().map((workspace) => ({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
    }))
  } catch {
    return []
  }
}

function queryParam(request, key) {
  try {
    return new URL(request.url, 'http://localhost').searchParams.get(key)
  } catch {
    return null
  }
}

export function apply(ctx) {
  ctx.inject(['webServer'], (host) => {
    // ── 1) 总览状态：根、工作区、配置、默认项目 ──────────────────────────
    host.effect(
      () =>
        host.webServer.register({
          kind: 'exact',
          path: '/skill-manager/state',
          handler: async (request, response) => {
            if (request.method !== 'GET') {
              response.writeHead(405, { allow: 'GET' })
              response.end()
              return
            }
            try {
              const config = await readConfig()
              const workspaces = workspaceList(host)
              const projectParam = queryParam(request, 'project')
              const project = projectParam ?? (workspaces[0] ? workspaces[0].path : '')
              const roots = resolveRoots(project, config)
              sendJson(response, 200, {
                dshHome: dshHome(),
                agentsHome: agentsHome(),
                configFile: configFile(),
                backupDir: backupRoot(),
                config,
                workspaces,
                project,
                projectRoot: project ? nearestProjectRoot(project) : null,
                roots: roots.map((root) => ({
                  ...root,
                  exists: existsSync(root.path),
                })),
              })
            } catch (error) {
              sendJson(response, 500, { error: errorText(error) })
            }
          },
        }),
      'dsh-skill-manager: state route',
    )

    // ── 2) skill 列表 ────────────────────────────────────────────────────
    host.effect(
      () =>
        host.webServer.register({
          kind: 'exact',
          path: '/skill-manager/skills',
          handler: async (request, response) => {
            if (request.method !== 'GET') {
              response.writeHead(405, { allow: 'GET' })
              response.end()
              return
            }
            try {
              const config = await readConfig()
              const projectParam = queryParam(request, 'project')
              const workspaces = workspaceList(host)
              const project = projectParam ?? (workspaces[0] ? workspaces[0].path : '')
              const roots = resolveRoots(project, config)
              const collected = await collectSkills(roots)
              sendJson(response, 200, {
                project,
                projectRoot: project ? nearestProjectRoot(project) : null,
                dshHome: dshHome(),
                agentsHome: agentsHome(),
                skills: collected.skills,
                roots: collected.roots,
              })
            } catch (error) {
              sendJson(response, 500, { error: errorText(error) })
            }
          },
        }),
      'dsh-skill-manager: skills route',
    )

    // ── 3) 读取单个 skill 原文 ───────────────────────────────────────────
    host.effect(
      () =>
        host.webServer.register({
          kind: 'exact',
          path: '/skill-manager/file',
          handler: async (request, response) => {
            if (request.method === 'GET') {
              const target = queryParam(request, 'path')
              if (target === null || target.trim() === '') {
                sendJson(response, 400, { error: '缺少 path 参数' })
                return
              }
              try {
                const config = await readConfig()
                const roots = resolveRoots(queryParam(request, 'project') ?? '', config)
                // 允许读取任意根内的文件，即使当前未选项目
                const allRoots = resolveRoots(host.workspaceRegistry.list()[0]?.path ?? '', config)
                const root = resolveInsideRoot(target, roots) ?? resolveInsideRoot(target, allRoots)
                if (root === null) {
                  sendJson(response, 403, { error: '路径不在任何 skill 根目录内' })
                  return
                }
                const resolved = resolve(target)
                if (!resolved.toLowerCase().endsWith('.md')) {
                  sendJson(response, 400, { error: '只允许读取 .md 文件' })
                  return
                }
                const content = await readFile(resolved, 'utf8')
                sendJson(response, 200, { path: resolved, content, exists: true })
              } catch (error) {
                if (error && error.code === 'ENOENT') {
                  sendJson(response, 404, { error: '文件不存在' })
                  return
                }
                sendJson(response, 500, { error: errorText(error) })
              }
              return
            }

            if (request.method === 'POST') {
              if (!sameOrigin(request)) {
                response.writeHead(403)
                response.end()
                return
              }
              try {
                const body = await readJsonBody(request, MAX_BODY_BYTES)
                const target = typeof body.path === 'string' ? body.path : ''
                const content = typeof body.content === 'string' ? body.content : null
                if (target === '' || content === null) {
                  sendJson(response, 400, { error: 'path 与 content 都是必填字符串' })
                  return
                }
                const config = await readConfig()
                const roots = resolveRoots(queryParam(request, 'project') ?? '', config)
                const allRoots = resolveRoots(host.workspaceRegistry.list()[0]?.path ?? '', config)
                const root = resolveInsideRoot(target, roots) ?? resolveInsideRoot(target, allRoots)
                if (root === null) {
                  sendJson(response, 403, { error: '路径不在任何 skill 根目录内' })
                  return
                }
                const resolved = resolve(target)
                if (!resolved.toLowerCase().endsWith('.md')) {
                  sendJson(response, 400, { error: '只允许写入 .md 文件' })
                  return
                }
                await mkdir(dirname(resolved), { recursive: true })
                await writeFile(resolved, content, 'utf8')
                sendJson(response, 200, { ok: true, path: resolved })
              } catch (error) {
                sendJson(response, 500, { error: errorText(error) })
              }
              return
            }

            response.writeHead(405, { allow: 'GET, POST' })
            response.end()
          },
        }),
      'dsh-skill-manager: file route',
    )

    // ── 4) 新建 skill ────────────────────────────────────────────────────
    host.effect(
      () =>
        host.webServer.register({
          kind: 'exact',
          path: '/skill-manager/create',
          handler: async (request, response) => {
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'POST' })
              response.end()
              return
            }
            if (!sameOrigin(request)) {
              response.writeHead(403)
              response.end()
              return
            }
            try {
              const body = await readJsonBody(request, MAX_BODY_BYTES)
              const rootId = typeof body.rootId === 'string' ? body.rootId : ''
              const skillName = typeof body.name === 'string' ? body.name.trim() : ''
              const description = typeof body.description === 'string' ? body.description.trim() : ''
              const whenToUse = typeof body.whenToUse === 'string' ? body.whenToUse.trim() : ''
              const modelInvocable = body.modelInvocable !== false
              const userInvocable = body.userInvocable !== false

              if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
                sendJson(response, 400, { error: 'name 必须是小写 kebab-case（如 my-skill）' })
                return
              }
              if (description === '') {
                sendJson(response, 400, { error: 'description 不能为空' })
                return
              }

              const config = await readConfig()
              const project = typeof body.project === 'string' ? body.project : ''
              const roots = resolveRoots(project, config)
              const root = roots.find((item) => item.id === rootId)
              if (root === undefined) {
                sendJson(response, 400, { error: `未知的 rootId: ${rootId}` })
                return
              }

              const dir = join(root.path, skillName)
              const file = join(dir, 'SKILL.md')
              if (existsSync(file)) {
                sendJson(response, 409, { error: `已存在同名 skill: ${skillName}` })
                return
              }

              const lines = ['---', `name: ${skillName}`, `description: ${description}`]
              if (whenToUse !== '') lines.push(`whenToUse: ${whenToUse}`)
              if (!modelInvocable) lines.push(`${KEY_DISABLE_MODEL}: true`)
              if (!userInvocable) lines.push(`${KEY_USER_INVOCABLE}: false`)
              lines.push('---', '')
              lines.push(`# ${skillName}`)
              lines.push('')
              lines.push('## 何时使用')
              lines.push('')
              lines.push(whenToUse !== '' ? whenToUse : description)
              lines.push('')
              lines.push('## 步骤')
              lines.push('')
              lines.push('1. ')
              lines.push('')

              await mkdir(dir, { recursive: true })
              await writeFile(file, `${lines.join('\n')}`, 'utf8')
              sendJson(response, 200, {
                ok: true,
                path: file,
                rootId,
                rootPath: root.path,
              })
            } catch (error) {
              sendJson(response, 500, { error: errorText(error) })
            }
          },
        }),
      'dsh-skill-manager: create route',
    )

    // ── 5) 启停开关（文本级改 frontmatter）──────────────────────────────
    host.effect(
      () =>
        host.webServer.register({
          kind: 'exact',
          path: '/skill-manager/toggle',
          handler: async (request, response) => {
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'POST' })
              response.end()
              return
            }
            if (!sameOrigin(request)) {
              response.writeHead(403)
              response.end()
              return
            }
            try {
              const body = await readJsonBody(request, MAX_BODY_BYTES)
              const target = typeof body.path === 'string' ? body.path : ''
              if (target === '') {
                sendJson(response, 400, { error: '缺少 path' })
                return
              }
              const config = await readConfig()
              const allRoots = resolveRoots(host.workspaceRegistry.list()[0]?.path ?? '', config)
              const extraRoots = resolveRoots(typeof body.project === 'string' ? body.project : '', config)
              const root = resolveInsideRoot(target, extraRoots) ?? resolveInsideRoot(target, allRoots)
              if (root === null) {
                sendJson(response, 403, { error: '路径不在任何 skill 根目录内' })
                return
              }
              const resolved = resolve(target)
              if (!resolved.toLowerCase().endsWith('.md')) {
                sendJson(response, 400, { error: '只允许操作 .md 文件' })
                return
              }

              const updates = {}
              if (typeof body.modelInvocable === 'boolean') {
                updates[KEY_DISABLE_MODEL] = body.modelInvocable ? undefined : 'true'
              }
              if (typeof body.userInvocable === 'boolean') {
                updates[KEY_USER_INVOCABLE] = body.userInvocable ? undefined : 'false'
              }
              if (Object.keys(updates).length === 0) {
                sendJson(response, 400, { error: '没有需要修改的开关' })
                return
              }

              const text = await readFile(resolved, 'utf8')
              const next = patchFrontmatter(text, updates)
              await writeFile(resolved, next, 'utf8')
              sendJson(response, 200, { ok: true, path: resolved })
            } catch (error) {
              sendJson(response, 500, { error: errorText(error) })
            }
          },
        }),
      'dsh-skill-manager: toggle route',
    )

    // ── 6) 删除 skill（先备份）───────────────────────────────────────────
    host.effect(
      () =>
        host.webServer.register({
          kind: 'exact',
          path: '/skill-manager/delete',
          handler: async (request, response) => {
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'POST' })
              response.end()
              return
            }
            if (!sameOrigin(request)) {
              response.writeHead(403)
              response.end()
              return
            }
            try {
              const body = await readJsonBody(request, MAX_BODY_BYTES)
              const target = typeof body.path === 'string' ? body.path : ''
              if (target === '') {
                sendJson(response, 400, { error: '缺少 path' })
                return
              }
              const config = await readConfig()
              const extraRoots = resolveRoots(typeof body.project === 'string' ? body.project : '', config)
              const allRoots = resolveRoots(host.workspaceRegistry.list()[0]?.path ?? '', config)
              const root = resolveInsideRoot(target, extraRoots) ?? resolveInsideRoot(target, allRoots)
              if (root === null) {
                sendJson(response, 403, { error: '路径不在任何 skill 根目录内' })
                return
              }

              const resolved = resolve(target)
              const isBundle = basename(resolved).toLowerCase() === 'skill.md'
              const removeTarget = isBundle ? dirname(resolved) : resolved
              // 目录型删除时要确保删的是根的直接子项，避免误删更深层目录
              if (resolveInsideRoot(removeTarget, [root]) === null) {
                sendJson(response, 403, { error: '拒绝删除根目录本身或更深层的目录' })
                return
              }

              const skillName = isBundle ? basename(dirname(resolved)) : basename(resolved, '.md')
              const backupPath = await backupSkill(
                { name: skillName },
                removeTarget,
              )
              await rm(removeTarget, { recursive: true, force: true })
              sendJson(response, 200, { ok: true, removed: removeTarget, backup: backupPath })
            } catch (error) {
              sendJson(response, 500, { error: errorText(error) })
            }
          },
        }),
      'dsh-skill-manager: delete route',
    )

    // ── 7) 自定义 skill 根配置 ───────────────────────────────────────────
    host.effect(
      () =>
        host.webServer.register({
          kind: 'exact',
          path: '/skill-manager/config',
          handler: async (request, response) => {
            if (request.method === 'GET') {
              try {
                const config = await readConfig()
                sendJson(response, 200, { ...config, configFile: configFile() })
              } catch (error) {
                sendJson(response, 500, { error: errorText(error) })
              }
              return
            }
            if (request.method === 'POST') {
              if (!sameOrigin(request)) {
                response.writeHead(403)
                response.end()
                return
              }
              try {
                const body = await readJsonBody(request, MAX_BODY_BYTES)
                const dirs = Array.isArray(body.customSkillDirs) ? body.customSkillDirs : []
                const cleaned = []
                for (const item of dirs) {
                  if (typeof item !== 'string') continue
                  const trimmed = item.trim()
                  if (trimmed === '') continue
                  const resolved = resolve(trimmed)
                  if (!cleaned.includes(resolved)) cleaned.push(resolved)
                }
                const saved = await writeConfig({ customSkillDirs: cleaned })
                sendJson(response, 200, { ok: true, ...saved })
              } catch (error) {
                sendJson(response, 500, { error: errorText(error) })
              }
              return
            }
            response.writeHead(405, { allow: 'GET, POST' })
            response.end()
          },
        }),
      'dsh-skill-manager: config route',
    )

    // ── 8) 备份列表 ──────────────────────────────────────────────────────
    host.effect(
      () =>
        host.webServer.register({
          kind: 'exact',
          path: '/skill-manager/backups',
          handler: async (request, response) => {
            if (request.method !== 'GET') {
              response.writeHead(405, { allow: 'GET' })
              response.end()
              return
            }
            try {
              const backups = await listBackups()
              sendJson(response, 200, { backupDir: backupRoot(), backups })
            } catch (error) {
              sendJson(response, 500, { error: errorText(error) })
            }
          },
        }),
      'dsh-skill-manager: backups route',
    )
  })
}
