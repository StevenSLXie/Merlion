import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import ts from 'typescript'

import type { ToolDefinition } from '../types.js'

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'])
const SKIP_DIRS = new Set(['.git', '.merlion', 'node_modules', 'dist', 'build', 'coverage', 'bench'])
const MAX_INFERRED_FILES = 2000

interface CachedProject {
  cwd: string
  rootFiles: string[]
  options: ts.CompilerOptions
  projectVersion: number
  fileVersions: Map<string, string>
  fileMtims: Map<string, number>
  languageService: ts.LanguageService
}

const PROJECT_CACHE = new Map<string, CachedProject>()

function normalizePath(value: string): string {
  return path.resolve(value)
}

function isSupportedFile(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

async function collectSourceFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_INFERRED_FILES) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (out.length >= MAX_INFERRED_FILES) return
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(path.join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const full = path.join(dir, entry.name)
      if (isSupportedFile(full)) out.push(normalizePath(full))
    }
  }
  await walk(root)
  return out.sort()
}

async function loadProjectFiles(cwd: string): Promise<{ rootFiles: string[]; options: ts.CompilerOptions }> {
  const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, 'tsconfig.json')
    ?? ts.findConfigFile(cwd, ts.sys.fileExists, 'jsconfig.json')

  if (configPath) {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
    if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'))
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath))
    const rootFiles = parsed.fileNames
      .filter(isSupportedFile)
      .map((file) => normalizePath(file))
      .sort()
    return { rootFiles, options: parsed.options }
  }

  const rootFiles = await collectSourceFiles(cwd)
  return {
    rootFiles,
    options: {
      allowJs: true,
      checkJs: true,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
    },
  }
}

async function getFileMtimeMs(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).mtimeMs
  } catch {
    return 0
  }
}

async function getOrCreateProject(cwd: string): Promise<CachedProject> {
  const resolvedCwd = normalizePath(cwd)
  const loaded = await loadProjectFiles(resolvedCwd)
  if (loaded.rootFiles.length === 0) {
    throw new Error('No supported JS/TS source files found for LSP operations.')
  }

  const existing = PROJECT_CACHE.get(resolvedCwd)
  const desiredKey = JSON.stringify(loaded.rootFiles)
  const existingKey = existing ? JSON.stringify(existing.rootFiles) : null
  if (existing && existingKey === desiredKey) {
    for (const file of existing.rootFiles) {
      const nextMtime = await getFileMtimeMs(file)
      const prevMtime = existing.fileMtims.get(file)
      if (prevMtime !== nextMtime) {
        existing.fileMtims.set(file, nextMtime)
        existing.fileVersions.set(file, String(Number(existing.fileVersions.get(file) ?? '0') + 1))
        existing.projectVersion += 1
      }
    }
    return existing
  }

  const fileVersions = new Map<string, string>()
  const fileMtims = new Map<string, number>()
  for (const file of loaded.rootFiles) {
    fileVersions.set(file, '0')
    fileMtims.set(file, await getFileMtimeMs(file))
  }

  const project: CachedProject = {
    cwd: resolvedCwd,
    rootFiles: loaded.rootFiles,
    options: loaded.options,
    projectVersion: 0,
    fileVersions,
    fileMtims,
    languageService: null as unknown as ts.LanguageService,
  }

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => project.options,
    getCurrentDirectory: () => project.cwd,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    getProjectVersion: () => String(project.projectVersion),
    getScriptFileNames: () => project.rootFiles,
    getScriptVersion: (fileName) => project.fileVersions.get(normalizePath(fileName)) ?? '0',
    getScriptSnapshot: (fileName) => {
      try {
        const text = ts.sys.readFile(fileName)
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
      } catch {
        return undefined
      }
    },
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  }

  project.languageService = ts.createLanguageService(host, ts.createDocumentRegistry())
  PROJECT_CACHE.set(resolvedCwd, project)
  return project
}

function relativeToCwd(cwd: string, filePath: string): string {
  const relative = path.relative(cwd, filePath).replace(/\\/g, '/')
  return relative === '' ? path.basename(filePath) : relative
}

function getSourceFileOrThrow(project: CachedProject, filePath: string): ts.SourceFile {
  const program = project.languageService.getProgram()
  const source = program?.getSourceFile(filePath)
  if (!source) throw new Error(`File is not part of the current JS/TS project: ${relativeToCwd(project.cwd, filePath)}`)
  return source
}

function positionToOffset(sourceFile: ts.SourceFile, line: number, character: number): number {
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(character) || character < 1) {
    throw new Error('Invalid position: line and character must be positive integers.')
  }
  const maxLine = sourceFile.getLineAndCharacterOfPosition(sourceFile.end).line + 1
  if (line > maxLine) throw new Error('Invalid position: line is outside the file.')
  return sourceFile.getPositionOfLineAndCharacter(line - 1, character - 1)
}

function serializeSpan(
  sourceFile: ts.SourceFile,
  start: number,
  length: number,
): { line: number; character: number; endLine: number; endCharacter: number } {
  const begin = sourceFile.getLineAndCharacterOfPosition(start)
  const end = sourceFile.getLineAndCharacterOfPosition(start + length)
  return {
    line: begin.line + 1,
    character: begin.character + 1,
    endLine: end.line + 1,
    endCharacter: end.character + 1,
  }
}

function flattenNavigationTree(
  sourceFile: ts.SourceFile,
  item: ts.NavigationTree,
  depth = 0,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  if (item.text !== '<global>') {
    const span = item.spans[0]
    if (span) {
      rows.push({
        name: item.text,
        kind: item.kind,
        depth,
        ...serializeSpan(sourceFile, span.start, span.length),
      })
    }
  }
  for (const child of item.childItems ?? []) rows.push(...flattenNavigationTree(sourceFile, child, depth + 1))
  return rows
}

