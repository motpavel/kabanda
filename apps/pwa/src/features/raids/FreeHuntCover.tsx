import { appPath } from '../../lib/paths'
import './free-hunt-cover.css'

export const freeHuntCoverUrl = appPath('brand/kabanda-free-hunt-v1.jpg')

export function FreeHuntCover() {
  return <figure className="raid-free-hunt-cover">
    <img src={freeHuntCoverUrl} width="1312" height="1199" alt="Кабанда на велосипедах и город с красными отметками точек" decoding="async" />
    <figcaption>Свободная охота</figcaption>
  </figure>
}
