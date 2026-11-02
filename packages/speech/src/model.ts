import { createRequire } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface SpeechModelManifest {
  schemaVersion: 1; id: string; name: string; version: string; engine: string; documentation: string
  archive: { url: string; directory: string; bytes: number; sha256: string }
  license: { file: string; upstream: string; note: string }
  runtime: { sampleRate: number; language: string }
  files: Array<{ path: string; role: 'model' | 'tokens' | 'license' | 'example'; required: boolean; bytes: number; sha256: string }>
}
export const SPEECH_MODEL_MANIFEST: SpeechModelManifest = createRequire(import.meta.url)('../model-manifest.json')
export const SPEECH_MODEL = SPEECH_MODEL_MANIFEST.id
export const SPEECH_MODEL_URL = SPEECH_MODEL_MANIFEST.archive.url
export const SPEECH_MODEL_SHA256 = SPEECH_MODEL_MANIFEST.archive.sha256
export const defaultSpeechModelDir = (root: string): string => join(root, 'resources/speech/models', SPEECH_MODEL)
export const legacySpeechModelDir = (root: string): string => join(root, '.runtime/speech/models', SPEECH_MODEL)

/** 轻量就绪判断；完整字节数及哈希校验由安装/检查命令完成。自定义模型仍可使用。 */
export function hasSpeechModelFiles(folder: string): boolean {
  return SPEECH_MODEL_MANIFEST.files.filter(file => ['model', 'tokens'].includes(file.role)).every(file => {
    try { const info = statSync(join(folder, file.path)); return info.isFile() && info.size > 0 } catch { return false }
  })
}
export function resolveSpeechModelDir(root: string, configured = ''): string {
  const builtin = defaultSpeechModelDir(root), legacy = legacySpeechModelDir(root), value = configured.trim()
  if (value) {
    const path = resolve(root, value.startsWith('~/') ? join(homedir(), value.slice(2)) : value)
    // 兼容旧设置曾保存的默认绝对路径；自选目录保持原选择。
    return path === legacy && hasSpeechModelFiles(builtin) ? builtin : path
  }
  return !existsSync(builtin) && hasSpeechModelFiles(legacy) ? legacy : builtin
}
