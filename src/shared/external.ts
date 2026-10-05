/** What may leave the app: links for the browser, files for their default app (pure, tested). */

/** Web and mail links; any other scheme (file:, javascript:, custom app protocols) stays closed. */
export const isWebUrl = (url: string): boolean => /^(https?|mailto):/i.test(url)

/**
 * Files their default app only shows. Everything else, unknown extensions included, is revealed in its folder
 * instead: opening a program, a script or a shortcut runs it (.exe, .bat, .ps1, .js through Windows Script Host,
 * .command and .app on macOS, a Mach-O without extension...).
 */
const VIEWABLE = new Set([
  // documents
  'pdf', 'doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp', 'pages', 'numbers', 'key', 'epub',
  // text and data
  'txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'sql', 'html', 'htm',
  // images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'ico', 'icns', 'svg', 'heic', 'heif', 'avif', 'psd',
  'ai', 'eps', 'sketch', 'fig',
  // audio and video
  'mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'mpg', 'mpeg',
  // fonts, archives, 3D
  'ttf', 'otf', 'woff', 'woff2', 'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'stl', 'obj', 'glb', 'gltf',
])

export function opensInDefaultApp(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 && VIEWABLE.has(name.slice(dot + 1).toLowerCase())
}
