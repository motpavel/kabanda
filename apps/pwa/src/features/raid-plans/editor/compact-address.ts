const streetPattern = /(?:улиц[аы]|(?:^|\s)ул\.|проспект|пр-т|переулок|(?:^|\s)пер\.|проезд|набережн|бульвар|шоссе|площадь|тупик|аллея)/iu
const administrativePart = /(?:район|республик|область|федеральный округ|городской округ|муниципальн|микрорайон)|^(?:Россия|Российская Федерация|Ижевск|г\.?\s*Ижевск|\d{6})$/iu
const houseNumber = /^(?:д(?:ом)?\.?\s*)?\d+[\p{L}]?(?:[\s/\-\d\p{L}.]*)$/u

/** Shorten legacy geocoder labels without truncating an arbitrary user-written label. */
export function compactRouteAddress(value: string): string {
  const parts = value.split(',').map(part => part.trim()).filter(Boolean)
  if (parts.length <= 1) return value.trim()
  const street = parts.find(part => streetPattern.test(part) && !administrativePart.test(part))
  if (street) {
    const house = parts.find(part => part !== street && !administrativePart.test(part) && houseNumber.test(part))
    return [street, house].filter(Boolean).join(', ')
  }
  return parts.filter(part => !administrativePart.test(part)).join(', ')
}
