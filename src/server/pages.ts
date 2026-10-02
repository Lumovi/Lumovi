/**
 * The page and its files, from the renderer's build. Paths that aren't files
 * are the page (its router takes it from there), served with the base path
 * it's under and the theme the browser chose, so it never flashes the other.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'

/** The files the page has, by extension; any other path is the page. */
const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
}
/** Fonts and images come compressed already. */
const COMPRESSIBLE = new Set(['.js', '.css', '.svg'])

/** As strict as the desktop app's: nothing but the server's own files and WebSocket. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
].join('; ')

export type Encoding = 'br' | 'gzip'

export interface StaticFile {
  type: string
  /** Hashed file names never change: cached for good. */
  immutable: boolean
  /** The file, and (when worth it) compressed copies, made once. */
  body: (encoding?: Encoding) => Promise<Buffer>
  compressible: boolean
}

const compressors: Record<Encoding, (data: Buffer) => Promise<Buffer>> = {
  br: (data) =>
    promisify(brotliCompress)(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }),
  gzip: (data) => promisify(gzip)(data, { level: 9 }),
}

export class Pages {
  readonly #template: string
  /** The files there are, by their paths below the base path: nothing else is ever read. */
  readonly #files: Map<string, StaticFile>

  constructor(dir: string, basePath: string) {
    this.#files = new Map(
      readdirSync(dir, { recursive: true, encoding: 'utf8' })
        .map((path) => path.split(sep).join('/'))
        .filter((path) => this.isFile(path))
        .map((path) => [path, staticFile(join(dir, path), path)]),
    )
    this.#template = readFileSync(join(dir, 'index.html'), 'utf8')
      // Sent as a header instead, with frame-ancestors (which a meta tag can't set).
      .replace(/\s*<meta\s+http-equiv="Content-Security-Policy"[^>]*>/, '')
      // The page's files are relative to it, wherever it is below the server's base path.
      .replace(/<meta charset="UTF-8" \/>/, `$&\n    <base href="${basePath}" />`)
  }

  /** The page, in the browser's chosen theme. */
  page(theme: string | undefined): string {
    const chosen = theme === 'light' || theme === 'dark' ? ` data-theme="${theme}"` : ''
    return this.#template.replace('<html lang="en">', `<html lang="en"${chosen}>`)
  }

  /** Whether a path names one of the page's files rather than the page. */
  isFile(path: string): boolean {
    return extname(path) in TYPES
  }

  /** One of the page's files, by its path below the base path. */
  file(path: string): StaticFile | undefined {
    return this.#files.get(path)
  }
}

function staticFile(full: string, path: string): StaticFile {
  const extension = extname(path)
  const compressible = COMPRESSIBLE.has(extension)
  // Read, and compressed, when first asked for.
  let data: Promise<Buffer> | undefined
  const copies = new Map<Encoding, Promise<Buffer>>()
  return {
    type: TYPES[extension]!,
    immutable: path.startsWith('assets/'),
    compressible,
    body: (encoding) => {
      data ??= readFile(full)
      if (!encoding || !compressible) return data
      let copy = copies.get(encoding)
      if (!copy) {
        copy = data.then(compressors[encoding])
        copies.set(encoding, copy)
      }
      return copy
    },
  }
}

/** The best encoding a browser accepts. */
export function acceptedEncoding(header: string | undefined): Encoding | undefined {
  const accepted = (header ?? '').split(',').map((part) => part.trim().split(';')[0])
  return accepted.includes('br') ? 'br' : accepted.includes('gzip') ? 'gzip' : undefined
}
