// @vitest-environment jsdom
// The assembled shell published under a deployment prefix rather than on the
// origin root, which is how the server line is deployed behind nginx.
//
// Every other file in this lane mounts on `/`, where a root-absolute URL and a
// prefix-relative one resolve to the same address — so nothing there can tell
// the two apart, and a shell that hardcodes the origin root passes. This file
// is the one that can: it puts the document on `/console/` with the `<base
// href>` and `__DSH_BASE__` the Host injects, then holds the boot manifest to
// the rule that makes the deployment work at all — a URL the browser resolves
// outside the prefix is a request nginx never routes to this process.
import { screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import {
  bootRequestUrls,
  installAssembledBootEnv,
  installDeploymentBase,
  mountAssembledApp,
} from './assembled-boot.ts'

installAssembledBootEnv()

/** The deployment prefix the server line publishes the shell under. */
const PREFIX = '/console/'

it('resolves every boot URL under the deployment prefix', () => {
  installDeploymentBase(PREFIX, '?fixture')

  // The harness reproduces what dsh-server-base injects: the page address, the
  // `<base href>` row, and the global the client half reads before the document
  // has a base URI to fall back on.
  expect(location.pathname).toBe(PREFIX)
  expect(document.baseURI).toBe(`${location.origin}${PREFIX}`)
  expect((globalThis as { __DSH_BASE__?: string }).__DSH_BASE__).toBe(PREFIX)

  // The manifest rows and the parser-blocking preloads the Host injects as
  // `<script src>` both resolve through the document base, so a root-absolute
  // url in the manifest lands on `/plugins/…` — off the prefix, and a 404 from
  // the deployment's nginx.
  const outside = bootRequestUrls()
    .filter(url => !new URL(url, document.baseURI).pathname.startsWith(PREFIX))
  expect(outside).toEqual([])
})

it('boots the assembled shell under the deployment prefix', async () => {
  mountAssembledApp('?fixture', PREFIX)

  // The same landing surface the origin-root smoke asserts: the whole graph
  // activated and the sidebar rendered, with the page on the prefix throughout.
  await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  expect(location.pathname).toBe(PREFIX)
})
