export const SPEECH_KEYS = { Backquote: '反引号 `', ControlRight: '右 Ctrl', AltRight: '右 Alt', F8: 'F8', F9: 'F9' } as const
export type SpeechKey = keyof typeof SPEECH_KEYS
export interface SpeechSettingsInput { revision: number; deviceId: string; key: SpeechKey }
export interface SpeechSettingsView extends SpeechSettingsInput {
  /** 宿主解析的只读诊断，不作为页面可编辑配置。 */
  modelDir: string
  warning: string
  engine: { state: 'missing' | 'loading' | 'ready' | 'error' | 'closed'; error: string }
}
export interface SpeechTiming { model: string; audioMs?: number; recognitionMs?: number }
