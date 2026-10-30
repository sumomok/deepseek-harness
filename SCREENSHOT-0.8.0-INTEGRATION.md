# Screenshot Plugin 0.8.0 Integration Steps

## Status: Awaiting Tarball

The screenshot plugin 0.8.0 security fix has landed in `sumomok/dsh-plugins-private` PR #1 with `outputPath` disabled.

**Blocker**: Need access to `haoran-dsh-screenshot-0.8.0.tgz` to complete integration.

## Obtaining the Tarball

### Option 1: From Private Repo (requires access)
```bash
gh repo clone sumomok/dsh-plugins-private
cd dsh-plugins-private
gh pr checkout 1  # or the merged main branch
cd packages/screenshot
pnpm install
pnpm run build
pnpm pack
# This creates haoran-dsh-screenshot-0.8.0.tgz
```

### Option 2: Upload Artifact
If the tarball is available as a build artifact or locally, upload it to this workspace.

## Integration Steps (to execute once tarball is available)

### 1. Copy Tarball to Vendor Directory
```bash
cp haoran-dsh-screenshot-0.8.0.tgz /workspace/apps/desktop-server/vendor/
```

### 2. Update package.json Reference
Edit `apps/desktop-server/package.json`:

**Change**:
```json
"@haoran/dsh-screenshot": "file:./vendor/haoran-dsh-screenshot-0.7.0.tgz",
```

**To**:
```json
"@haoran/dsh-screenshot": "file:./vendor/haoran-dsh-screenshot-0.8.0.tgz",
```

### 3. Update Lockfile
```bash
cd /workspace
pnpm install
```

This will:
- Update `pnpm-lock.yaml` with new integrity hash
- Ensure dependency resolution is correct

### 4. Handle Old Tarball

According to existing vendor conventions (all previous versions are kept), **keep** the old tarball:
- Keep: `haoran-dsh-screenshot-0.7.0.tgz`
- Add: `haoran-dsh-screenshot-0.8.0.tgz`

This matches the pattern seen with other @haoran packages where multiple versions coexist in vendor/.

### 5. Remove TODO Document
```bash
rm /workspace/apps/desktop-server/vendor/SCREENSHOT-PLUGIN-TODO.md
```

The TODO is now obsolete since 0.8.0 has been implemented.

### 6. Verify Changes
```bash
# Check the reference is updated
grep "dsh-screenshot" apps/desktop-server/package.json

# Verify lockfile integrity changed
git diff pnpm-lock.yaml | grep screenshot -A5 -B5

# Verify both tarballs exist
ls -la apps/desktop-server/vendor/haoran-dsh-screenshot-*.tgz
```

### 7. Commit and Push
```bash
git add apps/desktop-server/vendor/haoran-dsh-screenshot-0.8.0.tgz
git add apps/desktop-server/package.json
git add pnpm-lock.yaml
git rm apps/desktop-server/vendor/SCREENSHOT-PLUGIN-TODO.md

git commit -m "vendor: 更新 screenshot plugin 到 0.8.0（禁用 outputPath）

- 添加 haoran-dsh-screenshot-0.8.0.tgz 到 vendor/
- 更新 package.json 依赖引用
- 更新 lockfile integrity
- 保留 0.7.0.tgz（符合 vendor 约定）
- 移除 TODO 文档（0.8.0 已实施）

screenshot plugin 0.8.0 安全修复：
- 禁用 outputPath 文件写入功能
- 带有 outputPath 的调用明确失败
- 只返回 screenshot 作为 image/attachment

来源：sumomok/dsh-plugins-private PR #1"

git push
```

## Verification After Integration

1. **Build test**:
   ```bash
   pnpm run build:artifacts
   ```

2. **Type check**:
   ```bash
   pnpm run typecheck
   ```

3. **Verify plugin loads**:
   ```bash
   # Start desktop-server and check logs for screenshot plugin load
   pnpm dsh --profile headless --help | grep screenshot
   ```

4. **Test outputPath rejection** (if possible):
   - Call screenshot tool with `outputPath` parameter
   - Should fail with clear error message
   - Without `outputPath` should work normally

## Expected Outcome

After integration:
- ✅ Screenshot plugin 0.8.0 vendored
- ✅ Dependency reference updated
- ✅ Lockfile integrity updated
- ✅ Old 0.7.0 tarball kept (vendor convention)
- ✅ TODO document removed
- ✅ All checks pass (build, typecheck, lint)

## Integration with This PR

This integration completes the CVE P0 develop-only security fixes:
1. ✅ Desktop-shell updater path traversal (already implemented)
2. ⏳ Screenshot plugin outputPath disable (awaiting tarball)

Once integrated, the PR will be complete and ready for final review.
