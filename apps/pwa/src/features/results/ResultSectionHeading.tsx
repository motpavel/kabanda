import { appPath } from '../../lib/paths'

export function ResultSectionHeading({ icon, children }: { icon: 'route' | 'analytics' | 'pack' | 'photos'; children: string }) {
  const image = `url("${appPath(`brand/result-icons/${icon}-${icon === 'pack' ? 'v4' : 'v2'}.png`)}")`
  return <h2 className="result-section-heading"><span className="result-section-heading__icon" aria-hidden="true" style={{ maskImage: image, WebkitMaskImage: image }} />{children}</h2>
}