function diagnosticCategory(category: ts.DiagnosticCategory): string {
  switch (category) {
    case ts.DiagnosticCategory.Error: return 'error'
    case ts.DiagnosticCategory.Warning: return 'warning'
    case ts.DiagnosticCategory.Suggestion: return 'suggestion'
    case ts.DiagnosticCategory.Message: return 'message'
  }
}

export const lspTool: ToolDefinition = {
  name: 'lsp',
  description: 'Semantic code navigation for JS/TS projects: definitions, references, hover, symbols, and diagnostics.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['definition', 'references', 'hover', 'document_symbols', 'workspace_symbols', 'diagnostics'] },
      path: { type: 'string' },
      line: { type: 'integer' },
      character: { type: 'integer' },
      query: { type: 'string' },
    },
    required: ['action'],
  },
  concurrencySafe: true,
  async execute(input, ctx) {
    const action = input.action
    if (typeof action !== 'string') {
      return { content: 'Invalid action: expected string.', isError: true }
    }
    try {
      const project = await getOrCreateProject(ctx.cwd)
      const service = project.languageService
      const workspacePath = typeof input.path === 'string' && input.path.trim() !== ''
        ? normalizePath(path.resolve(ctx.cwd, input.path))
        : null

      if (workspacePath && !isSupportedFile(workspacePath)) {
        return { content: `Unsupported file for lsp: ${input.path}`, isError: true }
      }

      if (action === 'workspace_symbols') {
        const query = typeof input.query === 'string' ? input.query.trim() : ''
        if (query === '') return { content: 'workspace_symbols requires a non-empty query.', isError: true }
        const items = service.getNavigateToItems(query).map((item) => ({
          name: item.name,
          kind: item.kind,
          containerName: item.containerName,
          path: relativeToCwd(project.cwd, normalizePath(item.fileName)),
          ...serializeSpan(getSourceFileOrThrow(project, normalizePath(item.fileName)), item.textSpan.start, item.textSpan.length),
        }))
        return { content: JSON.stringify({ action, query, results: items }, null, 2), isError: false }
      }

      if (!workspacePath) return { content: `${action} requires a file path.`, isError: true }
      const sourceFile = getSourceFileOrThrow(project, workspacePath)

      if (action === 'document_symbols') {
        const tree = service.getNavigationTree(workspacePath)
        return {
          content: JSON.stringify({
            action,
            path: relativeToCwd(project.cwd, workspacePath),
            results: flattenNavigationTree(sourceFile, tree),
          }, null, 2),
          isError: false,
        }
      }

      if (action === 'diagnostics') {
        const diagnostics = [
          ...service.getSyntacticDiagnostics(workspacePath),
          ...service.getSemanticDiagnostics(workspacePath),
        ].map((diagnostic) => ({
          code: diagnostic.code,
          category: diagnosticCategory(diagnostic.category),
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
          ...(diagnostic.start !== undefined && diagnostic.length !== undefined
            ? serializeSpan(sourceFile, diagnostic.start, diagnostic.length)
            : {}),
        }))
        return {
          content: JSON.stringify({ action, path: relativeToCwd(project.cwd, workspacePath), results: diagnostics }, null, 2),
          isError: false,
        }
      }

      const line = input.line
      const character = input.character
      if (typeof line !== 'number' || typeof character !== 'number') {
        return { content: `${action} requires numeric line and character.`, isError: true }
      }
      const offset = positionToOffset(sourceFile, line, character)

      if (action === 'definition') {
        const results = (service.getDefinitionAtPosition(workspacePath, offset) ?? []).map((item) => ({
          path: relativeToCwd(project.cwd, normalizePath(item.fileName)),
          kind: item.kind,
          name: item.name,
          containerName: item.containerName,
          ...serializeSpan(getSourceFileOrThrow(project, normalizePath(item.fileName)), item.textSpan.start, item.textSpan.length),
        }))
        return {
          content: JSON.stringify({ action, path: relativeToCwd(project.cwd, workspacePath), results }, null, 2),
          isError: false,
        }
      }

      if (action === 'references') {
        const seen = new Set<string>()
        const results = (service.getReferencesAtPosition(workspacePath, offset) ?? []).flatMap((item) => {
          const normalizedFile = normalizePath(item.fileName)
          const key = `${normalizedFile}:${item.textSpan.start}:${item.textSpan.length}`
          if (seen.has(key)) return []
          seen.add(key)
          return [{
            path: relativeToCwd(project.cwd, normalizedFile),
            ...serializeSpan(getSourceFileOrThrow(project, normalizedFile), item.textSpan.start, item.textSpan.length),
          }]
        })
        return {
          content: JSON.stringify({ action, path: relativeToCwd(project.cwd, workspacePath), results }, null, 2),
          isError: false,
        }
      }

      const info = service.getQuickInfoAtPosition(workspacePath, offset)
      const results = info ? [{
        display: ts.displayPartsToString(info.displayParts),
        documentation: ts.displayPartsToString(info.documentation),
        ...serializeSpan(sourceFile, info.textSpan.start, info.textSpan.length),
      }] : []
      return {
        content: JSON.stringify({ action, path: relativeToCwd(project.cwd, workspacePath), results }, null, 2),
        isError: false,
      }
    } catch (error) {
      return { content: String(error instanceof Error ? error.message : error), isError: true }
    }
  },
}
