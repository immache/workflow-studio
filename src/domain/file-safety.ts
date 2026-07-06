const WINDOWS_RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
])

export function normalizeZipPath(name: string): string {
  return name.replaceAll('\\', '/')
}

export function unsafePathReason(name: string): string | null {
  const raw = name.trim()
  const normalized = normalizeZipPath(raw)
  if (!raw || !normalized) return '路径为空。'
  if (raw.includes('\0')) return '路径包含空字符。'
  if (raw.startsWith('\\\\') || normalized.startsWith('//')) return '路径不能是 UNC 或网络路径。'
  if (normalized.startsWith('/')) return '路径不能是绝对路径。'
  if (/^[a-zA-Z]:/.test(raw) || /^[a-zA-Z]:/.test(normalized)) return '路径不能包含 Windows 盘符。'
  if (normalized.split('/').some((part) => part === '..')) return '路径不能包含上级目录。'
  if (normalized.split('/').some((part) => part.trim().length === 0)) return '路径不能包含空目录名。'
  if (normalized.split('/').some((part) => part === '__MACOSX')) return '不接受 __MACOSX 系统目录。'
  return null
}

export function unsafeDocumentFilenameReason(filename: string): string | null {
  const pathReason = unsafePathReason(filename)
  if (pathReason) return pathReason
  const normalized = normalizeZipPath(filename.trim())
  if (normalized.includes('/')) return '文档文件名必须是单个文件名，不能包含目录。'
  if (/[<>:"|?*]/.test(normalized)) return '文档文件名包含 Windows 不安全字符。'
  if (/[. ]$/.test(normalized)) return '文档文件名不能以点或空格结尾。'
  const stem = normalized.replace(/\.[^.]*$/, '').toLowerCase()
  if (WINDOWS_RESERVED_NAMES.has(stem)) return '文档文件名不能使用 Windows 保留名。'
  return null
}
