import { describe, expect, it, vi } from 'vitest'
import { consumeInviteFragment, inviteAcceptanceKey } from './invite'

describe('invite fragment handoff', () => {
  it('extracts the raw invite and clears it from the URL before continuation exchange', () => {
    const replaceState = vi.fn()
    const token = consumeInviteFragment(
      { pathname: '/invite', search: '?campaign=friend', hash: '#invite=raw-secret-token' },
      { replaceState },
    )

    expect(token).toBe('raw-secret-token')
    expect(replaceState).toHaveBeenCalledWith(null, '', '/invite?campaign=friend')
    expect(JSON.stringify(replaceState.mock.calls)).not.toContain('raw-secret-token')
  })

  it('does not invent a credential when the fragment has no invite', () => {
    const replaceState = vi.fn()
    expect(
      consumeInviteFragment(
        { pathname: '/invite', search: '', hash: '#utm_source=share' },
        { replaceState },
      ),
    ).toBeNull()
    expect(replaceState).toHaveBeenCalledWith(null, '', '/invite')
  })

  it('derives a stable non-secret acceptance key across reloads', async () => {
    const continuation = 'continuation/with+reserved=chars'
    const first = await inviteAcceptanceKey(continuation)
    expect(await inviteAcceptanceKey(continuation)).toBe(first)
    expect(await inviteAcceptanceKey(`${continuation}-other`)).not.toBe(first)
    expect(first).toMatch(/^invite-[a-f0-9]{64}$/)
    expect(first).not.toContain(continuation)
  })
})
