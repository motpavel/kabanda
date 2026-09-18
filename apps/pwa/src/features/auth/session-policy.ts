import { ApiError } from '../../lib/http'

/** Only an authenticated 401 proves that a new login is needed. */
export function sessionFailure(error: unknown): 'anonymous' | 'temporary' | 'unavailable' {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'anonymous'
    if (error.status === 429 || error.status >= 500) return 'temporary'
    return 'unavailable'
  }
  return 'temporary'
}

export function sessionFailureMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) return 'Слишком много запросов. Немного подождите и повторите проверку.'
  if (error instanceof ApiError && error.status === 403) return 'Доступ к приложению сейчас недоступен. Повторите проверку или обратитесь к организатору.'
  return 'Не удалось проверить вход. Проверьте подключение и попробуйте ещё раз.'
}

export function signInFailureMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return 'Неверный логин или пароль. Проверьте данные и повторите.'
  if (error instanceof ApiError && error.status === 429) return 'Слишком много попыток входа. Немного подождите и попробуйте снова.'
  if (error instanceof ApiError && error.status === 403) return 'Вход сейчас недоступен. Обратитесь к организатору.'
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return 'Не удалось выполнить вход. Проверьте введённые данные и повторите.'
  return 'Не удалось связаться с сервером. Проверьте подключение и попробуйте ещё раз.'
}
