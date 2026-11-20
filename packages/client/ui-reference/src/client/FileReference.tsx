/** File navigation feedback belongs to the individual inline reference that requested it. */
import { useState } from 'react'
import type { UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal, ReferenceChip, UserTextRun } from '@deepseek-ai/dsh-client-ui-primitives'
import type { NS } from './locales.ts'
import type { PathPresence } from './path-presence.ts'
import type {} from './user-text-rules.ts'

/** Host-confirmed presence of mention paths in the rendering Session. */
export interface PathPresenceInjected {
  readonly keyedHooks: {
    /** Presence of one decoded mention path; subscribing starts its Host stat. */
    readonly pathPresence: (path: string) => HostObservable<PathPresence | undefined>
  }
}

/** Session-authorized navigation; document reading belongs to the preview host. */
export interface FileReferenceInjected extends PathPresenceInjected {
  /**
   * Open or reveal a file in the current Sidebar using the originating Session's authority.
   * @param path - decoded path from the reference.
   * @returns nothing for synchronous navigation, or a promise that settles once navigation or its interception settles.
   * @throws if navigation fails; a returned promise rejects instead, and either way the reference keeps a local retry/close dialog.
   */
  readonly openFile: (path: string) => void | Promise<void>
  /** Resolve a reference from the live workspace root. @param path - Reference path. @returns Host path. */
  readonly resolveFilePath: (path: string) => string
}

type FileReferenceProps = UserTextNodeProps<'file'> & InjectFace<FileReferenceInjected> & PropsLocale<typeof NS>

type FolderReferenceProps = UserTextNodeProps<'folder'> & InjectFace<PathPresenceInjected>

/**
 * Render a file chip once the Host confirms its path exists, and contain navigation failures, thrown or rejected, without hiding the reference.
 * @param props - JSON node, interaction policy, Session-authorized navigation and presence, and locale seat.
 * @returns the original spelling until confirmation; afterwards an inline chip and, after a navigation failure, its body-portaled dialog.
 */
export function FileReference({
  node, raw, interactive, openFile, resolveFilePath, sessionId, useContextMenu, usePathPresence, t,
}: FileReferenceProps) {
  const { getTriggerProps } = useContextMenu()
  const [failedPath, setFailedPath] = useState<string | null>(null)
  const { path, label } = node.data
  const presence = usePathPresence(path)
  if (presence !== 'present') return <UserTextRun text={raw} />
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
    <ReferenceChip
      appearance="file"
      label={label}
      title={raw}
      contextMenuProps={getTriggerProps(interactive ? () => ({ kind: 'file', value: { sessionId, path: resolveFilePath(path) } }) : undefined)}
      {...interactive ? { onActivate: open } : {}}
    />
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
 * Render a directory as a label once the Host confirms its path exists, even when the containing text permits file navigation.
 * @param props - directory data, the original reference spelling, and Session-scoped presence.
 * @returns the original spelling until confirmation, then an inline non-interactive chip.
 */
export function FolderReference({ node, raw, usePathPresence }: FolderReferenceProps) {
  return usePathPresence(node.data.path) === 'present'
    ? <ReferenceChip appearance="folder" label={node.data.label} title={raw} />
    : <UserTextRun text={raw} />
}
