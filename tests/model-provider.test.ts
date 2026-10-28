import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenAICompatibleProvider } from '../packages/model-providers/src/index.ts'

test('同一模型适配器并行返回时，响应正文和用量保持各自请求的关联', async () => {
  const fetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const { messages } = JSON.parse(String(init!.body))
    const value = messages[0].content === 'first' ? 11 : 22
    return Response.json({ choices: [{ message: { content: String(value) } }], usage: { prompt_tokens: value, completion_tokens: value + 1 } })
  }
  try {
    const provider = new OpenAICompatibleProvider({ name: 'fixture', model: 'fixture', baseUrl: 'https://fixture.invalid', apiKey: 'fixture' })
    const [first, second] = await Promise.all(['first', 'second'].map(content => provider.generate({ messages: [{ role: 'user', content }] })))
    assert.deepEqual([first!.text, first!.usage?.promptTokens, first!.usage?.completionTokens], ['11', 11, 12])
    assert.deepEqual([second!.text, second!.usage?.promptTokens, second!.usage?.completionTokens], ['22', 22, 23])
  } finally { globalThis.fetch = fetch }
})
