import { appPath } from '../../lib/paths'

export function SessionUnavailable({ message, checking = false, onRetry }: {
  message: string
  checking?: boolean
  onRetry: () => void
}) {
  return <section className="kb-card" aria-labelledby="session-unavailable-title" data-testid="session-unavailable">
    <h1 id="session-unavailable-title">Не удалось проверить вход</h1>
    <p role="status">{message}</p>
    <p className="kb-muted">Повторный вход пока не требуется. Сохранённые на телефоне данные не удаляются.</p>
    <button className="kb-primary" type="button" disabled={checking} onClick={onRetry}>{checking ? 'Проверяем…' : 'Повторить проверку'}</button>
    <p><a href={appPath('app?offlineMap=1')}>Открыть офлайн-карту</a></p>
  </section>
}
