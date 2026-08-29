import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { assertDatabaseReady } from '../src/database.js'

describe('database readiness', () => {
  it('accepts only the exact expected final migration after the PostGIS probe', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ postgis_version: '3.4 USE_GEOS=1', current_migration: '0007_results_history.sql' }],
    })
    await expect(
      assertDatabaseReady({ query } as unknown as Pool, '0007_results_history.sql'),
    ).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledOnce()

    query.mockResolvedValueOnce({
      rows: [{ postgis_version: '3.4 USE_GEOS=1', current_migration: '0006_checkins_media.sql' }],
    })
    await expect(
      assertDatabaseReady({ query } as unknown as Pool, '0007_results_history.sql'),
    ).rejects.toThrow(
      'Database migration mismatch: expected 0007_results_history.sql, found 0006_checkins_media.sql',
    )
  })
})
