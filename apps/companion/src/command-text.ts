const digits = '零一二三四五六七八九'
export function chineseNumber(value: string): number {
  if (/^\d+$/.test(value)) return Number(value)
  if (value === '两') return 2
  if (value.includes('十')) { const [tens, ones] = value.split('十'); return (tens ? digits.indexOf(tens) : 1) * 10 + (ones ? digits.indexOf(ones) : 0) }
  return digits.indexOf(value)
}
export const normalizeName = (value: string): string => value.normalize('NFKC').replace(/^@/, '').replace(/\s+/g, '').replace(/([1-9])楼/g, (_match, n: string) => `${digits[Number(n)]}楼`)
export const formationAlias = (value: string) => normalizeName(value).replace(/^([\d一二三四五六七八九十两]+)队$/, (_match, n: string) => `${chineseNumber(n)}队`)
export const catalogName = (value: string): string => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
export const commandClauses = (text: string): string[] => normalizeName(text).split(/[，,。；;\n]/)
export const attackVerb = (text: string): RegExpMatchArray | null => text.match(/攻击|进攻|摧毁|消灭|清理|清除|扫清|轰炸|监视|警戒|盯住/)
export const namedFormation = (text: string): string | undefined => {
  const match = text.match(/([\d一二三四五六七八九十两]+)队/)
  return match ? formationAlias(`${match[1]}队`) : undefined
}
