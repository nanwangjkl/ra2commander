export interface ModelSettingsView {
  revision: number
  warning: string
  baseUrl: string
  model: string
  hasKey: boolean
}
export interface ModelSettingsInput {
  baseUrl: string
  model: string
  apiKey?: string
  revision: number
}
