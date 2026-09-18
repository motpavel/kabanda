import { appPath } from '../lib/paths'
import './rider-loader.css'

export function RiderLoader({ label = 'Загрузка' }: { label?: string }) {
  return <div className="rider-loader" role="status" aria-label={label}>
    <div className="rider-loader__badge" aria-hidden="true">
      <img src={appPath('brand/kabanda-logo-reference.png')} alt="" />
      <span className="rider-loader__orbit"><span className="rider-loader__comet" /></span>
    </div>
  </div>
}
