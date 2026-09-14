module.exports = async function beforeBuild(context) {
  const { rebuild } = await import('@electron/rebuild');
  // Node tests overwrite native binaries without invalidating Electron's rebuild marker.
  // Force the ABI rebuild so a successful package cannot contain the Node test binary.
  await rebuild({
    buildPath: context.appDir,
    electronVersion: context.electronVersion || require('electron/package.json').version,
    arch: context.arch,
    platform: context.platform.nodeName,
    force: true,
    useCache: false,
    onlyModules: ['better-sqlite3', 'bcrypt', 'tiny-secp256k1', 'secp256k1', 'bufferutil', 'utf-8-validate'],
  });
  // Keep dependency collection enabled; false also omits runtime modules in builder 26.
  return true;
};
