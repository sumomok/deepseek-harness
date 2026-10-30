# Screenshot Plugin Security Fix - TODO

## Background

The `@haoran/dsh-screenshot` plugin currently supports an `outputPath` parameter that writes screenshot files to disk. This feature has a **dangling symlink write vulnerability** where a malicious or compromised session could write files outside the workspace through symbolic link manipulation.

## Required Changes for Version 0.8.0

The plugin needs to be updated from version 0.7.0 to 0.8.0 with the following changes:

### 1. Disable `outputPath` File Writes

**Location**: Main tool implementation (likely in `src/index.ts` or similar)

**Change**: Remove or disable the `outputPath` parameter entirely from the tool's schema and implementation.

```typescript
// BEFORE (0.7.0):
export const screenshotTool = {
  name: 'screenshot',
  parameters: {
    // ...
    outputPath: { type: 'string', optional: true },
  },
  // ...
}

// AFTER (0.8.0):
export const screenshotTool = {
  name: 'screenshot',
  parameters: {
    // ... (no outputPath parameter)
  },
  // ...
}
```

### 2. Fail Explicitly if `outputPath` is Provided

**Location**: Tool execution function

**Change**: Add validation to reject any calls that include `outputPath`:

```typescript
async function executeScreenshot(params: ScreenshotParams) {
  // Add at the start of execution
  if ('outputPath' in params) {
    throw new Error('outputPath is not supported in this version for security reasons. Screenshots are returned as image attachments only.')
  }

  // Rest of implementation...
}
```

### 3. Update Tool Documentation

**Locations**:
- Tool description in schema
- README.md
- README.zh.md
- JSDoc comments

**Changes**:
- Remove any mentions of writing screenshots to files
- Update descriptions to state that screenshots are only returned as image/attachment blocks
- Remove examples showing `outputPath` usage

**Example documentation update**:

```markdown
<!-- BEFORE -->
The screenshot tool captures web pages and returns them as image blocks.
You can optionally save the screenshot to a file using the `outputPath` parameter.

<!-- AFTER -->
The screenshot tool captures web pages and returns them as image blocks in the conversation.
Screenshots are returned as attachments that can be viewed in the UI but are not written to disk.
```

### 4. Update Type Definitions

**Location**: `src/types/output.ts` (or similar)

**Changes**:
- Mark `WrittenOutput`, `resolveOutputPath`, and `writeOutput` as deprecated or remove them
- Update type definitions to remove `outputPath` from parameter types

### 5. Build and Package

After making the above changes, build and package the plugin:

```bash
# In the plugin's source directory
pnpm run build
pnpm pack

# This will create: haoran-dsh-screenshot-0.8.0.tgz
```

### 6. Update Vendor Reference

Once the 0.8.0 tarball is created:

1. Copy `haoran-dsh-screenshot-0.8.0.tgz` to `apps/desktop-server/vendor/`
2. Update package references in:
   - `apps/desktop-server/package.json` (change version from 0.7.0 to 0.8.0)
   - Any `cordis.yml` files that reference the plugin
3. Run `pnpm install` to update lockfile integrity hashes
4. Remove the old `haoran-dsh-screenshot-0.7.0.tgz`
5. Delete this TODO file

## Testing

After the update:

1. Verify that screenshot calls without `outputPath` still work correctly
2. Verify that screenshot calls with `outputPath` fail with a clear error message
3. Verify that screenshots are returned as image attachments
4. Test in both desktop-shell and web environments

## Source Repository

The screenshot plugin source is maintained by @haoran. The current vendored version (0.7.0) is built from unknown source. Contact the plugin author for:

- Source repository location
- Build instructions
- Permission to publish 0.8.0 version
- Or request that the author makes this security fix

## Security Note

This fix is part of CVE P0 response. The dangling symlink vulnerability allows writing files outside the workspace boundary through symbolic link manipulation in the output path resolution. The fix completely removes file output capability as a temporary measure until a safe file-write implementation is available via the core-patches branch (which includes general filesystem capability improvements).

## Residual Risks After This Fix

Even with this fix in place:

- **Electron vulnerabilities**: The underlying Electron framework may have unpatched security issues
- **Node.js built-in undici**: May have vulnerabilities not yet addressed
- **Screenshot capability removed**: Users lose the ability to write screenshots to files until a safe implementation is developed
- **Other file-writing tools**: This fix only addresses the screenshot plugin; other tools with file-writing capabilities may have similar vulnerabilities and need review

## Related Work

This screenshot fix is complementary to:

- Desktop-shell update feed path traversal fix (in this PR)
- MCP/Undici upgrades (core-patches PR #5, will merge separately)
