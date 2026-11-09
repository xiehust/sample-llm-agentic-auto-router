// After a deploy, an open tab may ask for a lazy chunk the new bundle no longer has (old assets are kept with
// prune: false, so this is rare). Offer a reload instead of a broken page.

import Alert from '@cloudscape-design/components/alert'
import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import { useI18n } from '../i18n/I18n.tsx'

export const isChunkError = (e: unknown): boolean =>
  e instanceof Error && /dynamically imported module|Importing a module script failed|Failed to fetch dynamically/i.test(e.message)

export function ChunkReload() {
  const { t } = useI18n()
  return (
    <Box padding="l">
      <Alert type="info" header={t('ext.reload.title')} action={<Button onClick={() => location.reload()}>{t('ext.reload.button')}</Button>}>{t('ext.reload.body')}</Alert>
    </Box>
  )
}
