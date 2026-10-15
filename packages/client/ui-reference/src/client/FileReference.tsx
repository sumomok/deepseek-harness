/** File navigation feedback belongs to the individual inline reference that requested it. */
import { useState } from 'react'
import type { UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal, ReferenceChip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { NS } from './locales.ts'
import type {} from './user-text-rules.ts'

/** Session-authorized navigation; document reading belongs to the preview host. */
export interface FileReferenceInjected {
  /**
   * Open or reveal a file in the current Sidebar using the originating Session's authority.
   * @param path - decoded path from the reference.
   * @returns nothing for synchronous navigation, or a promise that settles once navigation or its interception settles.
   * @throws if navigation fails; a returned promise rejects instead, and either way the reference keeps a local retry/close dialog.
   */
  readonly openFile: (path: string) => void | Promise<void>
}

type FileReferenceProps = UserTextNodeProps<'file'> & InjectFace<FileReferenceInjected> & PropsLocale<typeof NS>

/**
 * Render a file chip and contain navigation failures, thrown or rejected, without hiding the reference.
 * @param props - JSON node, interaction policy, Session-authorized navigation, and locale seat.
 * @returns an inline chip and, after a navigation failure, its body-portaled dialog.
 */
export function FileReference({ node, raw, interactive, openFile, t }: FileReferenceProps) {
  const [failedPath, setFailedPath] = useState<string | null>(null)
  const { path, label } = node.data
  const close = () => { setFailedPath(null) }
  const open = () => {
    let opened: void | Promise<void>
    try {
      opened = openFile(path)
    } catch {
      setFailedPath(path)
      return
    }
    setFailedPath(null)
    if (opened instanceof Promise) void opened.catch(() => { setFailedPath(path) })
  }
  return <>
    <ReferenceChip appearance="file" label={label} title={raw} {...interactive ? { onActivate: open } : {}} />
    {interactive && failedPath === path && <Modal
      open
      onClose={close}
      closeLabel={t('fileOpen.close')}
      title={t('fileOpen.title')}
      description={t('fileOpen.failed', { path })}
      footer={<>
        <Button variant="outline" onClick={close}>{t('fileOpen.close')}</Button>
        <Button variant="primary" onClick={open}>{t('fileOpen.retry')}</Button>
      </>}
    />}
  </>
}

/**
 * Render a directory as a label, even when the containing text permits file navigation.
 * @param props - resolved directory data and the original reference spelling.
 * @returns an inline non-interactive chip.
 */
export function FolderReference({ node, raw }: UserTextNodeProps<'folder'>) {
  return <ReferenceChip appearance="folder" label={node.data.label} title={raw} />
}
